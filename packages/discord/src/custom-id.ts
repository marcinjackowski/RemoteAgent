/**
 * Interaction `custom_id` encoding for decision / approval buttons (RA-006).
 *
 * A decision button MUST be bound to the exact decision id AND the checkpoint
 * revision it was raised at (acceptance criterion 5), so an owner clicking a
 * button that has since been superseded produces an answer the domain can reject
 * as stale (see `assertAnswerMatchesRequest` in @remoteagent/contracts). The
 * binding lives in the button's `custom_id`, which Discord echoes back verbatim
 * on click, so the mapping survives a bot restart with no server-side state.
 *
 * Discord limits a `custom_id` to {@link MAX_CUSTOM_ID_LENGTH} characters. Fields
 * are URI-encoded so an id containing the `:` delimiter cannot forge extra
 * fields, and an over-long id fails closed at build time rather than being
 * silently truncated into a different id.
 */

/** Discord's hard limit on interaction `custom_id` length. */
export const MAX_CUSTOM_ID_LENGTH = 100;

const VERSION = "v1";

export type InteractionKind = "decision" | "approval";

export interface DecisionInteraction {
  kind: "decision";
  decisionId: string;
  checkpointRevision: number;
  optionId: string;
}

export interface ApprovalInteraction {
  kind: "approval";
  approvalId: string;
  checkpointRevision: number;
  /** GRANT or DENY the exact action digest the approval was raised for. */
  choice: "grant" | "deny";
}

export type Interaction = DecisionInteraction | ApprovalInteraction;

export class CustomIdError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new CustomIdError(`checkpoint revision must be a non-negative integer: ${revision}`);
  }
}

/** Build the `custom_id` for a decision button bound to (id, revision, option). */
export function encodeDecision(input: {
  decisionId: string;
  checkpointRevision: number;
  optionId: string;
}): string {
  assertRevision(input.checkpointRevision);
  return finalize([
    VERSION,
    "decision",
    input.decisionId,
    String(input.checkpointRevision),
    input.optionId,
  ]);
}

/** Build the `custom_id` for an approval button bound to (id, revision, choice). */
export function encodeApproval(input: {
  approvalId: string;
  checkpointRevision: number;
  choice: "grant" | "deny";
}): string {
  assertRevision(input.checkpointRevision);
  return finalize([
    VERSION,
    "approval",
    input.approvalId,
    String(input.checkpointRevision),
    input.choice,
  ]);
}

/**
 * Parse a `custom_id` received from a Discord interaction. Returns `null` for any
 * id this module did not produce (unknown version/kind, wrong shape, malformed
 * fields) so intake can ignore foreign or tampered interactions fail-closed.
 */
export function decodeInteraction(customId: string): Interaction | null {
  const parts = customId.split(":");
  if (parts.length !== 5) return null;
  const [version, kind, rawId, rawRevision, rawTail] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION) return null;

  const id = safeDecode(rawId);
  const tail = safeDecode(rawTail);
  if (id === null || tail === null) return null;

  const revision = Number(rawRevision);
  if (!Number.isInteger(revision) || revision < 0 || String(revision) !== rawRevision) {
    return null;
  }

  if (kind === "decision") {
    if (id.length === 0 || tail.length === 0) return null;
    return { kind: "decision", decisionId: id, checkpointRevision: revision, optionId: tail };
  }
  if (kind === "approval") {
    if (id.length === 0 || (tail !== "grant" && tail !== "deny")) return null;
    return { kind: "approval", approvalId: id, checkpointRevision: revision, choice: tail };
  }
  return null;
}

function finalize(fields: readonly string[]): string {
  const encoded = fields.map((field) => encodeURIComponent(field)).join(":");
  if (encoded.length > MAX_CUSTOM_ID_LENGTH) {
    throw new CustomIdError(
      `custom_id exceeds ${MAX_CUSTOM_ID_LENGTH} characters (${encoded.length}); shorten the id`,
    );
  }
  return encoded;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
