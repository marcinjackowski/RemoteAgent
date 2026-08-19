import { describe, expect, it } from "vitest";

import { DiscordRateLimitError, DiscordUnavailableError } from "../src/gateway.js";
import { DiscordRetryExhaustedError, isSafeToRetry, withDiscordRetry } from "../src/retry.js";

describe("withDiscordRetry", () => {
  it("honours a 429 retry-after over the computed backoff", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const result = await withDiscordRetry(
      () => {
        calls += 1;
        if (calls === 1) {
          throw new DiscordRateLimitError(5000);
        }
        return Promise.resolve("ok");
      },
      { sleep, baseMs: 100, capMs: 60_000 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    // The single backoff used the server-provided 5000ms, not the 100ms base.
    expect(delays).toEqual([5000]);
  });

  it("retries provably-safe (unavailable) errors with exponential backoff", async () => {
    const delays: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    };
    let calls = 0;
    await withDiscordRetry(
      () => {
        calls += 1;
        if (calls < 3) throw new DiscordUnavailableError();
        return Promise.resolve("done");
      },
      { sleep, baseMs: 100, capMs: 60_000 },
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("never retries an unknown-outcome error; it rethrows immediately", async () => {
    let calls = 0;
    const sleep = (): Promise<void> => Promise.resolve();
    await expect(
      withDiscordRetry(
        () => {
          calls += 1;
          throw new Error("response lost");
        },
        { sleep, maxAttempts: 5, baseMs: 1 },
      ),
    ).rejects.toThrow("response lost");
    // Rethrown on the first attempt: an ambiguous write must not be replayed.
    expect(calls).toBe(1);
  });

  it("throws DiscordRetryExhaustedError (wrapping a safe cause) after maxAttempts", async () => {
    const sleep = (): Promise<void> => Promise.resolve();
    await expect(
      withDiscordRetry(
        () => {
          throw new DiscordUnavailableError("always");
        },
        { sleep, maxAttempts: 3, baseMs: 1 },
      ),
    ).rejects.toBeInstanceOf(DiscordRetryExhaustedError);
  });

  it("classifies only rate-limit / unavailable (and safe-caused exhaustion) as safe", () => {
    expect(isSafeToRetry(new DiscordRateLimitError(1))).toBe(true);
    expect(isSafeToRetry(new DiscordUnavailableError())).toBe(true);
    expect(isSafeToRetry(new DiscordRetryExhaustedError(3, new DiscordUnavailableError()))).toBe(
      true,
    );
    expect(isSafeToRetry(new Error("lost"))).toBe(false);
    expect(isSafeToRetry(new DiscordRetryExhaustedError(3, new Error("lost")))).toBe(false);
  });
});
