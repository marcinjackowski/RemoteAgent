import { describe, expect, it } from "vitest";

import {
  CustomIdError,
  MAX_CUSTOM_ID_LENGTH,
  decodeInteraction,
  encodeApproval,
  encodeDecision,
  encodeEngineeringProposal,
} from "../src/custom-id.js";

describe("custom-id (decision/approval button binding)", () => {
  it("binds a decision button to decision id, checkpoint revision and option", () => {
    const customId = encodeDecision({
      decisionId: "dec-1",
      checkpointRevision: 7,
      optionId: "opt-a",
    });
    const decoded = decodeInteraction(customId);
    expect(decoded).toEqual({
      kind: "decision",
      decisionId: "dec-1",
      checkpointRevision: 7,
      optionId: "opt-a",
    });
  });

  it("round-trips ids containing the delimiter without forging fields", () => {
    const customId = encodeDecision({
      decisionId: "a:b:c",
      checkpointRevision: 0,
      optionId: "x:y",
    });
    // Delimiter count is fixed at 4 even though ids contain ':'.
    expect(customId.split(":").length).toBe(5);
    expect(decodeInteraction(customId)).toEqual({
      kind: "decision",
      decisionId: "a:b:c",
      checkpointRevision: 0,
      optionId: "x:y",
    });
  });

  it("binds an approval button to id, revision and grant/deny choice", () => {
    const grant = decodeInteraction(
      encodeApproval({ approvalId: "ap-9", checkpointRevision: 3, choice: "grant" }),
    );
    expect(grant).toEqual({
      kind: "approval",
      approvalId: "ap-9",
      checkpointRevision: 3,
      choice: "grant",
    });
  });

  it("uses a distinct engineering proposal kind bound to proposal/revision/choice", () => {
    const customId = encodeEngineeringProposal({
      proposalId: "proposal-9",
      checkpointRevision: 3,
      choice: "grant",
    });
    expect(customId).toBe("v1:engineering:proposal-9:3:grant");
    expect(decodeInteraction(customId)).toEqual({
      kind: "engineering",
      proposalId: "proposal-9",
      checkpointRevision: 3,
      choice: "grant",
    });
    expect(decodeInteraction(customId)).not.toMatchObject({ kind: "approval" });
  });

  it("rejects a foreign or tampered custom_id fail-closed (returns null)", () => {
    expect(decodeInteraction("random")).toBeNull();
    expect(decodeInteraction("v2:decision:dec:1:opt")).toBeNull(); // wrong version
    expect(decodeInteraction("v1:decision:dec:-1:opt")).toBeNull(); // bad revision
    expect(decodeInteraction("v1:decision:dec:1.5:opt")).toBeNull(); // non-integer
    expect(decodeInteraction("v1:decision::1:opt")).toBeNull(); // empty id
    expect(decodeInteraction("v1:approval:ap:1:maybe")).toBeNull(); // bad choice
    expect(decodeInteraction("v1:engineering:proposal:1:maybe")).toBeNull();
    expect(decodeInteraction("v1:other:x:1:y")).toBeNull(); // unknown kind
  });

  it("fails closed when the encoded id would exceed the Discord limit", () => {
    expect(() =>
      encodeDecision({ decisionId: "d".repeat(200), checkpointRevision: 1, optionId: "o" }),
    ).toThrow(CustomIdError);
  });

  it("rejects a negative or non-integer revision at build time", () => {
    expect(() =>
      encodeDecision({ decisionId: "d", checkpointRevision: -1, optionId: "o" }),
    ).toThrow(CustomIdError);
    expect(() =>
      encodeApproval({ approvalId: "a", checkpointRevision: 1.2, choice: "deny" }),
    ).toThrow(CustomIdError);
  });

  it("keeps a normal custom_id within the Discord length limit", () => {
    const customId = encodeApproval({ approvalId: "ap-1", checkpointRevision: 12, choice: "deny" });
    expect(customId.length).toBeLessThanOrEqual(MAX_CUSTOM_ID_LENGTH);
  });
});
