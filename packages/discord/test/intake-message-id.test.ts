/**
 * RA-031 WU-04: handleInbound threads the Discord message id into the `message` outcome, so the
 * downstream inbound-message API can dedupe a redelivered gateway event.
 */
import { expect, it } from "vitest";

import { ChannelRegistry } from "../src/channels.js";
import { handleInbound } from "../src/intake.js";

const registry = new ChannelRegistry({
  guildId: "guild-1",
  ownerId: "owner-1",
  channels: {
    jira: "c-jira",
    "gmail-private": "c-gmp",
    "gmail-sondermind": "c-gms",
    "calendar-private": "c-cp",
    "calendar-sondermind": "c-cs",
    gitlab: "c-gl",
    system: "c-sys",
  },
});

it("carries messageId from an owner thread message into the outcome", async () => {
  const outcome = await handleInbound(
    registry,
    {
      type: "message",
      guildId: "guild-1",
      userId: "owner-1",
      origin: { surface: "thread", threadId: "t1" },
      content: "please retry",
      messageId: "disc-9",
    },
    async () => "case-1",
  );
  expect(outcome).toEqual({
    kind: "message",
    caseId: "case-1",
    content: "please retry",
    trust: "UNTRUSTED_DATA",
    messageId: "disc-9",
  });
});

it("omits messageId when the source event had none", async () => {
  const outcome = await handleInbound(
    registry,
    {
      type: "message",
      guildId: "guild-1",
      userId: "owner-1",
      origin: { surface: "thread", threadId: "t1" },
      content: "hi",
    },
    async () => "case-1",
  );
  expect(outcome).toEqual({
    kind: "message",
    caseId: "case-1",
    content: "hi",
    trust: "UNTRUSTED_DATA",
  });
});
