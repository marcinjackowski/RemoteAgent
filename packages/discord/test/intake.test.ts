import { describe, expect, it } from "vitest";

import { ChannelRegistry } from "../src/channels.js";
import { encodeApproval, encodeDecision, encodeEngineeringProposal } from "../src/custom-id.js";
import { handleInbound, type InboundInteraction } from "../src/intake.js";

function registry(): ChannelRegistry {
  return new ChannelRegistry({
    guildId: "guild-1",
    ownerId: "owner-1",
    channels: {
      jira: "c-jira",
      "gmail-private": "c-gmail-priv",
      "gmail-sondermind": "c-gmail-sm",
      "calendar-private": "c-cal-priv",
      "calendar-sondermind": "c-cal-sm",
      gitlab: "c-gitlab",
      system: "c-system",
    },
  });
}

const threadCase = (map: Record<string, string>) => (threadId: string) =>
  Promise.resolve(map[threadId] ?? null);

const owner = { guildId: "guild-1", userId: "owner-1" } as const;

describe("handleInbound", () => {
  it("routes an owner message in a case thread and marks it UNTRUSTED_DATA", async () => {
    const interaction: InboundInteraction = {
      type: "message",
      ...owner,
      origin: { surface: "thread", threadId: "t-1" },
      content: "please rebase",
    };
    expect(await handleInbound(registry(), interaction, threadCase({ "t-1": "case-1" }))).toEqual({
      kind: "message",
      caseId: "case-1",
      content: "please rebase",
      trust: "UNTRUSTED_DATA",
    });
  });

  it("denies an unauthorized message without leaking content", async () => {
    const interaction: InboundInteraction = {
      type: "message",
      guildId: "guild-1",
      userId: "intruder",
      origin: { surface: "thread", threadId: "t-1" },
      content: "secret probe text",
    };
    const outcome = await handleInbound(registry(), interaction, threadCase({ "t-1": "case-1" }));
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      expect(JSON.stringify(outcome.audit)).not.toContain("secret probe text");
    }
  });

  it("scopes /stop to exactly the case whose thread it was invoked in (criterion 6)", async () => {
    const stopInThread: InboundInteraction = {
      type: "command",
      ...owner,
      origin: { surface: "thread", threadId: "t-2" },
      command: "stop",
      interactionId: "interaction-stop",
    };
    expect(await handleInbound(registry(), stopInThread, threadCase({ "t-2": "case-2" }))).toEqual({
      kind: "stop",
      caseId: "case-2",
      actorId: "owner-1",
      interactionId: "interaction-stop",
    });

    // /stop in a top-level channel has no single case target → ignored, never a
    // broadcast stop.
    const stopInChannel: InboundInteraction = {
      type: "command",
      ...owner,
      origin: { surface: "channel", channelId: "c-jira" },
      command: "stop",
      interactionId: "interaction-stop-channel",
    };
    const outcome = await handleInbound(registry(), stopInChannel, threadCase({}));
    expect(outcome).toEqual({ kind: "ignored", reason: "stop_requires_case_thread" });
  });

  it("decodes a decision button bound to the case, decision id and revision (criterion 5)", async () => {
    const interaction: InboundInteraction = {
      type: "button",
      ...owner,
      origin: { surface: "thread", threadId: "t-1" },
      customId: encodeDecision({ decisionId: "dec-9", checkpointRevision: 4, optionId: "opt-b" }),
      interactionId: "interaction-decision",
    };
    expect(await handleInbound(registry(), interaction, threadCase({ "t-1": "case-1" }))).toEqual({
      kind: "decision",
      caseId: "case-1",
      actorId: "owner-1",
      interactionId: "interaction-decision",
      interaction: {
        kind: "decision",
        decisionId: "dec-9",
        checkpointRevision: 4,
        optionId: "opt-b",
      },
    });
  });

  it("decodes an approval button choice", async () => {
    const interaction: InboundInteraction = {
      type: "button",
      ...owner,
      origin: { surface: "thread", threadId: "t-1" },
      customId: encodeApproval({ approvalId: "ap-2", checkpointRevision: 1, choice: "deny" }),
      interactionId: "interaction-approval",
    };
    const outcome = await handleInbound(registry(), interaction, threadCase({ "t-1": "case-1" }));
    expect(outcome).toEqual({
      kind: "approval",
      caseId: "case-1",
      actorId: "owner-1",
      interactionId: "interaction-approval",
      interaction: { kind: "approval", approvalId: "ap-2", checkpointRevision: 1, choice: "deny" },
    });
  });

  it("routes code-owned /engineering and proposal buttons with durable interaction identity", async () => {
    const create: InboundInteraction = {
      type: "command",
      ...owner,
      origin: { surface: "thread", threadId: "t-1" },
      command: "engineering",
      interactionId: "interaction-create",
    };
    expect(await handleInbound(registry(), create, threadCase({ "t-1": "case-1" }))).toEqual({
      kind: "engineering_proposal",
      caseId: "case-1",
      actorId: "owner-1",
      interactionId: "interaction-create",
    });

    const click: InboundInteraction = {
      type: "button",
      ...owner,
      origin: { surface: "thread", threadId: "t-1" },
      customId: encodeEngineeringProposal({
        proposalId: "proposal-1",
        checkpointRevision: 4,
        choice: "deny",
      }),
      interactionId: "interaction-click",
    };
    expect(await handleInbound(registry(), click, threadCase({ "t-1": "case-1" }))).toEqual({
      kind: "engineering",
      caseId: "case-1",
      actorId: "owner-1",
      interactionId: "interaction-click",
      interaction: {
        kind: "engineering",
        proposalId: "proposal-1",
        checkpointRevision: 4,
        choice: "deny",
      },
    });
  });

  it("ignores an unrecognized or tampered button custom_id fail-closed", async () => {
    const interaction: InboundInteraction = {
      type: "button",
      ...owner,
      origin: { surface: "thread", threadId: "t-1" },
      customId: "v9:decision:dec:1:opt",
      interactionId: "interaction-tampered",
    };
    expect(await handleInbound(registry(), interaction, threadCase({ "t-1": "case-1" }))).toEqual({
      kind: "ignored",
      reason: "unrecognized_custom_id",
    });
  });
});
