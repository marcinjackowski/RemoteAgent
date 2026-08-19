import { TrustLevel, type CaseCheckpoint } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";
import {
  applyCheckpointPatch,
  CheckpointPatchError,
  CheckpointPatchErrorCode,
} from "../src/index.js";

const base = (): CaseCheckpoint => ({
  schema_version: 1,
  case_id: "case-1",
  revision: 4,
  goal: "Ship safely",
  current_phase: "implementation",
  summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "old" },
  plan_revision: 6,
  completed_work: ["one"],
  decisions: ["decision-1"],
  assumptions: ["assumption-1"],
  evidence: [{ kind: "test", reference: "evidence-1", summary: "green" }],
  open_questions: ["old question"],
  next_actions: ["old action"],
  blockers: ["old blocker"],
  pending_approvals: ["approval-1"],
  workspace_state: { tree_digest: null, base_sha: null },
  branch_state: { branch_name: "main", ahead: 0, behind: 0 },
  test_runs: [],
  snapshot_changes: ["snapshot"],
  review_findings: ["finding"],
  merge_request_state: { mr_ref: null, status: null },
  external_state_versions: [{ entity_ref: "entity-1", version: "v1" }],
  last_event_id: "event-1",
  last_run_id: "run-1",
  updated_at: "2026-08-20T10:00:00.000Z",
});

const expectCode = (call: () => unknown, code: string) => {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CheckpointPatchError);
  expect((thrown as CheckpointPatchError).code).toBe(code);
};

describe("applyCheckpointPatch", () => {
  it("applies replacements and ordered append-only fields without mutating input", () => {
    const current = base();
    const patch = {
      current_phase: "verification",
      summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "new" },
      completed_work_append: ["two", "two"],
      assumptions_append: ["assumption-2"],
      evidence_append: [{ kind: "test", reference: "evidence-1" }],
      open_questions: [],
      next_actions: ["new action"],
      blockers: [],
    };
    const currentBefore = structuredClone(current);
    const patchBefore = structuredClone(patch);
    const result = applyCheckpointPatch({ current, patch, updatedAt: "2026-08-20T11:00:00Z" });
    expect(result).toMatchObject({
      case_id: "case-1",
      revision: 5,
      plan_revision: 6,
      decisions: ["decision-1"],
      completed_work: ["one", "two", "two"],
      evidence: [
        { kind: "test", reference: "evidence-1", summary: "green" },
        { kind: "test", reference: "evidence-1" },
      ],
      open_questions: [],
      blockers: [],
      updated_at: "2026-08-20T11:00:00Z",
    });
    expect(current).toEqual(currentBefore);
    expect(patch).toEqual(patchBefore);
    result.evidence[0].summary = "changed output";
    expect(current.evidence[0].summary).toBe("green");
  });

  it("rejects an invalid current checkpoint", () => {
    expectCode(
      () =>
        applyCheckpointPatch({
          current: { ...base(), revision: -1 },
          patch: {},
          updatedAt: "2026-08-20T11:00:00Z",
        }),
      CheckpointPatchErrorCode.INVALID_CURRENT,
    );
  });

  it("rejects an invalid patch", () => {
    expectCode(
      () =>
        applyCheckpointPatch({
          current: base(),
          patch: { revision: 99 },
          updatedAt: "2026-08-20T11:00:00Z",
        }),
      CheckpointPatchErrorCode.INVALID_PATCH,
    );
  });

  it("preserves every current field when the patch is empty", () => {
    const current = base();
    const result = applyCheckpointPatch({
      current,
      patch: {},
      updatedAt: "2026-08-20T11:00:00Z",
    });
    const { revision } = current;
    const currentFields = { ...current };
    delete currentFields.revision;
    delete currentFields.updated_at;
    const { revision: resultRevision, updated_at: resultUpdatedAt, ...resultFields } = result;
    expect(resultFields).toEqual(currentFields);
    expect(resultRevision).toBe(revision + 1);
    expect(resultUpdatedAt).toBe("2026-08-20T11:00:00Z");
  });

  it("rejects authoritative overwrites and invalid system timestamps", () => {
    expectCode(
      () =>
        applyCheckpointPatch({
          current: base(),
          patch: { case_id: "other" },
          updatedAt: "2026-08-20T11:00:00Z",
        }),
      CheckpointPatchErrorCode.INVALID_PATCH,
    );
    expectCode(
      () => applyCheckpointPatch({ current: base(), patch: {}, updatedAt: "not-a-timestamp" }),
      CheckpointPatchErrorCode.INVALID_FINAL_RESULT,
    );
  });

  it("rejects combined append overflow without returning a partial result", () => {
    const current = { ...base(), completed_work: Array.from({ length: 1023 }, () => "x") };
    const currentBefore = structuredClone(current);
    const patch = { completed_work_append: ["x", "x"] };
    const patchBefore = structuredClone(patch);
    expectCode(
      () => applyCheckpointPatch({ current, patch, updatedAt: "2026-08-20T11:00:00Z" }),
      CheckpointPatchErrorCode.INVALID_FINAL_RESULT,
    );
    expect(current).toEqual(currentBefore);
    expect(patch).toEqual(patchBefore);
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      current: base(),
      patch: { completed_work_append: ["x"] },
      updatedAt: "2026-08-20T11:00:00Z",
    };
    expect(applyCheckpointPatch(input)).toEqual(applyCheckpointPatch(input));
  });
});
