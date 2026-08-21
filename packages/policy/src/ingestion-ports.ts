/**
 * Structural port types for the approval ingestion and execution layers.
 *
 * WHY EVERY NAME HERE IS PREFIXED `Policy`. These types mirror shapes that
 * `packages/database` also exports, so the unprefixed names (`ApprovalRow`,
 * `ExternalActionRow`, `Transaction`, …) would collide across the two package barrels.
 * That collision is `CTF-002`, and its type-only form is the quietest version: ESM
 * silently drops an ambiguous name from a combined barrel, `typecheck` and `build` stay
 * green, and a runtime `Object.keys` scan cannot see it because a type has no value.
 * It is detectable only by a `ts.Program` + `checker.getExportsOfModule()` probe — which
 * is exactly how these four were caught in this task's gate, after they had been
 * introduced.
 *
 * The registry's recorded remedy is unambiguous names rather than a shared barrel, so
 * that is what these are.
 *
 * WHY THESE ARE RESTATED RATHER THAN IMPORTED. `packages/policy` cannot depend on
 * `@remoteagent/database`: `packages/database` devDepends on `@remoteagent/policy`
 * for its own tests, so a manifest edge in this direction makes turbo's build graph
 * cyclic and `build` refuses to run. That is measured, not assumed — it was tried in
 * WU-01 and recorded in the RA-022 plan.
 *
 * So the boundary is expressed STRUCTURALLY: the real `ApprovalRepository` and
 * `ExternalActionRepository` satisfy these interfaces by shape, without either
 * package importing the other. TypeScript checks the fit at the call site in the
 * integration tests, which construct the real repositories and pass them where a
 * port is expected — so a drift between the two definitions is a compile error there,
 * not a silent divergence.
 *
 * The alternative — moving the repositories into `packages/policy` — was rejected
 * because persistence belongs to `packages/database` (WU-02's recorded finding), and
 * inverting that to dodge a devDependency edge would put SQL in the policy package.
 */

/**
 * A query handle guaranteed to be inside an open transaction.
 *
 * Structurally minimal on purpose: this package must not reproduce the branded
 * `PolicyTransaction` type, because a brand it declares itself would be a DIFFERENT brand
 * and the real one would not satisfy it. The atomicity guarantee is enforced where
 * the brand lives (`packages/database`); here the type only records that a
 * transaction is required.
 */
export interface PolicyTransaction {
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}

/** Mirrors `packages/database/src/repositories/approval.ts`. */
export interface PolicyApprovalRow {
  approval_id: string;
  case_id: string;
  owner_id: string;
  granted_by: string;
  action_digest: string;
  checkpoint_revision: number;
  granted_at: Date;
  expires_at: Date;
  consumed: boolean;
  consumed_at: Date | null;
}

export type PolicyApprovalGrantOutcome =
  | { outcome: "GRANTED"; row: PolicyApprovalRow }
  | { outcome: "ALREADY_GRANTED"; row: PolicyApprovalRow }
  | { outcome: "CASE_NOT_FOUND" }
  | { outcome: "STALE_REVISION"; requested: number; current: number }
  | { outcome: "LIVE_GRANT_EXISTS"; row: PolicyApprovalRow };

export type PolicyApprovalConsumption =
  | { outcome: "CONSUMED"; row: PolicyApprovalRow }
  | { outcome: "NOT_FOUND" }
  | { outcome: "WRONG_OWNER" }
  | { outcome: "DIGEST_MISMATCH"; row: PolicyApprovalRow }
  | { outcome: "ALREADY_CONSUMED"; row: PolicyApprovalRow }
  | { outcome: "EXPIRED"; row: PolicyApprovalRow }
  | { outcome: "STALE_REVISION"; row: PolicyApprovalRow; currentRevision: number };

/** Mirrors `packages/database/src/repositories/external-action.ts`. */
export interface PolicyExternalActionRow {
  action_id: string;
  case_id: string;
  owner_id: string;
  tool_name: string;
  connection_id: string;
  repo: string | null;
  canonical_payload: Record<string, unknown>;
  action_digest: string;
  risk_tier: string;
  policy_decision: string;
  approval_id: string | null;
  idempotency_key: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * The subset of `ApprovalRepository` the ingestion and executor layers use.
 *
 * Declared with METHOD syntax, not property-arrow syntax, and that is load-bearing:
 * TypeScript checks method parameters bivariantly, so the real repository — whose
 * methods demand the BRANDED `PolicyTransaction` from `packages/database` — satisfies a port
 * declaring the structural one. With arrow syntax under `strictFunctionTypes` the
 * parameter would be checked contravariantly and the real repository would not fit,
 * which would force either a cast at every call site or the package cycle this file
 * exists to avoid.
 */
export interface ApprovalPort {
  grant(
    tx: PolicyTransaction,
    input: {
      approvalId: string;
      caseId: string;
      grantedBy: string;
      actionDigest: string;
      checkpointRevision: number;
      expiresAt: Date;
    },
  ): Promise<PolicyApprovalGrantOutcome>;
  consume(
    tx: PolicyTransaction,
    input: { approvalId: string; caseId: string; ownerId: string; actionDigest: string },
  ): Promise<PolicyApprovalConsumption>;
  findById(tx: PolicyTransaction, approvalId: string): Promise<PolicyApprovalRow | null>;
}

/** The subset of `ExternalActionRepository` the ingestion and executor layers use. */
export interface ExternalActionPort {
  findById(tx: PolicyTransaction, actionId: string): Promise<PolicyExternalActionRow | null>;
  attachApproval(
    tx: PolicyTransaction,
    input: { actionId: string; approvalId: string },
  ): Promise<boolean>;
  reject(tx: PolicyTransaction, actionId: string): Promise<boolean>;
  advanceStatus(
    tx: PolicyTransaction,
    input: { actionId: string; from: string; to: string },
  ): Promise<boolean>;
}

export interface ApprovalIngestionPorts {
  approvals: ApprovalPort;
  actions: ExternalActionPort;
}
