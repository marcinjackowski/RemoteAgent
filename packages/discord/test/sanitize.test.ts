import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_LENGTH,
  MAX_THREAD_NAME_LENGTH,
  neutralizeMentions,
  sanitizeMessage,
  sanitizeSingle,
  sanitizeThreadName,
} from "../src/sanitize.js";

describe("sanitize", () => {
  it("neutralizes @everyone / @here and raw mentions without losing text", () => {
    const out = neutralizeMentions("hey @everyone and @here <@123> <@!456> <@&789>");
    expect(out).not.toMatch(/@everyone/);
    expect(out).not.toMatch(/@here/);
    // The visible text is preserved (zero-width space inserted after @ / <@).
    expect(out).toContain("everyone");
    expect(out).toContain("here");
    expect(out).toContain("123");
    // No raw resolvable mention remains.
    expect(out).not.toMatch(/<@\d/);
    expect(out).not.toMatch(/<@[!&]\d/);
  });

  it("splits an over-long body into ordered chunks within the limit", () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join("\n");
    const chunks = sanitizeMessage(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    }
    // Reassembling the chunks preserves every character in order.
    expect(chunks.join("")).toBe(neutralizeMentions(body));
  });

  it("hard-splits a single over-long line", () => {
    const line = "x".repeat(MAX_MESSAGE_LENGTH * 2 + 17);
    const chunks = sanitizeMessage(line);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(line);
  });

  it("returns a placeholder for empty content instead of an empty send", () => {
    expect(sanitizeMessage("   \n  ")).toEqual(["_(empty message)_"]);
  });

  it("clamps thread names to the Discord limit on one line", () => {
    const name = sanitizeThreadName("multi\nline   name ".concat("y".repeat(200)));
    expect(name.length).toBeLessThanOrEqual(MAX_THREAD_NAME_LENGTH);
    expect(name).not.toContain("\n");
  });

  it("truncates a non-splittable single message with an explicit marker", () => {
    const out = sanitizeSingle("z".repeat(MAX_MESSAGE_LENGTH + 500));
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(out).toContain("truncated");
  });
});
