/**
 * Unit tests for the deterministic queue runtime ports and backoff (RA-004).
 *
 * These are pure (no database): they pin the deterministic clock/id behavior and
 * the exact bounded-exponential-backoff schedule the queue relies on.
 */
import { describe, expect, it } from "vitest";

import {
  ManualClock,
  SequentialIdGenerator,
  SystemClock,
  UuidGenerator,
  backoffDelayMs,
} from "../src/queue/index.js";

describe("ManualClock", () => {
  it("starts at the given instant and only advances explicitly", () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(3000);
    expect(clock.now()).toBe(3000);
  });

  it("refuses to move backwards", () => {
    const clock = new ManualClock(1000);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.set(999)).toThrow(RangeError);
  });
});

describe("SequentialIdGenerator", () => {
  it("produces reproducible, increasing ids", () => {
    const ids = new SequentialIdGenerator();
    expect(ids.next("job")).toBe("job-1");
    expect(ids.next("job")).toBe("job-2");
    expect(ids.next()).toBe("id-3");
  });
});

describe("production ports", () => {
  it("SystemClock is close to Date.now and UuidGenerator is unique", () => {
    const before = Date.now();
    const now = new SystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
    const ids = new UuidGenerator();
    const a = ids.next("x");
    const b = ids.next("x");
    expect(a).not.toBe(b);
    expect(a.startsWith("x_")).toBe(true);
  });
});

describe("backoffDelayMs", () => {
  it("is bounded exponential: base * 2^(n-1), capped", () => {
    const policy = { baseMs: 1000, capMs: 10_000 };
    expect(backoffDelayMs(1, policy)).toBe(1000); // base * 2^0
    expect(backoffDelayMs(2, policy)).toBe(2000); // base * 2^1
    expect(backoffDelayMs(3, policy)).toBe(4000); // base * 2^2
    expect(backoffDelayMs(4, policy)).toBe(8000); // base * 2^3
    expect(backoffDelayMs(5, policy)).toBe(10_000); // capped
    expect(backoffDelayMs(50, policy)).toBe(10_000); // still capped, no overflow
  });

  it("rejects invalid inputs", () => {
    expect(() => backoffDelayMs(0, { baseMs: 1, capMs: 1 })).toThrow(RangeError);
    expect(() => backoffDelayMs(1, { baseMs: -1, capMs: 1 })).toThrow(RangeError);
  });
});
