/**
 * Deterministic Discord reconciliation markers (RA-006, AUDIT-02 HIGH-07,
 * AUDIT-03 HIGH-14).
 *
 * A Discord write (post an anchor message, start a thread, post the pinned status
 * message) is NOT idempotent on Discord's side: repeating it creates a second
 * object. To make each write recoverable across a crash or a lost response, the
 * dispatcher embeds a DETERMINISTIC, per-case marker into the object it creates,
 * so a later attempt can find the object again (reconcile) instead of creating a
 * duplicate:
 *
 *   - {@link caseTag} is embedded in the anchor message body AND the thread name,
 *     so a crashed root creation is reconciled by searching the channel's messages
 *     (orphan anchor) and threads (existing thread);
 *   - {@link statusMarker} is embedded in the pinned status message body, so the
 *     otherwise non-idempotent "first status message" is reconciled by searching
 *     the thread's bot-authored messages, healing a crash before the pin.
 *
 * AUDIT-03 HIGH-14 hardening. The marker used to embed the RAW case id and was
 * matched by SUBSTRING, so a lookup for `case-1` adopted an object marked
 * `case-10`, and a 512-char case id could blow past Discord's 100-char thread-name
 * cap. The marker is now:
 *
 *   - BOUNDED: a fixed-length hex digest of the FULL case id, independent of the
 *     id's own length (so even a 512-char id stays well within Discord limits);
 *   - COLLISION-RESISTANT for the WHOLE case id: `case-1` and `case-10` hash to
 *     entirely different digests;
 *   - EXACT-MATCH, never substring: in a body it occupies its own subtext line
 *     matched by line equality; in a thread name it is a bracket-delimited token
 *     matched exactly.
 *
 * Markers are established outside the model and never derived from untrusted
 * content.
 */
import { createHash } from "node:crypto";

const CASE_PREFIX = "RA-CASE";
const STATUS_PREFIX = "RA-STATUS";

/**
 * A 96-bit (24 hex char) digest of the FULL case id. Fixed length regardless of
 * the id's length, and collision-resistant across the whole id — two ids that
 * merely share a prefix (`case-1` / `case-10`) produce unrelated digests.
 */
function caseDigest(caseId: string): string {
  return createHash("sha256").update(caseId, "utf8").digest("hex").slice(0, 24);
}

/** Marker embedded in a case's anchor message body and thread name. */
export function caseTag(caseId: string): string {
  return `${CASE_PREFIX}:${caseDigest(caseId)}`;
}

/** Marker embedded in a case's pinned status message body. */
export function statusMarker(caseId: string): string {
  return `${STATUS_PREFIX}:${caseDigest(caseId)}`;
}

/** Render a marker as an unobtrusive Discord subtext line appended to a body. */
export function withMarkerSubtext(body: string, marker: string): string {
  return `${body}\n-# ${marker}`;
}

/**
 * The number of characters {@link withMarkerSubtext} appends. Callers RESERVE
 * this much room BEFORE chunking/truncation so the final body stays within
 * Discord's limit even after the marker is added (AUDIT-03 MEDIUM-17).
 */
export function markerSubtextOverhead(marker: string): number {
  return `\n-# ${marker}`.length;
}

/**
 * EXACT-match a marker embedded in a message body (AUDIT-03 HIGH-14): the marker
 * occupies its own subtext line, matched by whole-line equality, so `RA-CASE:aaa`
 * can never match a line containing `RA-CASE:aaab`.
 */
export function bodyHasMarker(content: unknown, marker: string): boolean {
  if (typeof content !== "string") return false;
  const line = `-# ${marker}`;
  return content.split(/\r?\n/).some((l) => l === line || l === marker);
}

/** The bracket-delimited token embedded in a thread name. */
export function threadNameTagToken(marker: string): string {
  return `[${marker}]`;
}

/**
 * EXACT-match a marker embedded in a thread name (AUDIT-03 HIGH-14): the marker is
 * a bracket-delimited, fixed-length token, so a prefixed id's token can never be a
 * substring of another case's token.
 */
export function nameHasMarker(name: unknown, marker: string): boolean {
  return typeof name === "string" && name.includes(threadNameTagToken(marker));
}
