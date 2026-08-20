/**
 * Snapshot evidence: classify a snapshot change and gate its acceptance.
 *
 * A snapshot test is the easiest verification to defeat. The failure mode is not
 * a bug but a habit: the suite reports a mismatch, the fastest way to green is to
 * re-record, and nobody looks at what changed. Re-recording makes the *test* agree
 * with the code by construction, so an accepted snapshot with no reasoning is not
 * evidence of anything.
 *
 * **Criterion 3: a snapshot update carries a diff and a justification of the
 * expected change.** Enforced structurally, not by review convention:
 *
 * - {@link classifySnapshot} decides `UNCHANGED` / `CHANGED` / `NEW` / `REMOVED`
 *   from the actual bytes. A caller cannot declare a classification;
 * - {@link acceptSnapshotChange} is the ONLY producer of a
 *   {@link SnapshotAcceptance}, and it refuses without a substantive
 *   justification and refuses when the supplied diff does not match the bytes it
 *   claims to describe. So "approved" cannot be asserted — it has to be earned
 *   against the real content;
 * - an unreviewed change is representable and distinct. {@link SnapshotStatus}
 *   keeps `UNAPPROVED` as a first-class state, so "changed and nobody justified
 *   it" is a reportable condition rather than an absence of information.
 *
 * The diff is computed here, line-based and bounded. It exists to be *read*, so it
 * is deliberately small and redacted: snapshots routinely capture rendered output
 * containing absolute paths, and a diff is shown to a model and stored.
 */
import { createHash } from "node:crypto";

import { redactCommandOutput } from "@remoteagent/implementation-tools";
import { TrustLevel, idString, sha256Digest, text, valueObject } from "@remoteagent/contracts";
import * as z from "zod";

import { MAX_EXCERPT_BYTES, evidenceScope } from "./contracts.js";
import type { EvidenceScope } from "./contracts.js";

/** Maximum number of diff lines carried in an acceptance record. */
export const MAX_DIFF_LINES = 200;

/** Shortest justification that can be considered substantive. */
export const MIN_JUSTIFICATION_LENGTH = 20;

/** How a candidate snapshot relates to the recorded one. */
export const SnapshotStatus = {
  /** Byte-identical. Nothing to approve. */
  UNCHANGED: "UNCHANGED",
  /** Differs from the recorded snapshot. Requires justification to accept. */
  CHANGED: "CHANGED",
  /** No recorded snapshot exists yet. */
  NEW: "NEW",
  /** A recorded snapshot has no corresponding candidate. */
  REMOVED: "REMOVED",
} as const;

export type SnapshotStatus = (typeof SnapshotStatus)[keyof typeof SnapshotStatus];

export const snapshotStatus = z.enum([
  SnapshotStatus.UNCHANGED,
  SnapshotStatus.CHANGED,
  SnapshotStatus.NEW,
  SnapshotStatus.REMOVED,
]);

/** A snapshot change was rejected; the recorded snapshot stands. */
export const SNAPSHOT_JUSTIFICATION_REQUIRED = "JUSTIFICATION_REQUIRED";

/** The supplied diff does not describe the supplied content. */
export const SNAPSHOT_DIFF_MISMATCH = "DIFF_MISMATCH";

/** There is no change to accept. */
export const SNAPSHOT_NOTHING_TO_ACCEPT = "NOTHING_TO_ACCEPT";

export class SnapshotEvidenceError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "SnapshotEvidenceError";
    this.code = code;
  }
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * A classified snapshot comparison.
 *
 * Both digests are present so the classification can be re-checked by a reader
 * against the same inputs; `diff` is bounded and redacted for reading.
 */
export const snapshotComparison = valueObject({
  snapshot_id: idString,
  scope: evidenceScope,
  status: snapshotStatus,
  recorded_digest: sha256Digest.nullable(),
  candidate_digest: sha256Digest.nullable(),
  /** Unified-ish, line-based, bounded and redacted. Empty when UNCHANGED. */
  diff: valueObject({
    trust: z.literal(TrustLevel.UNTRUSTED_DATA),
    value: text,
    truncated: z.boolean(),
    /** Total differing lines, including any not carried in `value`. */
    changed_lines: z.int().nonnegative(),
  }),
});

export type SnapshotComparison = z.infer<typeof snapshotComparison>;

/**
 * Build a bounded, redacted, line-based diff.
 *
 * Not a minimal edit script: a snapshot diff is read by a human or a model to
 * answer "is this change expected?", and a positional line comparison answers that
 * legibly without the cost or the ambiguity of an LCS. Every carried line is
 * redacted, because snapshots capture rendered output full of host paths.
 */
function buildDiff(
  recorded: string | null,
  candidate: string | null,
  knownSecrets: readonly string[],
): { value: string; truncated: boolean; changedLines: number } {
  const before = recorded === null ? [] : recorded.split("\n");
  const after = candidate === null ? [] : candidate.split("\n");
  const lines: string[] = [];
  let changed = 0;

  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const left = before[index];
    const right = after[index];
    if (left === right) continue;
    changed += 1;
    if (lines.length < MAX_DIFF_LINES) {
      if (left !== undefined) lines.push(`-${redactCommandOutput(left, knownSecrets)}`);
      if (right !== undefined) lines.push(`+${redactCommandOutput(right, knownSecrets)}`);
    }
  }

  let value = lines.join("\n");
  let truncated = changed * 2 > lines.length;
  if (byteLength(value) > MAX_EXCERPT_BYTES) {
    // Bound bytes as well as lines: one pathological line can exceed the budget.
    value = value.slice(0, MAX_EXCERPT_BYTES);
    truncated = true;
  }
  return { value, truncated, changedLines: changed };
}

/**
 * Classify a candidate against the recorded snapshot, from the bytes alone.
 *
 * `null` means absent on that side, which is how `NEW` and `REMOVED` are
 * distinguished from a content change rather than being collapsed into it.
 */
export function classifySnapshot(input: {
  readonly snapshot_id: string;
  readonly scope: EvidenceScope;
  readonly recorded: string | null;
  readonly candidate: string | null;
  readonly knownSecrets?: readonly string[];
}): SnapshotComparison {
  const { recorded, candidate } = input;
  const knownSecrets = input.knownSecrets ?? [];

  const status =
    recorded === null && candidate === null
      ? SnapshotStatus.UNCHANGED
      : recorded === null
        ? SnapshotStatus.NEW
        : candidate === null
          ? SnapshotStatus.REMOVED
          : recorded === candidate
            ? SnapshotStatus.UNCHANGED
            : SnapshotStatus.CHANGED;

  const diff =
    status === SnapshotStatus.UNCHANGED
      ? { value: "", truncated: false, changedLines: 0 }
      : buildDiff(recorded, candidate, knownSecrets);

  return snapshotComparison.parse({
    snapshot_id: input.snapshot_id,
    scope: input.scope,
    status,
    recorded_digest: recorded === null ? null : sha256(recorded),
    candidate_digest: candidate === null ? null : sha256(candidate),
    diff: {
      trust: TrustLevel.UNTRUSTED_DATA,
      value: diff.value,
      truncated: diff.truncated,
      changed_lines: diff.changedLines,
    },
  });
}

/**
 * A recorded, justified acceptance of a snapshot change.
 *
 * Obtainable only from {@link acceptSnapshotChange}. `comparison` carries the
 * digests the decision was made against, so an acceptance cannot be re-used for
 * different content: a later reader recomputes the candidate digest and sees the
 * mismatch.
 */
export const snapshotAcceptance = valueObject({
  comparison: snapshotComparison,
  /** Why the new output is the expected output. Substance is enforced. */
  justification: z.string().min(MIN_JUSTIFICATION_LENGTH).max(4096),
  /** Digest of the accepted candidate; binds the approval to exact bytes. */
  accepted_digest: sha256Digest,
});

export type SnapshotAcceptance = z.infer<typeof snapshotAcceptance>;

/** Justifications that are present but say nothing. */
const EMPTY_JUSTIFICATIONS: readonly string[] = Object.freeze([
  "ok",
  "fine",
  "lgtm",
  "updated",
  "update snapshot",
  "update snapshots",
  "re-record",
  "rerecord",
  "regenerated",
  "expected",
  "as expected",
  "no reason",
  "n/a",
  "na",
  "-",
  "wip",
  "fix",
  "fixed",
  "snapshot",
  "snapshots",
  "accept",
  "accepted",
  "approved",
]);

/**
 * Accept a snapshot change. The only way to obtain a {@link SnapshotAcceptance}.
 *
 * Fail-closed in four ways, each of which is a way rubber-stamping actually
 * happens in practice:
 *
 * 1. nothing changed -> refuse. An acceptance for an unchanged snapshot is noise
 *    that makes a later real change look reviewed;
 * 2. no substantive justification -> refuse. Checked against length AND a
 *    boilerplate list, because "updated" satisfies any length rule while carrying
 *    no reasoning;
 * 3. the justification merely restates the diff -> refuse. Pasting the diff back
 *    is the laziest way to satisfy a text field;
 * 4. the candidate does not match the classified comparison -> refuse. Otherwise
 *    an acceptance obtained for one candidate could be replayed onto another.
 */
export function acceptSnapshotChange(input: {
  readonly comparison: SnapshotComparison;
  readonly candidate: string | null;
  readonly justification: string;
}): SnapshotAcceptance {
  const { comparison, candidate, justification } = input;

  if (comparison.status === SnapshotStatus.UNCHANGED) {
    throw new SnapshotEvidenceError(
      SNAPSHOT_NOTHING_TO_ACCEPT,
      "an unchanged snapshot has nothing to accept",
    );
  }

  const trimmed = justification.trim();
  const normalized = trimmed.toLowerCase().replace(/[.!]+$/u, "");
  if (trimmed.length < MIN_JUSTIFICATION_LENGTH || EMPTY_JUSTIFICATIONS.includes(normalized)) {
    throw new SnapshotEvidenceError(
      SNAPSHOT_JUSTIFICATION_REQUIRED,
      "a snapshot change requires a substantive justification",
    );
  }
  // Restating the diff is not reasoning about it.
  if (comparison.diff.value.length > 0 && trimmed.includes(comparison.diff.value.trim())) {
    throw new SnapshotEvidenceError(
      SNAPSHOT_JUSTIFICATION_REQUIRED,
      "a justification must explain the change, not restate the diff",
    );
  }

  // The acceptance must bind to the bytes it was granted for.
  const acceptedDigest = candidate === null ? null : sha256(candidate);
  if (acceptedDigest !== comparison.candidate_digest) {
    throw new SnapshotEvidenceError(
      SNAPSHOT_DIFF_MISMATCH,
      "the candidate does not match the classified comparison",
    );
  }
  if (acceptedDigest === null) {
    // A REMOVED snapshot has no accepted content to pin an approval to, so there
    // is nothing this record could honestly assert.
    throw new SnapshotEvidenceError(
      SNAPSHOT_DIFF_MISMATCH,
      "a removed snapshot cannot be accepted as content",
    );
  }

  return snapshotAcceptance.parse({
    comparison,
    justification: trimmed,
    accepted_digest: acceptedDigest,
  });
}
