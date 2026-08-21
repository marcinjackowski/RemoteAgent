/**
 * Durable `external_actions` persistence: the proposal record an approval is raised
 * against, and the state machine an executor advances (RA-022-WU-04).
 *
 * The row is the authoritative statement of WHAT is being authorized. Its
 * `action_digest` is recomputed from `canonical_payload` by the `externalAction`
 * contract, its `risk_tier` and `policy_decision` come from the deterministic policy
 * engine, and migration 008 makes `risk_tier = 'R4' AND policy_decision =
 * 'AUTO_ALLOW'` unrepresentable in SQL. None of those values may originate in model
 * output, so `propose` takes them as separate arguments computed by deterministic
 * code rather than accepting a model-shaped blob.
 *
 * WHY INGESTION NEEDS THIS. A Discord approval button carries an `approval_id` and a
 * checkpoint revision — deliberately NOT a digest, because a digest in a
 * user-controlled round trip is a digest an attacker can substitute. So the digest
 * has to be looked up server-side from the pending proposal, which is this table.
 * That lookup is the whole reason WU-04 depends on WU-02's repository rather than
 * the other way round: the click identifies a proposal, and the STORE supplies what
 * the proposal authorizes.
 */
import { ExternalActionStatus, PolicyDecision, type RiskTier } from "@remoteagent/contracts";

import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import { PersistenceError } from "../errors.js";

export interface ExternalActionRow {
  action_id: string;
  case_id: string;
  /** Denormalized owner scope, derived from the case (migration 010). */
  owner_id: string;
  tool_name: string;
  connection_id: string;
  repo: string | null;
  canonical_payload: Record<string, unknown>;
  action_digest: string;
  risk_tier: RiskTier;
  policy_decision: PolicyDecision;
  approval_id: string | null;
  idempotency_key: string;
  status: ExternalActionStatus;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `action_id, case_id, owner_id, tool_name, connection_id, repo, canonical_payload,
  action_digest, risk_tier, policy_decision, approval_id, idempotency_key, status,
  created_at, updated_at`;

export interface ProposeExternalAction {
  actionId: string;
  caseId: string;
  toolName: string;
  connectionId: string;
  repo?: string | null;
  /** The exact payload that will be sent to the provider. */
  canonicalPayload: Record<string, unknown>;
  /** Canonical digest of `canonicalPayload`, computed by the caller's contract parse. */
  actionDigest: string;
  /** Server-owned tier from the policy engine's registry — never from a model. */
  riskTier: RiskTier;
  /** Server-owned decision from the policy engine — never from a model. */
  policyDecision: PolicyDecision;
  /** At-most-once key for the external side effect. */
  idempotencyKey: string;
}

/**
 * Outcome of proposing an action.
 *
 * `ALREADY_PROPOSED` exists because a proposal is idempotent by `action_id`: a
 * retried orchestrator step must re-address the SAME proposal rather than mint a
 * second one for the same intent.
 */
export type ProposeOutcome =
  | { outcome: "PROPOSED"; row: ExternalActionRow }
  | { outcome: "ALREADY_PROPOSED"; row: ExternalActionRow }
  /**
   * A DIFFERENT canonical action already occupies this digest or idempotency key.
   * Refused fail-closed: reusing either would let one authorization cover two
   * distinct payloads.
   */
  | { outcome: "CONFLICT"; conflictingOn: "action_digest" | "idempotency_key" };

export class ExternalActionRepository {
  /**
   * Record a proposal.
   *
   * Idempotent on `action_id`, and fail-closed on a reused `action_digest` or
   * `idempotency_key` that names a different action — migration 008 enforces both
   * with unique constraints, and this method reports which one collided instead of
   * surfacing a raw driver error, because the two mean different things to a caller.
   */
  public async propose(q: Queryable, input: ProposeExternalAction): Promise<ProposeOutcome> {
    try {
      const inserted = await q.query<ExternalActionRow>(
        // `owner_id` is read from the CASE inside the same statement, never accepted
        // from the caller — the pattern migration 010 established for this table and
        // the same rule `ApprovalRepository.grant` follows. The composite FKs to
        // `cases (case_id, owner_id)` and `connections (connection_id, owner_id)` then
        // make a row that crosses an ownership edge unrepresentable, so the derivation
        // and the constraint agree rather than one relying on the other.
        `INSERT INTO external_actions (
           action_id, case_id, owner_id, tool_name, connection_id, repo, canonical_payload,
           action_digest, risk_tier, policy_decision, idempotency_key, status)
         VALUES ($1, $2, (SELECT owner_id FROM cases WHERE case_id = $2), $3, $4, $5,
                 $6::jsonb, $7, $8, $9, $10, 'PROPOSED')
         ON CONFLICT (action_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          input.actionId,
          input.caseId,
          input.toolName,
          input.connectionId,
          input.repo ?? null,
          JSON.stringify(input.canonicalPayload),
          input.actionDigest,
          input.riskTier,
          input.policyDecision,
          input.idempotencyKey,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) {
        return { outcome: "PROPOSED", row };
      }

      const existing = await this.findById(q, input.actionId);
      if (existing === null) {
        throw new PersistenceError(`external action disappeared after insert: ${input.actionId}`);
      }
      // A replayed step must re-address the same proposal; a reused id naming a
      // different action is a caller bug and must not be accepted as a replay.
      if (
        existing.action_digest !== input.actionDigest ||
        existing.case_id !== input.caseId ||
        existing.tool_name !== input.toolName
      ) {
        throw new PersistenceError(
          `action ${input.actionId} is already bound to a different proposal`,
        );
      }
      return { outcome: "ALREADY_PROPOSED", row: existing };
    } catch (error) {
      const translated = translatePgError(error) ?? error;
      const constraint =
        typeof translated === "object" && translated !== null && "constraint" in translated
          ? String((translated as { constraint?: unknown }).constraint)
          : "";
      if (constraint === "external_actions_digest_idx") {
        return { outcome: "CONFLICT", conflictingOn: "action_digest" };
      }
      if (constraint === "external_actions_idempotency_key_key") {
        return { outcome: "CONFLICT", conflictingOn: "idempotency_key" };
      }
      throw translated;
    }
  }

  public async findById(q: Queryable, actionId: string): Promise<ExternalActionRow | null> {
    const result = await q.query<ExternalActionRow>(
      `SELECT ${COLUMNS} FROM external_actions WHERE action_id = $1`,
      [actionId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The proposal an approval was raised for, resolved from the case and digest.
   *
   * This is the server-side lookup that keeps a digest out of the Discord round
   * trip. Scoped by `case_id` as well as digest so a digest observed in one case can
   * never address a proposal in another.
   */
  public async findPendingByDigest(
    q: Queryable,
    input: { caseId: string; actionDigest: string },
  ): Promise<ExternalActionRow | null> {
    const result = await q.query<ExternalActionRow>(
      `SELECT ${COLUMNS} FROM external_actions
        WHERE case_id = $1 AND action_digest = $2 AND status = 'PROPOSED'`,
      [input.caseId, input.actionDigest],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Bind a granted approval to the action and move it to APPROVED.
   *
   * Fenced on `status = 'PROPOSED'` and on the action still requiring an approval, so
   * a racing second grant, or an attempt to attach an approval to an already-executing
   * or rejected action, affects zero rows and returns false. Requires a
   * {@link Transaction} because it must share the boundary that consumed nothing yet
   * but has already validated the grant — binding and validation must not be
   * separately committable.
   */
  public async attachApproval(
    tx: Transaction,
    input: { actionId: string; approvalId: string },
  ): Promise<boolean> {
    try {
      const result = await tx.query(
        `UPDATE external_actions
            SET approval_id = $2, status = 'APPROVED'
          WHERE action_id = $1
            AND status = 'PROPOSED'
            AND policy_decision = 'REQUIRES_APPROVAL'
            AND approval_id IS NULL`,
        [input.actionId, input.approvalId],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Record the owner's rejection.
   *
   * Fenced on `PROPOSED` so a rejection cannot retroactively cancel an action that is
   * already executing — that case is a reconciliation problem, not a rejection.
   */
  public async reject(tx: Transaction, actionId: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE external_actions SET status = 'REJECTED'
        WHERE action_id = $1 AND status = 'PROPOSED'`,
      [actionId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Advance status with a fence on the expected current status.
   *
   * A compare-and-set rather than a blind write: the caller states which status it
   * believes the action is in, and a concurrent writer that already moved it makes
   * this return false. The legality of the transition itself is the contract's
   * `assertExternalActionTransition`; this method enforces that only ONE writer wins
   * a given transition.
   */
  public async advanceStatus(
    tx: Transaction,
    input: { actionId: string; from: ExternalActionStatus; to: ExternalActionStatus },
  ): Promise<boolean> {
    try {
      const result = await tx.query(
        `UPDATE external_actions SET status = $3
          WHERE action_id = $1 AND status = $2`,
        [input.actionId, input.from, input.to],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }
}

/**
 * Append-only receipt persistence: proof of a confirmed external side effect.
 *
 * `receipts` is guarded by `ra_deny_mutation` for UPDATE and DELETE (migration 008),
 * so a receipt is written once and never revised. That is what makes it evidence
 * rather than state: a record that could be edited after the fact could be made to
 * agree with any later story.
 *
 * `entity_version` and `entity_version_field` are required here even though migration
 * 031 leaves the columns nullable for pre-existing rows. The nullability exists only
 * because an append-only table cannot be backfilled; every receipt this repository
 * writes carries a version, because AC7 requires a receipt to bind the external entity
 * version and a reconciler cannot compare what was never recorded.
 */
export class ReceiptRepository {
  /**
   * Append the receipt for a confirmed write.
   *
   * No `ON CONFLICT`: migration 008's `UNIQUE (action_id)` means a second receipt for
   * one action is a genuine contradiction — two confirmations of a single at-most-once
   * effect — and swallowing it would hide a double execution, which is the one thing
   * the idempotency machinery exists to prevent.
   */
  public async record(
    q: Queryable,
    input: {
      receiptId: string;
      actionId: string;
      externalId: string;
      entityVersion: string;
      entityVersionField: string;
      status: string | null;
    },
  ): Promise<ReceiptRow> {
    try {
      const result = await q.query<ReceiptRow>(
        `INSERT INTO receipts (receipt_id, action_id, external_id, entity_version,
           entity_version_field, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING receipt_id, action_id, external_id, entity_version,
                   entity_version_field, status, received_at`,
        [
          input.receiptId,
          input.actionId,
          input.externalId,
          input.entityVersion,
          input.entityVersionField,
          input.status,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findByAction(q: Queryable, actionId: string): Promise<ReceiptRow | null> {
    const result = await q.query<ReceiptRow>(
      `SELECT receipt_id, action_id, external_id, entity_version, entity_version_field,
              status, received_at
         FROM receipts WHERE action_id = $1`,
      [actionId],
    );
    return result.rows[0] ?? null;
  }
}

export interface ReceiptRow {
  receipt_id: string;
  action_id: string;
  external_id: string;
  entity_version: string | null;
  entity_version_field: string | null;
  status: string | null;
  received_at: Date;
}
