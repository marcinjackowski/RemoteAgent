import { describe, expect, it } from "vitest";

import { MAX_MESSAGE_LENGTH } from "../src/sanitize.js";
import { renderStatusMessage } from "../src/status.js";

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
});
