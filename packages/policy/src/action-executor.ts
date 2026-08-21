/**
 * The action executor: the only code that performs an external write (RA-022-WU-05).
 *
 * It contains NO model reasoning. It takes an already-proposed action, re-decides
 * policy, consumes the approval, calls one provider function and records what came
 * back. Every judgement it makes is a comparison between durable state and a
 * deterministic rule, which is what makes the sequence auditable.
 *
 * THE ORDER IS THE DESIGN. Each step is placed where it is because of a specific way
 * the obvious ordering fails:
 *
 *  1. **Re-evaluate policy immediately before the side effect (AC3)** and compare it
 *     to the evaluation made at proposal time. A single check at proposal is a TOCTOU:
 *     an operator can stop the system, a credential can be revoked, and a case can
 *     move, all in the seconds a human spends reading a Discord message.
 *  2. **Consume the approval and read the kill switch in ONE transaction (AC6).**
 *     Not "check the switch, then consume" — that leaves the same window one level
 *     down. `ApprovalRepository.consume` demands a branded `PolicyTransaction` precisely so
 *     this cannot be done across two.
 *  3. **Commit the intent BEFORE calling the provider.** The action is moved to
 *     EXECUTING and committed first, so a crash between commit and provider call is
 *     recoverable: recovery finds an EXECUTING action and knows a write MAY have
 *     happened. The reverse order — call, then record — loses the write entirely on
 *     crash, and there is then nothing to reconcile against. This is the pattern
 *     RA-012, RA-017 and RA-021 each arrived at.
 *  4. **No receipt means AMBIGUOUS, never SUCCEEDED (AC4).** A timeout after the
 *     request left the process is indistinguishable from a timeout before it, so the
 *     only honest state is "unknown". `AMBIGUOUS` stops AUTOMATIC replay; a
 *     reconciler resolves it by asking the provider what exists.
 *  5. **Never blind-retry an ambiguous write.** The single most expensive mistake
 *     available here is sending a comment twice because the first response was slow.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not choose the connection, the tier, the
 * payload or the decision — all of those are already on the durable row, put there by
 * deterministic code. It cannot widen anything: there is no input by which a caller
 * can pass a policy decision, an owner or a digest.
 */
import { PolicyDecision } from "@remoteagent/contracts";

import {
  evaluatePolicy,
  policyEvaluationsAgree,
  type PolicyEvaluation,
  type PolicyInput,
} from "./policy-engine.js";
import type {
  ApprovalIngestionPorts,
  PolicyExternalActionRow,
  PolicyTransaction,
} from "./ingestion-ports.js";

/**
 * What a provider adapter returns on a confirmed write.
 *
 * `entityVersion` and `entityVersionField` are required, not optional, and that is
 * AC7: a receipt must bind the external entity VERSION, not just its id. An id alone
 * cannot answer "did my write land?" during reconciliation — a Jira issue keeps its
 * key across edits, a Calendar event keeps its id — so a provider that confirms must
 * say what it produced. Making these optional would let an adapter return a receipt
 * that looks complete and is useless to a reconciler.
 */
export interface ProviderReceipt {
  externalId: string;
  /** Provider-native version discriminator: Jira `updated`, Calendar `etag`, … */
  entityVersion: string;
  /** Which provider field the version came from, so a reconciler can compare it. */
  entityVersionField: string;
  /** Provider status string, if any. */
  status?: string;
}

/**
 * The outcome an adapter reports.
 *
 * `AMBIGUOUS` is a first-class result, not an exception, because it is a NORMAL
 * outcome of a network call and must be as easy to return as success. An adapter that
 * had to throw to say "I don't know" would be tempted to say "failed" instead — and
 * "failed" licenses a retry, which is exactly what must not happen.
 */
export type ProviderOutcome =
  /** The provider confirmed the effect and returned proof of what it produced. */
  | { kind: "CONFIRMED"; receipt: ProviderReceipt }
  /**
   * The request demonstrably did not take effect: refused before dispatch, or a
   * definite provider error (4xx validation, auth). Safe to retry.
   */
  | { kind: "REFUSED"; reason: string }
  /**
   * The request may or may not have taken effect: timeout, connection reset, 5xx
   * after send. NOT safe to retry — the write may already exist.
   */
  | { kind: "UNCONFIRMED"; reason: string };

/** One provider write. Called exactly once, with the payload already on the row. */
export type ProviderAdapter = (input: {
  toolName: string;
  connectionId: string;
  canonicalPayload: Record<string, unknown>;
  idempotencyKey: string;
}) => Promise<ProviderOutcome>;

/** Persistence the executor needs beyond the ingestion ports. */
export interface ExecutorPorts extends ApprovalIngestionPorts {
  receipts: {
    /** Append the receipt for a confirmed write. Fails if one already exists. */
    record(
      tx: PolicyTransaction,
      input: {
        receiptId: string;
        actionId: string;
        externalId: string;
        entityVersion: string;
        entityVersionField: string;
        status: string | null;
      },
    ): Promise<void>;
  };
  killSwitches: {
    /** Effective switches for (owner, provider, connection), newest per level. */
    listEffective(
      tx: PolicyTransaction,
      input: { ownerId: string; provider: string; connectionId: string },
    ): Promise<
      readonly {
        event_id: string;
        scope_level: "GLOBAL" | "PROVIDER" | "CONNECTION";
        provider: string | null;
        connection_id: string | null;
        enabled: boolean;
        reason: string;
      }[]
    >;
  };
  /**
   * Read the DATABASE clock inside the caller's transaction.
   *
   * The executor must not use `new Date()` for a policy decision: `PolicyInput.now`
   * documents that a backdated instant turns an expired credential into an allowed
   * action, and a pure evaluator cannot defend itself. This is where that gap closes —
   * the same reason `ApprovalRepository.consume` compares `expires_at > now()` in SQL
   * (AUDIT-04 HIGH-08).
   */
  now(tx: PolicyTransaction): Promise<Date>;
}

/** Everything the executor needs that is not already on the durable row. */
export interface ExecuteActionInput {
  actionId: string;
  /** Provider of the action's connection; server-owned, from the connection record. */
  provider: string;
  /** Authoritative case scope (connection ids) for the re-evaluation. */
  caseConnectionIds: readonly string[];
  connectionHealth: PolicyInput["connectionHealth"];
  credentialExpiresAt: Date | null;
  /** The evaluation recorded when the action was proposed, for the AC3 comparison. */
  evaluationAtProposal: PolicyEvaluation;
  /** Id to give the receipt if one is produced. */
  receiptId: string;
}

/** Why execution stopped, or the receipt it produced. */
export type ExecutionOutcome =
  | { outcome: "SUCCEEDED"; receipt: ProviderReceipt; action: PolicyExternalActionRow }
  /** The provider definitively refused. Safe to propose again. */
  | { outcome: "FAILED"; reason: string }
  /**
   * The write may have landed. Automatic replay is now FORBIDDEN; a reconciler must
   * ask the provider what exists.
   */
  | { outcome: "AMBIGUOUS"; reason: string }
  | { outcome: "ACTION_NOT_FOUND" }
  /** The action is not in a state from which execution may start. */
  | { outcome: "NOT_EXECUTABLE"; status: string }
  /**
   * Policy no longer permits this action, or no longer AGREES with the decision made
   * at proposal. Carries both evaluations so the audit log records what changed.
   */
  | {
      outcome: "POLICY_CHANGED";
      atProposal: PolicyEvaluation;
      beforeExecute: PolicyEvaluation;
    }
  /** Policy refused outright at the pre-execute check. */
  | { outcome: "POLICY_DENIED"; evaluation: PolicyEvaluation }
  /** The approval could not be consumed; the reason is the store's own refusal code. */
  | { outcome: "APPROVAL_REFUSED"; reason: string };

/**
 * Execute one external action.
 *
 * `runInTransaction` is supplied by the caller rather than a `Database` being imported,
 * for the package-cycle reason recorded in `ingestion-ports.ts`. Its shape is also
 * load-bearing: the executor opens TWO transactions on purpose, with the provider call
 * strictly between them. Holding one transaction across a network call would pin a
 * connection for the provider's entire latency and make a slow provider a database
 * outage.
 */
export async function executeAction(
  runInTransaction: <T>(fn: (tx: PolicyTransaction) => Promise<T>) => Promise<T>,
  ports: ExecutorPorts,
  adapter: ProviderAdapter,
  input: ExecuteActionInput,
): Promise<ExecutionOutcome> {
  // ---------------------------------------------------------------------------
  // PolicyTransaction 1: re-decide policy, consume the approval, commit the intent.
  //
  // All three in ONE transaction. The kill switch is read here (AC6), the approval is
  // consumed here (AC2), and the action is moved to EXECUTING here — so if anything
  // refuses, the whole thing rolls back and the owner's grant survives unspent.
  // ---------------------------------------------------------------------------
  const prepared = await runInTransaction(
    async (tx): Promise<PreparedExecution | ExecutionOutcome> => {
      const action = await ports.actions.findById(tx, input.actionId);
      if (action === null) {
        return { outcome: "ACTION_NOT_FOUND" };
      }

      // Which statuses may begin execution depends on the policy decision, and the
      // contract's transition guard already encodes it: AUTO_ALLOW takes
      // PROPOSED -> EXECUTING, REQUIRES_APPROVAL must come via APPROVED.
      const startStatus =
        action.policy_decision === PolicyDecision.AUTO_ALLOW ? "PROPOSED" : "APPROVED";
      if (action.status !== startStatus) {
        return { outcome: "NOT_EXECUTABLE", status: action.status };
      }

      // The database clock, inside this transaction — not `new Date()`.
      const now = await ports.now(tx);

      // The kill switch, in the SAME transaction that is about to consume the
      // approval. This is AC6: a switch flipped after the approval was granted must
      // still stop the write, and reading it in its own earlier transaction would
      // leave exactly that window.
      const switchRows = await ports.killSwitches.listEffective(tx, {
        ownerId: action.owner_id,
        provider: input.provider,
        connectionId: action.connection_id,
      });

      const beforeExecute = evaluatePolicy({
        toolName: action.tool_name,
        caseId: action.case_id,
        ownerId: action.owner_id,
        provider: input.provider as PolicyInput["provider"],
        connectionId: action.connection_id,
        caseConnectionIds: input.caseConnectionIds,
        connectionHealth: input.connectionHealth,
        credentialExpiresAt: input.credentialExpiresAt,
        killSwitches: switchRows.map((row) => ({
          eventId: row.event_id,
          level: row.scope_level,
          provider: row.provider as PolicyInput["provider"] | null,
          connectionId: row.connection_id,
          enabled: row.enabled,
          reason: row.reason,
        })),
        now,
      });

      if (beforeExecute.decision === PolicyDecision.DENY) {
        return { outcome: "POLICY_DENIED", evaluation: beforeExecute };
      }

      // AC3: the two evaluations must AGREE, not merely both permit. A decision that
      // is the same for a different reason — a kill switch that appeared and was
      // withdrawn, a tier that moved — means the world changed under the owner's
      // consent, and the safe response is to stop and re-propose.
      if (!policyEvaluationsAgree(input.evaluationAtProposal, beforeExecute)) {
        return {
          outcome: "POLICY_CHANGED",
          atProposal: input.evaluationAtProposal,
          beforeExecute,
        };
      }

      if (action.policy_decision === PolicyDecision.REQUIRES_APPROVAL) {
        if (action.approval_id === null) {
          // Unreachable while `attachApproval` and the contract hold, but a missing
          // approval on an approval-requiring action must fail closed rather than
          // fall through to execution.
          return { outcome: "APPROVAL_REFUSED", reason: "NO_APPROVAL_ATTACHED" };
        }
        const consumed = await ports.approvals.consume(tx, {
          approvalId: action.approval_id,
          caseId: action.case_id,
          // From the ROW, which migration 010 derived from the case — never from a
          // caller argument.
          ownerId: action.owner_id,
          // From the ROW, so the grant is checked against the payload that will
          // actually be sent (AC1 at the execution boundary).
          actionDigest: action.action_digest,
        });
        if (consumed.outcome !== "CONSUMED") {
          return { outcome: "APPROVAL_REFUSED", reason: consumed.outcome };
        }
      }

      // Commit the intent BEFORE the side effect. Fenced on the status we read, so a
      // concurrent executor cannot also start this action.
      const advanced = await ports.actions.advanceStatus(tx, {
        actionId: action.action_id,
        from: startStatus,
        to: "EXECUTING",
      });
      if (!advanced) {
        return { outcome: "NOT_EXECUTABLE", status: action.status };
      }

      return { kind: "PREPARED", action };
    },
  );

  if (!("kind" in prepared)) {
    return prepared;
  }
  const action = prepared.action;

  // ---------------------------------------------------------------------------
  // The side effect. Outside any transaction: a provider's latency must not hold a
  // database connection, and the action is already durably EXECUTING, so a crash here
  // is recoverable as "may have happened".
  //
  // Exactly ONE call. There is deliberately no retry loop: a retry is only safe for a
  // REFUSED outcome, and deciding that here would mean re-entering the state machine
  // from inside the call site. Retry is the caller's decision, made against the
  // durable status.
  // ---------------------------------------------------------------------------
  let providerOutcome: ProviderOutcome;
  try {
    providerOutcome = await adapter({
      toolName: action.tool_name,
      connectionId: action.connection_id,
      canonicalPayload: action.canonical_payload,
      idempotencyKey: action.idempotency_key,
    });
  } catch (error) {
    // An adapter that THREW tells us nothing about whether the request left the
    // process. That is the definition of ambiguous, so a thrown error is never
    // treated as a failure — treating it as FAILED would license a retry of a write
    // that may already exist.
    providerOutcome = {
      kind: "UNCONFIRMED",
      reason: `adapter threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // ---------------------------------------------------------------------------
  // PolicyTransaction 2: record the outcome. Every branch writes a terminal status, so an
  // action never stays EXECUTING after a completed call.
  // ---------------------------------------------------------------------------
  return runInTransaction(async (tx): Promise<ExecutionOutcome> => {
    switch (providerOutcome.kind) {
      case "CONFIRMED": {
        // Receipt and status are written in ONE transaction, so no observer can ever
        // see a SUCCEEDED action without its receipt — the `externalAction` contract's
        // requirement is satisfied by the atomicity, not by the order of these two
        // statements. Reversing them changes nothing observable, which a mutation
        // confirmed: swapping them left every test green. The order below is merely
        // the one that reads in causal sequence.
        //
        // What IS load-bearing is that they share the transaction. If the receipt were
        // committed separately and the status write then failed, the action would sit
        // in EXECUTING with a receipt already recorded, and a reconciler would have to
        // guess whether the write had been accounted for.
        try {
          await ports.receipts.record(tx, {
            receiptId: input.receiptId,
            actionId: action.action_id,
            externalId: providerOutcome.receipt.externalId,
            entityVersion: providerOutcome.receipt.entityVersion,
            entityVersionField: providerOutcome.receipt.entityVersionField,
            status: providerOutcome.receipt.status ?? null,
          });
        } catch (error) {
          // THE WRITE ALREADY HAPPENED. Only the record of it failed — a malformed
          // receipt (an adapter returning an empty entity version, refused by migration
          // 031's CHECK), a duplicate receipt id, a transient database fault.
          //
          // The WU-05 probe found that this left the action in EXECUTING, which is the
          // worst available state: `reconcileAmbiguousAction` only accepts AMBIGUOUS, so
          // nothing would ever resolve it, and an operator seeing "executing" for hours
          // would reasonably conclude the call was still in flight and re-run it —
          // re-doing an external write that had already succeeded.
          //
          // AMBIGUOUS is the honest state: the side effect probably landed but this
          // system holds no proof of it, which is exactly what AMBIGUOUS means. A
          // reconciler can then read the provider and settle it.
          //
          // Recorded in a SEPARATE transaction because this one is now aborted by the
          // failed insert — any further statement on `tx` would be rejected with
          // "current transaction is aborted" (the same trap hit in WU-02's grant path).
          await runInTransaction((fresh) =>
            ports.actions.advanceStatus(fresh, {
              actionId: action.action_id,
              from: "EXECUTING",
              to: "AMBIGUOUS",
            }),
          );
          return {
            outcome: "AMBIGUOUS",
            reason:
              `the provider confirmed the write but the receipt could not be recorded, ` +
              `so no proof of it exists: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        await ports.actions.advanceStatus(tx, {
          actionId: action.action_id,
          from: "EXECUTING",
          to: "SUCCEEDED",
        });
        return { outcome: "SUCCEEDED", receipt: providerOutcome.receipt, action };
      }
      case "REFUSED": {
        await ports.actions.advanceStatus(tx, {
          actionId: action.action_id,
          from: "EXECUTING",
          to: "FAILED",
        });
        return { outcome: "FAILED", reason: providerOutcome.reason };
      }
      case "UNCONFIRMED": {
        // AMBIGUOUS, and no receipt. The action is now outside automatic replay: the
        // contract forbids a receipt on a non-SUCCEEDED action, and the state machine
        // allows AMBIGUOUS -> SUCCEEDED/FAILED only by manual reconciliation.
        await ports.actions.advanceStatus(tx, {
          actionId: action.action_id,
          from: "EXECUTING",
          to: "AMBIGUOUS",
        });
        return { outcome: "AMBIGUOUS", reason: providerOutcome.reason };
      }
      default: {
        const exhaustive: never = providerOutcome;
        throw new Error(`unhandled provider outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
}

interface PreparedExecution {
  kind: "PREPARED";
  action: PolicyExternalActionRow;
}

/**
 * Resolve an `AMBIGUOUS` action against what the provider actually holds.
 *
 * Separate from {@link executeAction} because reconciliation is a DIFFERENT operation
 * with a different safety rule: it may only ever READ from the provider. A reconciler
 * that could write would be a blind-retry path wearing another name, which is the
 * failure AC4 exists to prevent.
 *
 * The lookup answers "does an object matching this action's payload exist, and at what
 * version?" — which is why the receipt records `entity_version`: without it the
 * reconciler could confirm an object exists but not that THIS write produced its
 * current state.
 */
export async function reconcileAmbiguousAction(
  runInTransaction: <T>(fn: (tx: PolicyTransaction) => Promise<T>) => Promise<T>,
  ports: ExecutorPorts,
  /**
   * READ-ONLY provider lookup. Returns the receipt if the effect is found.
   *
   * The lookup must return `matchedIdempotencyKey` — the key it found recorded ON THE
   * PROVIDER SIDE for the object it matched. The WU-05 probe showed why this cannot be
   * optional: a lookup returning an arbitrary receipt had it written straight to the
   * action, so a buggy or hostile adapter could settle an ambiguous write as SUCCEEDED
   * against a completely unrelated object (`TOTALLY-UNRELATED-999`). The reconciler then
   * "proves" a write landed that never did, and the action leaves AMBIGUOUS on false
   * evidence — the exact failure AC4 exists to prevent, arrived at from the other side.
   */
  lookup: (input: {
    toolName: string;
    connectionId: string;
    canonicalPayload: Record<string, unknown>;
    idempotencyKey: string;
  }) => Promise<
    { found: true; receipt: ProviderReceipt; matchedIdempotencyKey: string } | { found: false }
  >,
  input: { actionId: string; receiptId: string },
): Promise<
  | { outcome: "RECONCILED_SUCCEEDED"; receipt: ProviderReceipt }
  | { outcome: "RECONCILED_FAILED" }
  | { outcome: "STILL_AMBIGUOUS"; reason: string }
  | { outcome: "NOT_AMBIGUOUS"; status: string }
  | { outcome: "ACTION_NOT_FOUND" }
> {
  const action = await runInTransaction((tx) => ports.actions.findById(tx, input.actionId));
  if (action === null) {
    return { outcome: "ACTION_NOT_FOUND" };
  }
  if (action.status !== "AMBIGUOUS") {
    // Only an AMBIGUOUS action may be reconciled. Allowing any status would let this
    // path rewrite a settled outcome.
    return { outcome: "NOT_AMBIGUOUS", status: action.status };
  }

  let found: Awaited<ReturnType<typeof lookup>>;
  try {
    found = await lookup({
      toolName: action.tool_name,
      connectionId: action.connection_id,
      canonicalPayload: action.canonical_payload,
      idempotencyKey: action.idempotency_key,
    });
  } catch (error) {
    // A failed lookup leaves the action AMBIGUOUS. It must NOT be resolved either way:
    // "I could not check" is not evidence of absence, and treating it as such would
    // license the retry AC4 forbids.
    return {
      outcome: "STILL_AMBIGUOUS",
      reason: `lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (found.found && found.matchedIdempotencyKey !== action.idempotency_key) {
    // The lookup found SOMETHING, but not this action's write. Left AMBIGUOUS: a
    // mismatched match is no more informative than no match, and settling on it would
    // manufacture evidence. Reported distinctly from a plain lookup failure so an
    // operator can see that the reconciler is being handed the wrong objects.
    return {
      outcome: "STILL_AMBIGUOUS",
      reason:
        `lookup returned an object whose idempotency key ${found.matchedIdempotencyKey} ` +
        `does not match this action's ${action.idempotency_key}; refusing to settle on it`,
    };
  }

  return runInTransaction(async (tx) => {
    if (found.found) {
      await ports.receipts.record(tx, {
        receiptId: input.receiptId,
        actionId: action.action_id,
        externalId: found.receipt.externalId,
        entityVersion: found.receipt.entityVersion,
        entityVersionField: found.receipt.entityVersionField,
        status: found.receipt.status ?? null,
      });
      await ports.actions.advanceStatus(tx, {
        actionId: action.action_id,
        from: "AMBIGUOUS",
        to: "SUCCEEDED",
      });
      return { outcome: "RECONCILED_SUCCEEDED", receipt: found.receipt } as const;
    }
    // The provider confirms the effect does NOT exist, so the write definitively did
    // not land. Only now is the action safe to re-propose.
    await ports.actions.advanceStatus(tx, {
      actionId: action.action_id,
      from: "AMBIGUOUS",
      to: "FAILED",
    });
    return { outcome: "RECONCILED_FAILED" } as const;
  });
}
