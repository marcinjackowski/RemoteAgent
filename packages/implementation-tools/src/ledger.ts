/**
 * Durable, cross-process operation intent ledger for the model-facing toolset.
 *
 * The invariant this module exists to provide is: a side effect is preceded by a
 * COMMITTED intent, and one `operation_id` performs its effect exactly once — for
 * every process, not merely every event loop.
 *
 * Why not the existing file ledger. `@remoteagent/workspace-runner`'s
 * `OperationLedger` appends `operations.jsonl` and serializes writers through a
 * module-level `Map`. Two processes have two `Map`s, so both read "unseen", both
 * act, and the effect happens twice; and because it records only AFTER the effect,
 * a crash in between leaves no evidence at all. Neither problem is fixable in
 * process-local state, so this ledger is PostgreSQL — the authoritative store
 * (Master Plan §3.2) — and is deliberately independent of the runner.
 *
 * How exactly-once is achieved. `operation_id` is the PRIMARY KEY of
 * `implementation_tool_operations`, and the claim is a single-winner
 * `INSERT ... ON CONFLICT DO NOTHING`. PostgreSQL's unique index arbitrates: of N
 * concurrent claimers exactly one gets `rowCount === 1` and is allowed to act;
 * every other one gets 0, reads the existing row, and MUST NOT repeat the effect.
 *
 * This is deliberately lock-free. An advisory lock would work but
 * `Database.withAdvisoryLock` checks out its OWN pooled connection for the whole
 * callback, so wrapping a transaction inside it costs two connections per
 * operation and deadlocks the default 10-connection pool past ~5 concurrent
 * operations. `pg_advisory_xact_lock` inside a single transaction would fix the
 * connection count but still serializes unrelated operations. A unique index gives
 * the same atomicity with no lock at all and one connection per statement, so
 * concurrency is bounded by the pool rather than by the ledger.
 *
 * No receipt means AMBIGUOUS. `settle` writes a terminal receipt fenced on
 * `status = 'INTENT_RECORDED'`, so a receipt cannot be overwritten and a late
 * loser cannot re-settle a resolved operation. If the process dies before the
 * receipt, the committed claim is still there in `INTENT_RECORDED`; a later pass
 * (in any process, over any `Database` instance) resolves it to a durable
 * `AMBIGUOUS` with a reason, never to `SUCCEEDED`. The database CHECK constraints
 * make the unsafe shapes unrepresentable regardless of what this code does.
 *
 * This module performs no side effect itself: no filesystem, no `child_process`,
 * no network. `run` receives the effect as a callback and only decides — from
 * durable state — whether it may be invoked.
 */
import type { Queryable, Transaction } from "@remoteagent/database";
import * as z from "zod";

import {
  AmbiguityReason,
  MAX_CHANGED_FILES,
  ToolKind,
  ToolOutcome,
  workspaceRelativePath,
} from "./contracts.js";
import type { ToolIdentity } from "./contracts.js";

/** Ledger state of one operation. `INTENT_RECORDED` is the pre-effect claim. */
export const OperationStatus = {
  /** Durably claimed, effect not yet reported. A crash leaves the row here. */
  INTENT_RECORDED: "INTENT_RECORDED",
  SUCCEEDED: ToolOutcome.SUCCEEDED,
  FAILED: ToolOutcome.FAILED,
  AMBIGUOUS: ToolOutcome.AMBIGUOUS,
} as const;

export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus];

/** What a claim attempt was allowed to do. */
export const ClaimDisposition = {
  /** This caller won the race and is the ONLY one that may perform the effect. */
  CLAIMED: "CLAIMED",
  /** Another caller already claimed this id; the effect must not be repeated. */
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
} as const;

export type ClaimDisposition = (typeof ClaimDisposition)[keyof typeof ClaimDisposition];

/** Raised when a request cannot be honoured deterministically. */
export class OperationLedgerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperationLedgerError";
  }
}

/**
 * Raised when an `operation_id` is addressed from a scope that does not own it.
 * This is an explicit rejection, never a silent share: `operation_id` is globally
 * unique, so a foreign scope reusing an id would otherwise appear to be a fresh
 * operation and would execute the effect a second time.
 */
export class OperationScopeError extends OperationLedgerError {
  public constructor(operationId: string) {
    super(`operation ${operationId} belongs to a different case/workspace scope`);
    this.name = "OperationScopeError";
  }
}

const identitySchema = z.strictObject({
  case_id: z.string().trim().min(1).max(512),
  workspace_id: z.string().trim().min(1).max(512),
});

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const claimSchema = z.strictObject({
  operationId: z.string().trim().min(1).max(512),
  identity: identitySchema,
  kind: z.enum([
    ToolKind.READ_FILE,
    ToolKind.LIST_FILES,
    ToolKind.SEARCH_TEXT,
    ToolKind.WRITE_FILE,
    ToolKind.APPLY_PATCH,
    ToolKind.RUN_COMMAND,
  ]),
  beforeDigest: digest.nullable(),
  changedFiles: z.array(workspaceRelativePath).max(MAX_CHANGED_FILES),
});

/**
 * A terminal receipt. The variants mirror `implementationToolResult`'s closed
 * outcome set.
 */
export type OperationReceipt =
  | {
      readonly outcome: typeof ToolOutcome.SUCCEEDED;
      /** Non-nullable: an unverifiable post-state is AMBIGUOUS, not a success. */
      readonly afterDigest: string;
      readonly changedFiles: readonly string[];
    }
  | {
      readonly outcome: typeof ToolOutcome.FAILED;
      readonly failureCode: string;
    }
  | {
      readonly outcome: typeof ToolOutcome.AMBIGUOUS;
      readonly ambiguityReason: AmbiguityReason;
      readonly afterDigest?: string | null;
      readonly changedFiles?: readonly string[];
    };

const receiptSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal(ToolOutcome.SUCCEEDED),
    afterDigest: digest,
    changedFiles: z.array(workspaceRelativePath).max(MAX_CHANGED_FILES),
  }),
  z.strictObject({
    outcome: z.literal(ToolOutcome.FAILED),
    failureCode: z.string().trim().min(1).max(512),
  }),
  z.strictObject({
    outcome: z.literal(ToolOutcome.AMBIGUOUS),
    ambiguityReason: z.enum([
      AmbiguityReason.PARTIAL_WRITE,
      AmbiguityReason.INTERRUPTED,
      AmbiguityReason.UNVERIFIED_POST_STATE,
    ]),
    afterDigest: digest.nullable().optional(),
    changedFiles: z.array(workspaceRelativePath).max(MAX_CHANGED_FILES).optional(),
  }),
]);

/** A ledger row as read back. `requiresReconciliation` is derived, not stored. */
export interface OperationRecord {
  readonly operationId: string;
  readonly identity: ToolIdentity;
  readonly kind: ToolKind;
  readonly status: OperationStatus;
  readonly beforeDigest: string | null;
  readonly afterDigest: string | null;
  readonly changedFiles: readonly string[];
  readonly failureCode: string | null;
  readonly ambiguityReason: AmbiguityReason | null;
  /**
   * True while the operation's effect is not established: an unsettled claim
   * (crashed attempt) or a durable AMBIGUOUS. Mirrors the `requires_reconciliation`
   * literal on `ambiguousImplementationToolResult`.
   */
  readonly requiresReconciliation: boolean;
}

interface OperationRow {
  operation_id: string;
  case_id: string;
  workspace_id: string;
  kind: string;
  status: string;
  before_digest: string | null;
  after_digest: string | null;
  changed_files: unknown;
  failure_code: string | null;
  ambiguity_reason: string | null;
}

const COLUMNS =
  "operation_id, case_id, workspace_id, kind, status, before_digest, after_digest, " +
  "changed_files, failure_code, ambiguity_reason";

const rowSchema = z.strictObject({
  operation_id: z.string(),
  case_id: z.string(),
  workspace_id: z.string(),
  kind: z.enum([
    ToolKind.READ_FILE,
    ToolKind.LIST_FILES,
    ToolKind.SEARCH_TEXT,
    ToolKind.WRITE_FILE,
    ToolKind.APPLY_PATCH,
    ToolKind.RUN_COMMAND,
  ]),
  status: z.enum([
    OperationStatus.INTENT_RECORDED,
    OperationStatus.SUCCEEDED,
    OperationStatus.FAILED,
    OperationStatus.AMBIGUOUS,
  ]),
  before_digest: z.string().nullable(),
  after_digest: z.string().nullable(),
  changed_files: z.array(z.string()),
  failure_code: z.string().nullable(),
  ambiguity_reason: z
    .enum([
      AmbiguityReason.PARTIAL_WRITE,
      AmbiguityReason.INTERRUPTED,
      AmbiguityReason.UNVERIFIED_POST_STATE,
    ])
    .nullable(),
});

/**
 * Map a row to a record. The row is parsed rather than cast: the ledger is read
 * back by later passes and by other processes, so its shape is validated at the
 * boundary instead of being asserted by a TypeScript type.
 */
function toRecord(row: OperationRow): OperationRecord {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    throw new OperationLedgerError(`ledger row for ${row.operation_id} is malformed`);
  }
  const value = parsed.data;
  return {
    operationId: value.operation_id,
    identity: { case_id: value.case_id, workspace_id: value.workspace_id },
    kind: value.kind,
    status: value.status,
    beforeDigest: value.before_digest,
    afterDigest: value.after_digest,
    changedFiles: value.changed_files,
    failureCode: value.failure_code,
    ambiguityReason: value.ambiguity_reason,
    requiresReconciliation:
      value.status === OperationStatus.INTENT_RECORDED ||
      value.status === OperationStatus.AMBIGUOUS,
  };
}

export interface ClaimInput {
  readonly operationId: string;
  readonly identity: ToolIdentity;
  readonly kind: ToolKind;
  readonly beforeDigest: string | null;
  readonly changedFiles: readonly string[];
}

export interface ClaimOutcome {
  readonly disposition: ClaimDisposition;
  readonly record: OperationRecord;
}

/**
 * Persistent operation ledger.
 *
 * Stateless by construction: it holds no in-memory index, no cached decision and
 * no lock table. Every question is answered by a query, which is what makes a
 * second instance over the same database — a restarted or a peer process —
 * observe exactly the same state.
 */
export class OperationLedgerRepository {
  /**
   * Durably record the intent to perform `operationId`, BEFORE its side effect.
   *
   * Single-winner: the `ON CONFLICT DO NOTHING` insert returns a row only for the
   * caller whose insert actually landed. `CLAIMED` is therefore permission to act
   * and is granted to exactly one caller across all processes; `ALREADY_CLAIMED`
   * carries the existing record so the loser can report the original outcome
   * instead of re-performing the effect.
   *
   * Reusing an id from another scope is rejected with {@link OperationScopeError}
   * rather than treated as a fresh operation.
   */
  public async claim(q: Queryable, input: ClaimInput): Promise<ClaimOutcome> {
    const parsed = claimSchema.safeParse(input);
    if (!parsed.success) {
      throw new OperationLedgerError(`invalid operation claim: ${parsed.error.message}`);
    }
    const claim = parsed.data;
    const inserted = await q.query<OperationRow>(
      `INSERT INTO implementation_tool_operations
         (operation_id, case_id, workspace_id, kind, status, before_digest, changed_files)
       VALUES ($1, $2, $3, $4, '${OperationStatus.INTENT_RECORDED}', $5, $6::jsonb)
       ON CONFLICT (operation_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        claim.operationId,
        claim.identity.case_id,
        claim.identity.workspace_id,
        claim.kind,
        claim.beforeDigest,
        JSON.stringify(claim.changedFiles),
      ],
    );
    const won = inserted.rows[0];
    if (won !== undefined) {
      return { disposition: ClaimDisposition.CLAIMED, record: toRecord(won) };
    }
    // Lost the race (or this is a replay). The row exists; report it as-is.
    const existing = await this.find(q, claim.operationId, claim.identity);
    if (existing === null) {
      // The winner's row is not visible from this snapshot, which for a committed
      // claim can only mean it was rolled back or removed concurrently. Fail
      // closed rather than granting a second claim on the same id.
      throw new OperationLedgerError(
        `operation ${claim.operationId} was claimed concurrently but is not readable`,
      );
    }
    return { disposition: ClaimDisposition.ALREADY_CLAIMED, record: existing };
  }

  /**
   * Read one operation within its own scope.
   *
   * The `case_id`/`workspace_id` predicate is a fence, not an optimization: a
   * foreign scope gets `null` for a row it does not own, so it cannot observe
   * another case's operation. Addressing an id that exists under a DIFFERENT scope
   * raises {@link OperationScopeError} — an explicit rejection rather than a quiet
   * `null` that a caller might read as "unused, safe to execute".
   */
  public async find(
    q: Queryable,
    operationId: string,
    identity: ToolIdentity,
  ): Promise<OperationRecord | null> {
    const scope = identitySchema.safeParse(identity);
    if (!scope.success) {
      throw new OperationLedgerError(`invalid operation scope: ${scope.error.message}`);
    }
    const result = await q.query<OperationRow>(
      `SELECT ${COLUMNS} FROM implementation_tool_operations
       WHERE operation_id = $1 AND case_id = $2 AND workspace_id = $3`,
      [operationId, scope.data.case_id, scope.data.workspace_id],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return toRecord(row);
    }
    const foreign = await q.query<{ operation_id: string }>(
      "SELECT operation_id FROM implementation_tool_operations WHERE operation_id = $1",
      [operationId],
    );
    if (foreign.rows.length > 0) {
      throw new OperationScopeError(operationId);
    }
    return null;
  }

  /**
   * Read an operation without a scope fence. For reconciliation tooling that is
   * given a case scope by the caller; `find` remains the model-facing path.
   */
  public async findUnscoped(q: Queryable, operationId: string): Promise<OperationRecord | null> {
    const result = await q.query<OperationRow>(
      `SELECT ${COLUMNS} FROM implementation_tool_operations WHERE operation_id = $1`,
      [operationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Write the terminal receipt for a claimed operation.
   *
   * Fenced on `status = 'INTENT_RECORDED'`: a terminal receipt is written at most
   * once, so a late or duplicate settle cannot overwrite a recorded outcome and a
   * resolved `AMBIGUOUS` can never be quietly upgraded to `SUCCEEDED`. Returns
   * false when the fence rejected the write; the caller then reads the row to see
   * the outcome that stands.
   */
  public async settle(
    q: Queryable,
    operationId: string,
    identity: ToolIdentity,
    receipt: OperationReceipt,
  ): Promise<boolean> {
    const scope = identitySchema.safeParse(identity);
    if (!scope.success) {
      throw new OperationLedgerError(`invalid operation scope: ${scope.error.message}`);
    }
    const parsed = receiptSchema.safeParse(receipt);
    if (!parsed.success) {
      throw new OperationLedgerError(`invalid operation receipt: ${parsed.error.message}`);
    }
    const value = parsed.data;
    const afterDigest = value.outcome === ToolOutcome.FAILED ? null : (value.afterDigest ?? null);
    const changedFiles = value.outcome === ToolOutcome.FAILED ? [] : (value.changedFiles ?? []);
    const failureCode = value.outcome === ToolOutcome.FAILED ? value.failureCode : null;
    const ambiguityReason = value.outcome === ToolOutcome.AMBIGUOUS ? value.ambiguityReason : null;
    const result = await q.query(
      `UPDATE implementation_tool_operations
          SET status = $4, after_digest = $5, changed_files = $6::jsonb,
              failure_code = $7, ambiguity_reason = $8, settled_at = now()
        WHERE operation_id = $1 AND case_id = $2 AND workspace_id = $3
          AND status = '${OperationStatus.INTENT_RECORDED}'`,
      [
        operationId,
        scope.data.case_id,
        scope.data.workspace_id,
        value.outcome,
        afterDigest,
        JSON.stringify(changedFiles),
        failureCode,
        ambiguityReason,
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * Resolve a claim whose attempt never reported a receipt to a durable
   * `AMBIGUOUS`.
   *
   * This is the recovery path: an `INTENT_RECORDED` row means an attempt started
   * and its outcome is UNKNOWN, so it is settled to the conservative terminal
   * state with a reason. It is fenced the same way as {@link settle}, so it cannot
   * touch an operation that already has a receipt — recovery never rewrites a
   * successful operation.
   */
  public async markAbandonedAmbiguous(
    q: Queryable,
    operationId: string,
    identity: ToolIdentity,
    reason: AmbiguityReason = AmbiguityReason.INTERRUPTED,
  ): Promise<boolean> {
    return this.settle(q, operationId, identity, {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: reason,
    });
  }

  /**
   * Every operation in a scope whose effect is not established: unsettled claims
   * plus durable `AMBIGUOUS` rows. This is the reconciliation work list.
   */
  public async listRequiringReconciliation(
    q: Queryable,
    identity: ToolIdentity,
  ): Promise<OperationRecord[]> {
    const scope = identitySchema.safeParse(identity);
    if (!scope.success) {
      throw new OperationLedgerError(`invalid operation scope: ${scope.error.message}`);
    }
    const result = await q.query<OperationRow>(
      `SELECT ${COLUMNS} FROM implementation_tool_operations
       WHERE case_id = $1 AND workspace_id = $2
         AND status IN ('${OperationStatus.INTENT_RECORDED}', '${OperationStatus.AMBIGUOUS}')
       ORDER BY claimed_at ASC, operation_id ASC`,
      [scope.data.case_id, scope.data.workspace_id],
    );
    return result.rows.map((row) => toRecord(row));
  }
}

export interface GuardedRunOutcome {
  /** Whether THIS caller actually performed the effect. */
  readonly executed: boolean;
  readonly record: OperationRecord;
}

/**
 * Run `effect` at most once for `operationId`, ever, in any process.
 *
 * Ordering is the whole point:
 *
 *   1. claim, and COMMIT the claim. The intent is durable before anything happens,
 *      so a crash is always visible as an `INTENT_RECORDED` row;
 *   2. only the single winner invokes `effect`. Losers return the existing record
 *      with `executed: false` and never touch the side effect;
 *   3. settle with the receipt the effect returned. If `effect` throws, the
 *      operation is settled `AMBIGUOUS` rather than left dangling — a thrown error
 *      does not prove nothing was written;
 *   4. if the process dies between 2 and 3 there is no receipt, so the row stays
 *      `INTENT_RECORDED` and any later pass resolves it to `AMBIGUOUS` through
 *      {@link OperationLedgerRepository.markAbandonedAmbiguous}. There is no path
 *      from "no receipt" to `SUCCEEDED`.
 *
 * The claim is committed in its own transaction and the effect runs OUTSIDE any
 * transaction: holding a pooled connection open across an arbitrarily long side
 * effect would starve the pool, and a rollback cannot un-write a file anyway, so a
 * transaction spanning the effect would be a false guarantee.
 *
 * `runTransaction` is injected rather than taking a `Database` so this module
 * stays free of connection ownership; pass `(fn) => db.withTransaction(fn)`.
 */
export async function runExactlyOnce(
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>,
  ledger: OperationLedgerRepository,
  input: ClaimInput,
  effect: () => Promise<OperationReceipt>,
): Promise<GuardedRunOutcome> {
  const claimed = await runTransaction(async (tx) => ledger.claim(tx, input));
  if (claimed.disposition === ClaimDisposition.ALREADY_CLAIMED) {
    return { executed: false, record: claimed.record };
  }

  let receipt: OperationReceipt;
  try {
    receipt = await effect();
  } catch {
    // The effect failed in an unknown state: it may have written part of its
    // output. Fail closed to AMBIGUOUS so reconciliation, not a retry, decides.
    receipt = {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: AmbiguityReason.PARTIAL_WRITE,
    };
  }

  await runTransaction(async (tx) => ledger.settle(tx, input.operationId, input.identity, receipt));
  const settled = await runTransaction(async (tx) =>
    ledger.find(tx, input.operationId, input.identity),
  );
  if (settled === null) {
    throw new OperationLedgerError(
      `operation ${input.operationId} disappeared from the ledger after settling`,
    );
  }
  return { executed: true, record: settled };
}
