/**
 * Rate-limit-aware retry for Discord side effects (RA-006).
 *
 * Discord write calls may fail. {@link withDiscordRetry} retries ONLY errors that
 * are PROVABLY SAFE — a 429 ({@link DiscordRateLimitError}) or a pre-effect
 * failure ({@link DiscordUnavailableError}) — because only those cannot have had
 * a side effect (AUDIT-01 HIGH-01). Any other error has an UNKNOWN outcome (a
 * lost response could mean the write DID happen), so it is rethrown IMMEDIATELY,
 * never retried; the dispatcher then records the write as AMBIGUOUS rather than
 * replaying it. A 429's server-provided `retryAfterMs` is always honoured over the
 * computed backoff. Delays go through an injectable {@link Sleeper} so tests are
 * deterministic.
 *
 * Because retry only ever loops on safe errors, a {@link DiscordRetryExhaustedError}
 * it throws also wraps a safe cause — the write still never happened — so the
 * caller may cleanly retry the whole unit later.
 */
import { DiscordRateLimitError, DiscordUnavailableError } from "./gateway.js";

/** Injectable delay. Production sleeps on a timer; tests resolve immediately. */
export type Sleeper = (ms: number) => Promise<void>;

/**
 * Whether an error is provably safe to retry automatically (the request had no
 * side effect). Everything else is treated as an unknown/ambiguous outcome.
 */
export function isSafeToRetry(error: unknown): boolean {
  if (error instanceof DiscordRateLimitError || error instanceof DiscordUnavailableError) {
    return true;
  }
  if (error instanceof DiscordRetryExhaustedError) {
    return isSafeToRetry(error.cause);
  }
  return false;
}

export const realSleeper: Sleeper = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  sleep?: Sleeper;
  /** Observability hook invoked before each backoff wait. */
  onRetry?: (info: { attempt: number; delayMs: number; rateLimited: boolean }) => void;
}

export class DiscordRetryExhaustedError extends Error {
  public readonly attempts: number;
  public override readonly cause: unknown;

  public constructor(attempts: number, cause: unknown) {
    super(`discord call failed after ${attempts} attempt(s)`);
    this.name = new.target.name;
    this.attempts = attempts;
    this.cause = cause;
  }
}

export async function withDiscordRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseMs = options.baseMs ?? 250;
  const capMs = options.capMs ?? 30_000;
  const sleep = options.sleep ?? realSleeper;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Only PROVABLY-SAFE errors are retried; an unknown-outcome error is
      // rethrown immediately so the caller can record it as AMBIGUOUS instead of
      // replaying a write that may already have taken effect (AUDIT-01 HIGH-01).
      if (!isSafeToRetry(error)) {
        throw error;
      }
      if (attempt >= maxAttempts) {
        break;
      }
      const rateLimited = error instanceof DiscordRateLimitError;
      const backoff = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const delayMs = rateLimited
        ? Math.min(capMs, Math.max(backoff, error.retryAfterMs))
        : backoff;
      options.onRetry?.({ attempt, delayMs, rateLimited });
      await sleep(delayMs);
    }
  }
  throw new DiscordRetryExhaustedError(maxAttempts, lastError);
}
