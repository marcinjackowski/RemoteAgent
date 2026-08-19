import { TrustLevel, type CaseCheckpoint } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";
import {
  CompletionPreparationError,
  CompletionPreparationErrorCode,
  prepareCompletion,
} from "../src/index.js";

const current = (): CaseCheckpoint => ({
  schema_version: 1,
  case_id: "case-1",
  revision: 3,
  goal: "goal",
  current_phase: "planning",
  summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "summary" },
  plan_revision: 1,
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
  updated_at: "2026-08-20T10:00:00Z",
});

const authority = {
  completionId: "completion-1",
  runId: "run-1",
  caseId: "case-1",
  expectedRevision: 3,
  finishedAt: "2026-08-20T11:00:00Z",
};
const completion = (status: string, extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  run_id: "run-1",
  case_id: "case-1",
  status,
  summary: "model summary",
  completed_steps: [],
  evidence: [],
  checkpoint_patch: {},
  next_actions: [],
  ...extra,
});

const expectPreparationError = (
  input: { completion: unknown; current: unknown; system: unknown },
  code: CompletionPreparationErrorCode,
) => {
  let thrown: unknown;
  try {
    prepareCompletion(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CompletionPreparationError);
  expect((thrown as CompletionPreparationError).code).toBe(code);
};

describe("prepareCompletion", () => {
  it.each(["CONTINUE", "WAITING_FOR_USER", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"])(
    "prepares %s with redacted deterministic output",
    (status) => {
      const input =
        status === "WAITING_FOR_USER"
          ? completion(status, {
              decision_request: {
                schema_version: 1,
                decision_id: "decision-1",
                case_id: "case-1",
                question: "choose",
                why_now: "now",
                options: [
                  { id: "a", label: "A", consequences: "a" },
                  { id: "b", label: "B", consequences: "b" },
                ],
                recommendation: "a",
                blocked_scope: "scope",
                checkpoint_revision: 3,
              },
            })
          : completion(
              status,
              status === "BLOCKED"
                ? { blocker_reason: "blocked" }
                : status === "FAILED"
                  ? { failure_reason: "failed" }
                  : status === "CANCELLED"
                    ? { cancellation_reason: "cancelled" }
                    : {},
            );
      const result = prepareCompletion({
        completion: input,
        current: current(),
        system: authority,
      });
      expect(result.checkpoint).toMatchObject({
        revision: 4,
        last_run_id: "run-1",
        updated_at: authority.finishedAt,
      });
      expect(result.runSafetyState).toBe(
        status === "FAILED" || status === "CANCELLED" ? "FAILED" : "SUCCEEDED",
      );
      expect(result.outbox).toEqual({
        aggregate: "case",
        aggregateId: "case-1",
        eventType: "agent.completion.recorded",
        payload: {
          completionId: "completion-1",
          runId: "run-1",
          caseId: "case-1",
          status,
          checkpointRevision: 4,
        },
      });
      expect(Object.keys(result.outbox.payload).sort()).toEqual([
        "caseId",
        "checkpointRevision",
        "completionId",
        "runId",
        "status",
      ]);
      const serializedOutbox = JSON.stringify(result.outbox);
      expect(serializedOutbox).not.toContain("summary");
      expect(serializedOutbox).not.toContain("decision_request");
      expect(serializedOutbox).not.toContain("checkpoint_patch");
    },
  );

  it("rejects completion run mismatch", () => {
    expectPreparationError(
      {
        completion: completion("CONTINUE", { run_id: "other" }),
        current: current(),
        system: authority,
      },
      CompletionPreparationErrorCode.MISMATCH,
    );
  });

  it("rejects completion case mismatch", () => {
    expectPreparationError(
      {
        completion: completion("CONTINUE", { case_id: "other" }),
        current: current(),
        system: authority,
      },
      CompletionPreparationErrorCode.MISMATCH,
    );
  });

  it("rejects current case mismatch", () => {
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: { ...current(), case_id: "other" },
        system: authority,
      },
      CompletionPreparationErrorCode.MISMATCH,
    );
  });

  it("rejects current revision mismatch", () => {
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: { ...current(), revision: 2 },
        system: authority,
      },
      CompletionPreparationErrorCode.MISMATCH,
    );
  });

  it("rejects invalid completion, authority and time", () => {
    expectPreparationError(
      { completion: { nope: true }, current: current(), system: authority },
      CompletionPreparationErrorCode.INVALID_COMPLETION,
    );
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: current(),
        system: { ...authority, completionId: "" },
      },
      CompletionPreparationErrorCode.INVALID_SYSTEM_AUTHORITY,
    );
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: current(),
        system: { ...authority, finishedAt: "bad" },
      },
      CompletionPreparationErrorCode.INVALID_SYSTEM_AUTHORITY,
    );
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: current(),
        system: { ...authority, expectedRevision: 1.5 },
      },
      CompletionPreparationErrorCode.INVALID_SYSTEM_AUTHORITY,
    );
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: current(),
        system: { ...authority, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      },
      CompletionPreparationErrorCode.INVALID_SYSTEM_AUTHORITY,
    );
  });

  it("rejects an invalid current checkpoint", () => {
    expectPreparationError(
      {
        completion: completion("CONTINUE"),
        current: { ...current(), revision: -1 },
        system: authority,
      },
      CompletionPreparationErrorCode.CHECKPOINT_APPLICATION,
    );
  });

  it("rejects a valid completion whose patch overflows an append field", () => {
    expectPreparationError(
      {
        completion: completion("CONTINUE", {
          checkpoint_patch: { completed_work_append: ["x", "x"] },
        }),
        current: { ...current(), completed_work: Array.from({ length: 1023 }, () => "x") },
        system: authority,
      },
      CompletionPreparationErrorCode.INVALID_FINAL_RESULT,
    );
  });

  it("does not mutate input and is deterministic", () => {
    const input = {
      completion: completion("COMPLETED", {
        summary: "secret",
        checkpoint_patch: { next_actions: ["x"] },
      }),
      current: current(),
      system: authority,
    };
    const before = structuredClone(input);
    expect(prepareCompletion(input)).toEqual(prepareCompletion(input));
    expect(input).toEqual(before);
  });
});
