/**
 * Pinned case-status projection (RA-006).
 *
 * The authoritative case state lives in the checkpoint JSON (Master Plan §5.3);
 * the pinned Discord message is a human-readable PROJECTION of it, never a source
 * of truth. This module renders a compact, size-bounded markdown summary that the
 * dispatcher upserts (create-then-edit) into the case thread's pinned message, so
 * a case always shows its current phase, goal, open questions and blockers at a
 * glance. All rendered text is treated as untrusted and sanitized.
 */
import { sanitizeSingle } from "./sanitize.js";
import { caseCheckpoint } from "@remoteagent/contracts";
import { SecretRedactor } from "@remoteagent/observability";
import * as z from "zod";

const redactor = new SecretRedactor();

export interface CaseStatusProjection {
  caseId: string;
  status: string;
  goal: string;
  currentPhase: string;
  summary: string;
  openQuestions: readonly string[];
  nextActions: readonly string[];
  blockers: readonly string[];
  pendingApprovals: readonly string[];
  checkpointRevision: number;
}

export const StatusProjectionErrorCode = {
  INVALID_INPUT: "INVALID_INPUT",
} as const;
export type StatusProjectionErrorCode =
  (typeof StatusProjectionErrorCode)[keyof typeof StatusProjectionErrorCode];

export class StatusProjectionError extends Error {
  public constructor(
    message: string,
    public readonly code: StatusProjectionErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StatusProjectionError";
  }
}

const statusInput = z.strictObject({
  checkpoint: z.unknown(),
  status: z.string().trim().min(1).max(64),
});

export function projectCheckpointStatus(input: unknown): CaseStatusProjection {
  const inputResult = statusInput.safeParse(input);
  if (!inputResult.success) {
    throw new StatusProjectionError(
      "Status projection input is invalid",
      StatusProjectionErrorCode.INVALID_INPUT,
    );
  }
  const checkpointResult = caseCheckpoint.safeParse(inputResult.data.checkpoint);
  if (!checkpointResult.success) {
    throw new StatusProjectionError(
      "Status projection checkpoint is invalid",
      StatusProjectionErrorCode.INVALID_INPUT,
    );
  }
  const checkpoint = checkpointResult.data;
  return {
    caseId: checkpoint.case_id,
    status: inputResult.data.status,
    goal: checkpoint.goal,
    currentPhase: checkpoint.current_phase,
    summary: checkpoint.summary.value,
    openQuestions: [...checkpoint.open_questions],
    nextActions: [...checkpoint.next_actions],
    blockers: [...checkpoint.blockers],
    pendingApprovals: [...checkpoint.pending_approvals],
    checkpointRevision: checkpoint.revision,
  };
}

/** Render the pinned status message body (already sanitized and size-bounded). */
export function renderStatusMessage(projection: CaseStatusProjection): string {
  const safe = (value: string): string => redactor.redactString(value);
  const lines: string[] = [
    `**Case ${safe(projection.caseId)}** — \`${safe(projection.status)}\` (rev ${projection.checkpointRevision})`,
    `**Phase:** ${safe(projection.currentPhase)}`,
    `**Goal:** ${safe(projection.goal)}`,
  ];
  if (projection.summary.trim().length > 0) {
    lines.push("", safe(projection.summary).trim());
  }
  appendSection(lines, "Open questions", projection.openQuestions, safe);
  appendSection(lines, "Next actions", projection.nextActions, safe);
  appendSection(lines, "Blockers", projection.blockers, safe);
  appendSection(lines, "Pending approvals", projection.pendingApprovals, safe);
  return sanitizeSingle(lines.join("\n"));
}

function appendSection(
  lines: string[],
  title: string,
  items: readonly string[],
  safe: (value: string) => string,
): void {
  if (items.length === 0) return;
  lines.push("", `**${title}:**`);
  for (const item of items) {
    lines.push(`• ${safe(item)}`);
  }
}
