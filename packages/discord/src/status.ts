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

/** Render the pinned status message body (already sanitized and size-bounded). */
export function renderStatusMessage(projection: CaseStatusProjection): string {
  const lines: string[] = [
    `**Case ${projection.caseId}** — \`${projection.status}\` (rev ${projection.checkpointRevision})`,
    `**Phase:** ${projection.currentPhase}`,
    `**Goal:** ${projection.goal}`,
  ];
  if (projection.summary.trim().length > 0) {
    lines.push("", projection.summary.trim());
  }
  appendSection(lines, "Open questions", projection.openQuestions);
  appendSection(lines, "Next actions", projection.nextActions);
  appendSection(lines, "Blockers", projection.blockers);
  appendSection(lines, "Pending approvals", projection.pendingApprovals);
  return sanitizeSingle(lines.join("\n"));
}

function appendSection(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push("", `**${title}:**`);
  for (const item of items) {
    lines.push(`• ${item}`);
  }
}
