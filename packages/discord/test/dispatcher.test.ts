import { describe, expect, it } from "vitest";

import { decodeInteraction } from "../src/custom-id.js";
import { discordButtonsForThreadMessage } from "../src/dispatcher.js";

describe("engineering proposal dispatcher buttons", () => {
  it("renders only the separate code-owned GRANT/DENY proposal interactions", () => {
    const buttons = discordButtonsForThreadMessage({
      case_id: "case-1",
      seq: 1,
      body: "Server-owned engineering proposal",
      engineering_proposal: { proposal_id: "proposal-1", checkpoint_revision: 7 },
    });
    expect(buttons.map(({ label, style }) => ({ label, style }))).toEqual([
      { label: "GRANT", style: "success" },
      { label: "DENY", style: "danger" },
    ]);
    expect(buttons.map((button) => decodeInteraction(button.customId))).toEqual([
      {
        kind: "engineering",
        proposalId: "proposal-1",
        checkpointRevision: 7,
        choice: "grant",
      },
      {
        kind: "engineering",
        proposalId: "proposal-1",
        checkpointRevision: 7,
        choice: "deny",
      },
    ]);
  });

  it("refuses mixed decision/approval/engineering button authority fail-closed", () => {
    expect(() =>
      discordButtonsForThreadMessage({
        case_id: "case-1",
        seq: 1,
        body: "Conflicting controls",
        decision: {
          decision_id: "decision-1",
          checkpoint_revision: 7,
          options: [
            { option_id: "a", label: "A" },
            { option_id: "b", label: "B" },
          ],
        },
        engineering_proposal: { proposal_id: "proposal-1", checkpoint_revision: 7 },
      }),
    ).toThrow(/at most one interactive button section/);
  });
});
