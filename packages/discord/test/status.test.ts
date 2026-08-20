import { describe, expect, it } from "vitest";

import { MAX_MESSAGE_LENGTH } from "../src/sanitize.js";
import {
  projectCheckpointStatus,
  renderStatusMessage,
  StatusProjectionError,
} from "../src/status.js";

function checkpoint(): Record<string, unknown> {
  return {
    schema_version: 1,
    case_id: "case-1",
    revision: 4,
    goal: "Ship",
    current_phase: "PLANNING",
    summary: { trust: "UNTRUSTED_DATA", value: "Ready" },
    plan_revision: 1,
    completed_work: [],
    decisions: [],
    assumptions: [],
    evidence: [],
    open_questions: ["Q"],
    next_actions: ["A"],
    blockers: ["B"],
    pending_approvals: ["P"],
    workspace_state: { tree_digest: null, base_sha: null },
    branch_state: { branch_name: null, ahead: 1, behind: 2 },
    test_runs: [],
    snapshot_changes: [],
    review_findings: [],
    merge_request_state: { mr_ref: null, status: null },
    external_state_versions: [],
    last_event_id: null,
    last_run_id: null,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("projectCheckpointStatus", () => {
  it("maps a valid checkpoint and copies arrays", () => {
    const original = checkpoint();
    const references = [
      original.open_questions,
      original.next_actions,
      original.blockers,
      original.pending_approvals,
    ];
    const projection = projectCheckpointStatus({
      checkpoint: deepFreeze(original),
      status: "IMPLEMENTING",
    });
    expect(projection).toEqual({
      caseId: "case-1",
      status: "IMPLEMENTING",
      goal: "Ship",
      currentPhase: "PLANNING",
      summary: "Ready",
      openQuestions: ["Q"],
      nextActions: ["A"],
      blockers: ["B"],
      pendingApprovals: ["P"],
      checkpointRevision: 4,
    });
    expect(projection.openQuestions).not.toBe(references[0]);
    expect(projection.nextActions).not.toBe(references[1]);
    expect(projection.blockers).not.toBe(references[2]);
    expect(projection.pendingApprovals).not.toBe(references[3]);
  });

  it("rejects invalid, extra, and oversized status input without mutation", () => {
    const input = { checkpoint: checkpoint(), status: "OK" };
    const before = structuredClone(input);
    expect(projectCheckpointStatus(input)).toEqual(expect.objectContaining({ caseId: "case-1" }));
    expect(input).toEqual(before);
    expect(() => projectCheckpointStatus({ ...input, extra: true })).toThrow(StatusProjectionError);
    expect(() => projectCheckpointStatus({ ...input, status: "x".repeat(65) })).toThrow(
      StatusProjectionError,
    );
    expect(() =>
      projectCheckpointStatus({ ...input, checkpoint: { ...checkpoint(), extra: true } }),
    ).toThrow(StatusProjectionError);
  });
});

describe("renderStatusMessage", () => {
  it("renders a compact, size-bounded projection of the checkpoint", () => {
    const body = renderStatusMessage({
      caseId: "case-1",
      status: "IMPLEMENTING",
      goal: "Ship the widget",
      currentPhase: "coding",
      summary: "Wired the adapter.",
      openQuestions: ["Which timezone?"],
      nextActions: ["Add tests"],
      blockers: [],
      pendingApprovals: ["push branch"],
      checkpointRevision: 12,
    });
    expect(body).toContain("case-1");
    expect(body).toContain("IMPLEMENTING");
    expect(body).toContain("rev 12");
    expect(body).toContain("Which timezone?");
    expect(body).toContain("Add tests");
    expect(body).toContain("push branch");
    // Empty sections are omitted.
    expect(body).not.toContain("Blockers");
    expect(body.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it("neutralizes mass mentions embedded in checkpoint text", () => {
    const body = renderStatusMessage({
      caseId: "c",
      status: "NEW",
      goal: "@everyone ship",
      currentPhase: "triage",
      summary: "",
      openQuestions: [],
      nextActions: [],
      blockers: [],
      pendingApprovals: [],
      checkpointRevision: 0,
    });
    expect(body).not.toMatch(/@everyone/);
  });

  it("redacts secrets and remains bounded", () => {
    const body = renderStatusMessage({
      caseId: "c",
      status: "NEW",
      goal: "Bearer abc api_key=secret password=hunter2",
      currentPhase: "triage",
      summary: "@everyone",
      openQuestions: ["x".repeat(3000)],
      nextActions: [],
      blockers: [],
      pendingApprovals: [],
      checkpointRevision: 0,
    });
    expect(body).not.toContain("abc");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("@everyone");
    expect(body.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(body).toContain("… (truncated)");
    try {
      projectCheckpointStatus({ checkpoint: { canary: "secret" }, status: "OK" });
      throw new Error("expected invalid projection");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});
