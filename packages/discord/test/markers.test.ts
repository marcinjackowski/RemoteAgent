/**
 * RA-006 marker unit tests (AUDIT-03 HIGH-14 / MEDIUM-17).
 *
 * The reconciliation marker must be BOUNDED, COLLISION-RESISTANT for the whole
 * case id, and matched EXACTLY (never by substring) so `case-1` can never adopt
 * `case-10`'s object and a 512-char case id never overflows Discord's limits.
 */
import { describe, expect, it } from "vitest";

import {
  bodyHasMarker,
  caseTag,
  markerSubtextOverhead,
  nameHasMarker,
  statusMarker,
  threadNameTagToken,
  withMarkerSubtext,
} from "../src/markers.js";
import { MAX_THREAD_NAME_LENGTH } from "../src/sanitize.js";

describe("markers (RA-006)", () => {
  it("is bounded and independent of case-id length (512-char id stays small)", () => {
    const short = caseTag("c");
    const long = caseTag("x".repeat(512));
    expect(short.length).toBe(long.length);
    // The bracketed thread-name token fits Discord's 100-char cap with room to spare.
    expect(threadNameTagToken(long).length).toBeLessThan(MAX_THREAD_NAME_LENGTH);
    expect(markerSubtextOverhead(long)).toBeLessThan(60);
  });

  it("is collision-resistant across the WHOLE case id (case-1 vs case-10)", () => {
    expect(caseTag("case-1")).not.toBe(caseTag("case-10"));
    expect(statusMarker("case-1")).not.toBe(statusMarker("case-10"));
    // The digests share no prefix relationship — a prefix id is not a substring.
    expect(caseTag("case-10").includes(caseTag("case-1"))).toBe(false);
  });

  it("matches a body marker EXACTLY on its own line, never by substring", () => {
    const tag1 = caseTag("case-1");
    const tag10 = caseTag("case-10");
    const body = withMarkerSubtext("hello", tag1);
    expect(bodyHasMarker(body, tag1)).toBe(true);
    // The other case's marker must NOT match this body.
    expect(bodyHasMarker(body, tag10)).toBe(false);
    // A marker embedded mid-line (not its own subtext line) is not a match.
    expect(bodyHasMarker(`prefix ${tag1} suffix`, tag1)).toBe(false);
  });

  it("matches a thread-name marker EXACTLY as a bracket-delimited token", () => {
    const tag1 = caseTag("case-1");
    const tag10 = caseTag("case-10");
    const name = `Case ${threadNameTagToken(tag1)}`;
    expect(nameHasMarker(name, tag1)).toBe(true);
    expect(nameHasMarker(name, tag10)).toBe(false);
    // The raw marker without its delimiting brackets is not a match.
    expect(nameHasMarker(`Case ${tag1}`, tag1)).toBe(false);
  });

  it("case and status markers never collide for the same case", () => {
    expect(bodyHasMarker(withMarkerSubtext("x", statusMarker("case-1")), caseTag("case-1"))).toBe(
      false,
    );
  });
});
