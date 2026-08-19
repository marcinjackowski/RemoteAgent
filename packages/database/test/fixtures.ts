/**
 * Test fixtures for the database integration suite (RA-003).
 */
import type { CaseCheckpoint } from "@remoteagent/contracts";

/** Build a minimal valid CaseCheckpoint payload for a given case/revision. */
export function makeCheckpoint(caseId: string, revision: number): CaseCheckpoint {
  return {
    schema_version: 1,
    case_id: caseId,
    revision,
    goal: "test goal",
    current_phase: "planning",
    summary: { trust: "UNTRUSTED_DATA", value: "external-derived summary" },
    plan_revision: 0,
    completed_work: [],
    decisions: [],
    assumptions: [],
    evidence: [],
    open_questions: [],
    next_actions: [],
    blockers: [],
    pending_approvals: [],
    workspace_state: { tree_digest: null, base_sha: null },
    branch_state: { branch_name: null, ahead: 0, behind: 0 },
    test_runs: [],
    snapshot_changes: [],
    review_findings: [],
    merge_request_state: { mr_ref: null, status: null },
    external_state_versions: [],
    last_event_id: null,
    last_run_id: null,
    updated_at: new Date().toISOString(),
  };
}
