/**
 * `CaseCheckpoint` (Master Plan §5.3).
 *
 * The JSON checkpoint in the DB is the source of truth; Markdown and the pinned
 * Discord message are read projections. A checkpoint is immutable per revision:
 * a new revision supersedes the previous one. All external-derived summaries are
 * carried as untrusted content.
 */
import * as z from "zod";

import { idString, isoTimestamp, label, text, valueObject, versionedContract } from "./common.js";
import { TrustLevel } from "./trust.js";

const evidenceItem = valueObject({
  kind: label,
  reference: idString,
  summary: text.optional(),
});

const testRun = valueObject({
  command: text,
  exit_code: z.int(),
  summary: text,
  ran_at: isoTimestamp,
});

const externalStateVersion = valueObject({
  entity_ref: idString,
  version: idString,
});

/**
 * Summary text that embeds external-derived content. The trust marker is a fixed
 * literal `UNTRUSTED_DATA`: neither the model (via `checkpointPatch.summary`) nor
 * persisted external-derived state may relabel the content as `TRUSTED`. Trust is
 * assigned by the boundary, not chosen by the sender. If deterministic
 * system-authored trusted text is ever needed, it must use a separate,
 * system-only contract — never this input boundary.
 */
const untrustedSummary = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: text,
});

export const caseCheckpoint = versionedContract({
  case_id: idString,
  revision: z.int().nonnegative(),
  goal: text,
  current_phase: label,
  summary: untrustedSummary,
  plan_revision: z.int().nonnegative(),
  completed_work: z.array(text).max(1024).default([]),
  decisions: z.array(idString).max(1024).default([]),
  assumptions: z.array(text).max(1024).default([]),
  evidence: z.array(evidenceItem).max(1024).default([]),
  open_questions: z.array(text).max(1024).default([]),
  next_actions: z.array(text).max(1024).default([]),
  blockers: z.array(text).max(1024).default([]),
  pending_approvals: z.array(idString).max(256).default([]),
  workspace_state: valueObject({
    tree_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    base_sha: idString.nullable().default(null),
  }),
  branch_state: valueObject({
    branch_name: idString.nullable().default(null),
    ahead: z.int().nonnegative().default(0),
    behind: z.int().nonnegative().default(0),
  }),
  test_runs: z.array(testRun).max(256).default([]),
  snapshot_changes: z.array(text).max(1024).default([]),
  review_findings: z.array(text).max(1024).default([]),
  merge_request_state: valueObject({
    mr_ref: idString.nullable().default(null),
    status: label.nullable().default(null),
  }),
  external_state_versions: z.array(externalStateVersion).max(256).default([]),
  last_event_id: idString.nullable().default(null),
  last_run_id: idString.nullable().default(null),
  updated_at: isoTimestamp,
});

export type CaseCheckpoint = z.infer<typeof caseCheckpoint>;

/**
 * A proposed patch to the checkpoint produced by a run. It is a partial set of
 * mutable fields; deterministic code applies it to produce the next revision.
 * Model output can propose a patch but cannot itself bump the authoritative
 * revision.
 */
export const checkpointPatch = valueObject({
  summary: untrustedSummary.optional(),
  current_phase: label.optional(),
  completed_work_append: z.array(text).max(256).optional(),
  assumptions_append: z.array(text).max(256).optional(),
  evidence_append: z.array(evidenceItem).max(256).optional(),
  open_questions: z.array(text).max(256).optional(),
  next_actions: z.array(text).max(256).optional(),
  blockers: z.array(text).max(256).optional(),
});

export type CheckpointPatch = z.infer<typeof checkpointPatch>;
