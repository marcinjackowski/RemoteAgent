import { expect, it } from "vitest";
import { buildRecoveryPlan } from "../src/index.js";

const stamp = "2026-08-20T12:00:00.000Z";
const checkpoint = {
  schema_version: 1,
  case_id: "case-1",
  revision: 1,
  goal: "goal",
  current_phase: "planning",
  summary: { trust: "UNTRUSTED_DATA", value: "summary" },
  plan_revision: 0,
  completed_work: [],
  decisions: ["decision-1"],
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
  last_run_id: "run-1",
  updated_at: stamp,
};
const request = {
  schema_version: 1,
  decision_id: "decision-1",
  case_id: "case-1",
  question: "Choose",
  why_now: "Needed",
  options: [
    { id: "safe", label: "Safe", consequences: "Slow" },
    { id: "fast", label: "Fast", consequences: "Risky" },
  ],
  recommendation: "safe",
  blocked_scope: "implementation",
  checkpoint_revision: 1,
};
const answer = {
  schema_version: 1,
  decision_id: "decision-1",
  case_id: "case-1",
  checkpoint_revision: 1,
  selected_option_id: "safe",
  answered_by: "owner-1",
  answered_at: stamp,
  answerId: "answer-1",
};

it("rebuilds RESUME_QUEUED from JSON durable facts without session state", () => {
  const snapshot = {
    case: {
      caseId: "case-1",
      ownerId: "owner-1",
      status: "PLANNING",
      integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
      discordThreadId: "thread-1",
      activeRunId: null,
      checkpointRevision: 1,
    },
    bindings: [{ connectionId: "conn-1", provider: "jira" }],
    checkpoint,
    activeRun: null,
    checkpointCompletion: {
      state: "CONFIRMED",
      value: {
        completionId: "completion-1",
        runId: "run-1",
        caseId: "case-1",
        status: "WAITING_FOR_USER",
        completion: {
          schema_version: 1,
          run_id: "run-1",
          case_id: "case-1",
          status: "WAITING_FOR_USER",
          summary: "waiting",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
          decision_request: request,
        },
        recordedAt: stamp,
      },
    },
    decisions: [{ request, answer }],
    resumeJobs: [
      {
        jobId: "job-1",
        status: "PENDING",
        payload: {
          answerId: "answer-1",
          decisionId: "decision-1",
          caseId: "case-1",
          checkpointRevision: 1,
        },
        createdAt: stamp,
      },
    ],
  };
  const roundTripped = JSON.parse(JSON.stringify(structuredClone(snapshot)));
  const plan = buildRecoveryPlan({
    snapshot: roundTripped,
    budgetBytes: 100_000,
    toolNames: ["jira.read"],
  });
  expect(plan).toMatchObject({
    status: "RESUME_QUEUED",
    automaticAction: { kind: "NONE" },
    resumeJob: { jobId: "job-1", answerId: "answer-1", decisionId: "decision-1" },
  });
  expect(JSON.stringify(roundTripped)).not.toContain("session");
  expect(JSON.stringify(roundTripped)).not.toContain("history");
});
