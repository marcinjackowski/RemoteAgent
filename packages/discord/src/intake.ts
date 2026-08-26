/**
 * Inbound Discord intake (RA-006).
 *
 * Normalizes raw inbound interactions (messages, `/stop` and `/engineering` commands, decision /
 * approval / engineering proposal button clicks) into typed, authorized intents the rest of the system
 * consumes. Authorization runs FIRST (see `authorization.ts`): an interaction
 * from the wrong guild/user/channel is turned into a content-free `denied`
 * outcome and never parsed further.
 *
 * Intake does not execute anything — it only resolves *what* the owner asked and
 * *which case* it applies to. In particular `/stop` resolves to exactly the one
 * case whose thread it was invoked in (acceptance criterion 6), and a button
 * click carries the decision/approval id AND the checkpoint revision decoded from
 * the button's `custom_id` (criterion 5), so a stale click can be rejected
 * downstream. All free-form owner text is marked UNTRUSTED_DATA.
 */
import type { ChannelRegistry } from "./channels.js";
import {
  authorizeInbound,
  deniedAudit,
  type DeniedAudit,
  type InboundContext,
  type ThreadCaseResolver,
} from "./authorization.js";
import { decodeInteraction, type Interaction } from "./custom-id.js";

export interface InboundMessage extends InboundContext {
  type: "message";
  content: string;
  /** The provider (Discord) message id, used downstream to dedupe redelivered gateway events. */
  messageId?: string;
}

export interface InboundCommand extends InboundContext {
  type: "command";
  /** The slash command name without the leading slash, e.g. "stop". */
  command: string;
  /** Provider interaction id; durable replay identity. Never the interaction token. */
  interactionId: string;
}

export interface InboundButton extends InboundContext {
  type: "button";
  customId: string;
  /** Provider interaction id; durable replay identity. Never the interaction token. */
  interactionId: string;
}

export type InboundInteraction = InboundMessage | InboundCommand | InboundButton;

export type IntakeOutcome =
  | { kind: "denied"; audit: DeniedAudit }
  | { kind: "ignored"; reason: string }
  | {
      kind: "message";
      caseId: string;
      content: string;
      trust: "UNTRUSTED_DATA";
      messageId?: string;
    }
  | { kind: "stop"; caseId: string; actorId: string; interactionId: string }
  | { kind: "engineering_proposal"; caseId: string; actorId: string; interactionId: string }
  | {
      kind: "decision";
      caseId: string;
      actorId: string;
      interactionId: string;
      interaction: Extract<Interaction, { kind: "decision" }>;
    }
  | {
      kind: "approval";
      caseId: string;
      actorId: string;
      interactionId: string;
      interaction: Extract<Interaction, { kind: "approval" }>;
    }
  | {
      kind: "engineering";
      caseId: string;
      actorId: string;
      interactionId: string;
      interaction: Extract<Interaction, { kind: "engineering" }>;
    };

export async function handleInbound(
  registry: ChannelRegistry,
  interaction: InboundInteraction,
  resolveThreadCase: ThreadCaseResolver,
): Promise<IntakeOutcome> {
  const auth = await authorizeInbound(registry, interaction, resolveThreadCase);
  if (!auth.allowed) {
    return { kind: "denied", audit: deniedAudit(interaction, auth.reason) };
  }

  switch (interaction.type) {
    case "message": {
      if (auth.caseId === null) {
        // A message in a top-level channel (not a case thread) is not a case
        // conversation turn; ignore it deterministically.
        return { kind: "ignored", reason: "message_outside_case_thread" };
      }
      return {
        kind: "message",
        caseId: auth.caseId,
        content: interaction.content,
        trust: "UNTRUSTED_DATA",
        ...(interaction.messageId !== undefined ? { messageId: interaction.messageId } : {}),
      };
    }
    case "command": {
      if (interaction.command !== "stop" && interaction.command !== "engineering") {
        return { kind: "ignored", reason: `unknown_command:${interaction.command}` };
      }
      if (auth.caseId === null) {
        // `/stop` must target a specific case thread so it can never stop more
        // than the one case it was invoked in (criterion 6).
        return {
          kind: "ignored",
          reason:
            interaction.command === "stop"
              ? "stop_requires_case_thread"
              : "engineering_requires_case_thread",
        };
      }
      return interaction.command === "stop"
        ? {
            kind: "stop",
            caseId: auth.caseId,
            actorId: interaction.userId,
            interactionId: interaction.interactionId,
          }
        : {
            kind: "engineering_proposal",
            caseId: auth.caseId,
            actorId: interaction.userId,
            interactionId: interaction.interactionId,
          };
    }
    case "button": {
      if (auth.caseId === null) {
        return { kind: "ignored", reason: "button_outside_case_thread" };
      }
      const decoded = decodeInteraction(interaction.customId);
      if (decoded === null) {
        // Foreign, malformed or tampered custom_id: ignore fail-closed.
        return { kind: "ignored", reason: "unrecognized_custom_id" };
      }
      if (decoded.kind === "decision") {
        return {
          kind: "decision",
          caseId: auth.caseId,
          actorId: interaction.userId,
          interactionId: interaction.interactionId,
          interaction: decoded,
        };
      }
      if (decoded.kind === "approval") {
        return {
          kind: "approval",
          caseId: auth.caseId,
          actorId: interaction.userId,
          interactionId: interaction.interactionId,
          interaction: decoded,
        };
      }
      return {
        kind: "engineering",
        caseId: auth.caseId,
        actorId: interaction.userId,
        interactionId: interaction.interactionId,
        interaction: decoded,
      };
    }
    default: {
      const exhaustive: never = interaction;
      return { kind: "ignored", reason: `unknown_interaction:${String(exhaustive)}` };
    }
  }
}
