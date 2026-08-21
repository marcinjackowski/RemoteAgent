/**
 * The durable tool-call ledger (AC6), and the artifact binding for oversized or
 * malformed output (AC4).
 *
 * The invariant: a brokered call is preceded by a COMMITTED `DISPATCHED` row, and
 * the row's terminal state is written at most once. That ordering is what makes
 * AC5 provable rather than asserted — if the process dies after the request goes
 * out, the committed row is still there in `DISPATCHED`, and a later pass (in any
 * process) resolves it to `AMBIGUOUS` with a reason. It can never resolve to
 * `SUCCEEDED`, because migration 028's CHECK constraints make that unrepresentable
 * without a `result_digest`.
 *
 * Why record before dispatch rather than after. Recording after is the natural
 * design and it loses exactly the case that matters: a crash between the request
 * and the write leaves no evidence at all, so a retry cannot tell "never sent"
 * from "sent, outcome unknown". For a read that distinction is merely wasteful; the
 * same code path in RA-022 will carry writes, where it is the difference between
 * one action and two. Establishing it here, where the blast radius is a duplicate
 * read, is deliberate.
 *
 * `settle` is fenced on `status = 'DISPATCHED'` in SQL, so a late or duplicate
 * settle cannot overwrite a recorded outcome and a resolved `AMBIGUOUS` cannot be
 * quietly upgraded. The repository holds no in-memory state: every question is a
 * query, which is what makes a second instance over the same database — a
 * restarted or peer process — observe identical state.
 */
import {
  canonicalJsonStringify,
  type AgentRole,
  type Provider,
  type RiskTier,
} from "@remoteagent/contracts";
import type { Queryable } from "@remoteagent/database";
import { createHash } from "node:crypto";
import * as z from "zod";

import {
  McpAmbiguityReason,
  RefusalCode,
  ToolBrokerError,
  ToolCallOutcome,
  mcpAmbiguityReasonSchema,
  refusalCodeSchema,
} from "./contracts.js";

/** Lifecycle of a ledger row. `DISPATCHED` is the pre-request commitment. */
export const ToolCallStatus = {
  /** Durably recorded, request not yet reported. A crash leaves the row here. */
  DISPATCHED: "DISPATCHED",
  SUCCEEDED: ToolCallOutcome.SUCCEEDED,
  FAILED: ToolCallOutcome.FAILED,
  AMBIGUOUS: ToolCallOutcome.AMBIGUOUS,
  /** Refused before dispatch. Nothing reached the network. */
  REFUSED: "REFUSED",
} as const;

export type ToolCallStatus = (typeof ToolCallStatus)[keyof typeof ToolCallStatus];

export class ToolCallLedgerError extends ToolBrokerError {
  public constructor(message: string) {
    super(message);
    this.name = "ToolCallLedgerError";
  }
}

/**
 * Raised when a `call_id` is addressed from a scope that does not own it.
 *
 * An explicit rejection rather than a silent `null`: `call_id` is globally unique,
 * so a foreign scope reusing one would otherwise look like a fresh call and would
 * be dispatched a second time.
 */
export class ToolCallScopeError extends ToolCallLedgerError {
  public constructor(callId: string) {
    super(`tool call ${callId} belongs to a different case/owner scope`);
    this.name = "ToolCallScopeError";
  }
}

/** Authoritative scope of a ledger row. Server-supplied, never model-supplied. */
export type ToolCallScope = Readonly<{ caseId: string; ownerId: string }>;

const scopeSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(512),
  ownerId: z.string().trim().min(1).max(512),
});

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** sha256 over the canonical encoding of a value. Stable across key ordering. */
export function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex")}`;
}

const dispatchSchema = z.strictObject({
  callId: z.string().trim().min(1).max(512),
  intentId: z.string().trim().min(1).max(512),
  scope: scopeSchema,
  role: z.enum(["SUPERVISOR", "PLANNER", "IMPLEMENTER", "REVIEWER", "VERIFICATION", "SPECIALIST"]),
  toolName: z.string().trim().min(1).max(512),
  toolVersion: z.int().positive(),
  provider: z.enum(["jira", "gmail", "calendar", "gitlab", "discord"]),
  riskTier: z.enum(["R0", "R1", "R2", "R3", "R4"]),
  validatedArgumentsDigest: digestSchema,
  correlationId: z.string().trim().min(1).max(512),
  traceId: z.string().trim().min(1).max(512),
});

export type DispatchInput = Readonly<{
  callId: string;
  intentId: string;
  scope: ToolCallScope;
  role: AgentRole;
  toolName: string;
  toolVersion: number;
  provider: Provider;
  riskTier: RiskTier;
  /** Digest of the arguments the broker will forward, not of the proposal. */
  validatedArgumentsDigest: string;
  correlationId: string;
  traceId: string;
}>;

/**
 * A terminal receipt. A closed union, so the unsafe combinations are not merely
 * rejected at runtime — they cannot be written down.
 */
export type ToolCallReceipt =
  | {
      readonly outcome: typeof ToolCallOutcome.SUCCEEDED;
      /** Non-nullable: an unverifiable result is AMBIGUOUS, not a success. */
      readonly resultDigest: string;
      readonly latencyMs: number;
      readonly artifactId?: string | null;
    }
  | {
      readonly outcome: typeof ToolCallOutcome.FAILED;
      readonly latencyMs: number;
      readonly artifactId?: string | null;
    }
  | {
      readonly outcome: typeof ToolCallOutcome.AMBIGUOUS;
      readonly ambiguityReason: McpAmbiguityReason;
      readonly latencyMs: number;
      readonly artifactId?: string | null;
    };

const receiptSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal(ToolCallOutcome.SUCCEEDED),
    resultDigest: digestSchema,
    latencyMs: z.int().nonnegative(),
    artifactId: z.string().trim().min(1).max(512).nullable().optional(),
  }),
  z.strictObject({
    outcome: z.literal(ToolCallOutcome.FAILED),
    latencyMs: z.int().nonnegative(),
    artifactId: z.string().trim().min(1).max(512).nullable().optional(),
  }),
  z.strictObject({
    outcome: z.literal(ToolCallOutcome.AMBIGUOUS),
    ambiguityReason: mcpAmbiguityReasonSchema,
    latencyMs: z.int().nonnegative(),
    artifactId: z.string().trim().min(1).max(512).nullable().optional(),
  }),
]);

/** A refusal, recorded without ever having been dispatched. */
export type RefusalRecord = Readonly<{
  callId: string;
  intentId: string;
  scope: ToolCallScope;
  role: AgentRole;
  toolName: string;
  toolVersion: number;
  provider: Provider;
  riskTier: RiskTier;
  refusalCode: RefusalCode;
  validatedArgumentsDigest: string;
  correlationId: string;
  traceId: string;
}>;

const refusalSchema = dispatchSchema.extend({ refusalCode: refusalCodeSchema });

/** A ledger row as read back. `requiresReconciliation` is derived, not stored. */
export interface ToolCallRecord {
  readonly callId: string;
  readonly intentId: string;
  readonly scope: ToolCallScope;
  readonly role: AgentRole;
  readonly toolName: string;
  readonly toolVersion: number;
  readonly provider: Provider;
  readonly riskTier: RiskTier;
  readonly status: ToolCallStatus;
  readonly refusalCode: RefusalCode | null;
  readonly ambiguityReason: McpAmbiguityReason | null;
  readonly validatedArgumentsDigest: string;
  readonly resultDigest: string | null;
  readonly artifactId: string | null;
  readonly latencyMs: number;
  readonly correlationId: string;
  readonly traceId: string;
  /**
   * True while the call's effect is not established: an unsettled dispatch (a
   * crashed attempt) or a durable `AMBIGUOUS`. This is the queue a reconciliation
   * pass consumes; it is derived so it cannot drift from `status`.
   */
  readonly requiresReconciliation: boolean;
}

const COLUMNS =
  "call_id, intent_id, case_id, owner_id, role, tool_name, tool_version, provider, " +
  "risk_tier, status, refusal_code, ambiguity_reason, validated_arguments_digest, " +
  "result_digest, artifact_id, latency_ms, correlation_id, trace_id";

interface ToolCallRow {
  call_id: string;
  intent_id: string;
  case_id: string;
  owner_id: string;
  role: string;
  tool_name: string;
  tool_version: number | string;
  provider: string;
  risk_tier: string;
  status: string;
  refusal_code: string | null;
  ambiguity_reason: string | null;
  validated_arguments_digest: string;
  result_digest: string | null;
  artifact_id: string | null;
  latency_ms: number | string;
  correlation_id: string;
  trace_id: string;
}

const rowSchema = z.strictObject({
  call_id: z.string(),
  intent_id: z.string(),
  case_id: z.string(),
  owner_id: z.string(),
  role: z.enum(["SUPERVISOR", "PLANNER", "IMPLEMENTER", "REVIEWER", "VERIFICATION", "SPECIALIST"]),
  tool_name: z.string(),
  tool_version: z.coerce.number().int().positive(),
  provider: z.enum(["jira", "gmail", "calendar", "gitlab", "discord"]),
  risk_tier: z.enum(["R0", "R1", "R2", "R3", "R4"]),
  status: z.enum([
    ToolCallStatus.DISPATCHED,
    ToolCallStatus.SUCCEEDED,
    ToolCallStatus.FAILED,
    ToolCallStatus.AMBIGUOUS,
    ToolCallStatus.REFUSED,
  ]),
  refusal_code: refusalCodeSchema.nullable(),
  ambiguity_reason: mcpAmbiguityReasonSchema.nullable(),
  validated_arguments_digest: z.string(),
  result_digest: z.string().nullable(),
  artifact_id: z.string().nullable(),
  latency_ms: z.coerce.number().int().nonnegative(),
  correlation_id: z.string(),
  trace_id: z.string(),
});

/**
 * Map a row to a record, parsing rather than casting.
 *
 * The ledger is read back by later passes and by other processes, so its shape is
 * validated at the boundary instead of being asserted by a TypeScript type that
 * the database never saw.
 */
function toRecord(row: ToolCallRow): ToolCallRecord {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    throw new ToolCallLedgerError(`ledger row for ${row.call_id} is malformed`);
  }
  const value = parsed.data;
  return {
    callId: value.call_id,
    intentId: value.intent_id,
    scope: { caseId: value.case_id, ownerId: value.owner_id },
    role: value.role,
    toolName: value.tool_name,
    toolVersion: value.tool_version,
    provider: value.provider,
    riskTier: value.risk_tier,
    status: value.status,
    refusalCode: value.refusal_code,
    ambiguityReason: value.ambiguity_reason,
    validatedArgumentsDigest: value.validated_arguments_digest,
    resultDigest: value.result_digest,
    artifactId: value.artifact_id,
    latencyMs: value.latency_ms,
    correlationId: value.correlation_id,
    traceId: value.trace_id,
    requiresReconciliation:
      value.status === ToolCallStatus.DISPATCHED || value.status === ToolCallStatus.AMBIGUOUS,
  };
}

/**
 * Durable ledger of brokered tool calls.
 *
 * Stateless by construction: no in-memory index, no cached decision, no lock
 * table. Two processes over one database see the same thing.
 */
export class ToolCallLedgerRepository {
  /**
   * Record the intent to dispatch `callId`, BEFORE the request is sent.
   *
   * Single-winner via the primary key: `ON CONFLICT DO NOTHING` returns a row only
   * to the caller whose insert landed. A caller that does not win must NOT dispatch
   * — the call is already accounted for, and dispatching anyway is how one intent
   * becomes two provider requests.
   */
  public async recordDispatch(q: Queryable, input: DispatchInput): Promise<ToolCallRecord> {
    const parsed = dispatchSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolCallLedgerError(`invalid tool call dispatch: ${parsed.error.message}`);
    }
    const value = parsed.data;
    const inserted = await q.query<ToolCallRow>(
      `INSERT INTO mcp_tool_calls
         (call_id, intent_id, case_id, owner_id, role, tool_name, tool_version,
          provider, risk_tier, status, validated_arguments_digest, latency_ms,
          correlation_id, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '${ToolCallStatus.DISPATCHED}', $10, 0, $11, $12)
       ON CONFLICT (call_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        value.callId,
        value.intentId,
        value.scope.caseId,
        value.scope.ownerId,
        value.role,
        value.toolName,
        value.toolVersion,
        value.provider,
        value.riskTier,
        value.validatedArgumentsDigest,
        value.correlationId,
        value.traceId,
      ],
    );
    const won = inserted.rows[0];
    if (won !== undefined) return toRecord(won);
    // The id is already in the ledger. Refusing is the fail-closed choice: a
    // caller that reads this as "fine, dispatch anyway" is the duplicate-call bug
    // this table exists to prevent.
    throw new ToolCallLedgerError(
      `tool call ${value.callId} is already recorded; refusing to dispatch it twice`,
    );
  }

  /**
   * Record a refusal. Terminal on insert: nothing was dispatched.
   *
   * Refusals live in the same ledger as executed calls on purpose. "The model
   * proposed a cross-scope call and was refused" is precisely what an audit asks,
   * and a refusal that existed only in a log would be invisible to that question.
   */
  public async recordRefusal(q: Queryable, input: RefusalRecord): Promise<ToolCallRecord> {
    const parsed = refusalSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolCallLedgerError(`invalid tool call refusal: ${parsed.error.message}`);
    }
    const value = parsed.data;
    const inserted = await q.query<ToolCallRow>(
      `INSERT INTO mcp_tool_calls
         (call_id, intent_id, case_id, owner_id, role, tool_name, tool_version,
          provider, risk_tier, status, refusal_code, validated_arguments_digest,
          latency_ms, correlation_id, trace_id, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '${ToolCallStatus.REFUSED}', $10, $11, 0,
               $12, $13, now())
       ON CONFLICT (call_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        value.callId,
        value.intentId,
        value.scope.caseId,
        value.scope.ownerId,
        value.role,
        value.toolName,
        value.toolVersion,
        value.provider,
        value.riskTier,
        value.refusalCode,
        value.validatedArgumentsDigest,
        value.correlationId,
        value.traceId,
      ],
    );
    const won = inserted.rows[0];
    if (won !== undefined) return toRecord(won);
    throw new ToolCallLedgerError(`tool call ${value.callId} is already recorded`);
  }

  /**
   * Write the terminal receipt for a dispatched call.
   *
   * Fenced on `status = 'DISPATCHED'`, so a terminal state is written at most once:
   * a duplicate or late settle cannot overwrite a recorded outcome, and an
   * `AMBIGUOUS` that a reconciliation pass resolved can never be upgraded to
   * `SUCCEEDED` by a straggler. Returns false when the fence rejected the write;
   * the caller then reads the row to see which outcome stands.
   */
  public async settle(
    q: Queryable,
    callId: string,
    scope: ToolCallScope,
    receipt: ToolCallReceipt,
  ): Promise<boolean> {
    const parsedScope = scopeSchema.safeParse(scope);
    if (!parsedScope.success) {
      throw new ToolCallLedgerError(`invalid tool call scope: ${parsedScope.error.message}`);
    }
    const parsed = receiptSchema.safeParse(receipt);
    if (!parsed.success) {
      throw new ToolCallLedgerError(`invalid tool call receipt: ${parsed.error.message}`);
    }
    const value = parsed.data;
    const resultDigest = value.outcome === ToolCallOutcome.SUCCEEDED ? value.resultDigest : null;
    const ambiguityReason =
      value.outcome === ToolCallOutcome.AMBIGUOUS ? value.ambiguityReason : null;
    const updated = await q.query(
      `UPDATE mcp_tool_calls
          SET status = $1, result_digest = $2, ambiguity_reason = $3, artifact_id = $4,
              latency_ms = $5, settled_at = now()
        WHERE call_id = $6 AND case_id = $7 AND owner_id = $8
          AND status = '${ToolCallStatus.DISPATCHED}'`,
      [
        value.outcome,
        resultDigest,
        ambiguityReason,
        value.artifactId ?? null,
        value.latencyMs,
        callId,
        parsedScope.data.caseId,
        parsedScope.data.ownerId,
      ],
    );
    return (updated.rowCount ?? 0) === 1;
  }

  /**
   * Read one call within its own scope.
   *
   * The scope predicate is a fence, not an optimization: a foreign scope gets
   * `null` for a row it does not own. Addressing an id that exists under a
   * DIFFERENT scope raises {@link ToolCallScopeError} rather than returning a quiet
   * `null` a caller might read as "unused, safe to dispatch".
   */
  public async find(
    q: Queryable,
    callId: string,
    scope: ToolCallScope,
  ): Promise<ToolCallRecord | null> {
    const parsedScope = scopeSchema.safeParse(scope);
    if (!parsedScope.success) {
      throw new ToolCallLedgerError(`invalid tool call scope: ${parsedScope.error.message}`);
    }
    const result = await q.query<ToolCallRow>(
      `SELECT ${COLUMNS} FROM mcp_tool_calls
        WHERE call_id = $1 AND case_id = $2 AND owner_id = $3`,
      [callId, parsedScope.data.caseId, parsedScope.data.ownerId],
    );
    const row = result.rows[0];
    if (row !== undefined) return toRecord(row);
    const foreign = await q.query<{ call_id: string }>(
      "SELECT call_id FROM mcp_tool_calls WHERE call_id = $1",
      [callId],
    );
    if (foreign.rows.length > 0) throw new ToolCallScopeError(callId);
    return null;
  }

  /**
   * Resolve a call that was dispatched and never reported, to durable `AMBIGUOUS`.
   *
   * This is the crash path, and the reason it cannot resolve to `FAILED`: the
   * request left the process, so "it did not happen" is not a claim this code is
   * entitled to make. Fenced the same way `settle` is, so a reconciliation pass
   * racing the original caller cannot overwrite a receipt that did arrive.
   */
  public async reconcileUnresolved(
    q: Queryable,
    scope: ToolCallScope,
    reason: McpAmbiguityReason = McpAmbiguityReason.NO_RECEIPT,
  ): Promise<number> {
    const parsedScope = scopeSchema.safeParse(scope);
    if (!parsedScope.success) {
      throw new ToolCallLedgerError(`invalid tool call scope: ${parsedScope.error.message}`);
    }
    const updated = await q.query(
      `UPDATE mcp_tool_calls
          SET status = '${ToolCallStatus.AMBIGUOUS}', ambiguity_reason = $1, settled_at = now()
        WHERE case_id = $2 AND owner_id = $3 AND status = '${ToolCallStatus.DISPATCHED}'`,
      [reason, parsedScope.data.caseId, parsedScope.data.ownerId],
    );
    return updated.rowCount ?? 0;
  }

  /** Every call in this scope whose effect is still unresolved. */
  public async listUnresolved(
    q: Queryable,
    scope: ToolCallScope,
  ): Promise<readonly ToolCallRecord[]> {
    const parsedScope = scopeSchema.safeParse(scope);
    if (!parsedScope.success) {
      throw new ToolCallLedgerError(`invalid tool call scope: ${parsedScope.error.message}`);
    }
    const result = await q.query<ToolCallRow>(
      `SELECT ${COLUMNS} FROM mcp_tool_calls
        WHERE case_id = $1 AND owner_id = $2
          AND status IN ('${ToolCallStatus.DISPATCHED}', '${ToolCallStatus.AMBIGUOUS}')
        ORDER BY dispatched_at ASC`,
      [parsedScope.data.caseId, parsedScope.data.ownerId],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Outcomes for one provider inside a time window, newest first.
   *
   * Feeds the circuit breaker and the rate limiter. Deliberately NOT scoped to a
   * case: provider health is a property of the provider, and a breaker that only
   * saw one case's calls would keep hammering a failing server once per case.
   */
  public async recentByProvider(
    q: Queryable,
    provider: Provider,
    windowMs: number,
    limit = 128,
  ): Promise<readonly { status: ToolCallStatus; dispatchedAt: Date }[]> {
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new ToolCallLedgerError("windowMs must be a positive integer");
    }
    const result = await q.query<{ status: string; dispatched_at: Date }>(
      `SELECT status, dispatched_at FROM mcp_tool_calls
        WHERE provider = $1 AND dispatched_at > now() - ($2::bigint * interval '1 millisecond')
        ORDER BY dispatched_at DESC
        LIMIT $3`,
      [provider, windowMs, limit],
    );
    return result.rows.map((row) => ({
      status: row.status as ToolCallStatus,
      dispatchedAt: row.dispatched_at,
    }));
  }
}
