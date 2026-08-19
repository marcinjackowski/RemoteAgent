/**
 * Bounded exponential backoff for the durable queue (RA-004).
 *
 * Retry uses bounded exponential backoff and terminates in an observable DLQ
 * (task RA-004 acceptance criterion 5). The delay for attempt `n` (1-based, i.e.
 * the delay applied AFTER the n-th attempt fails, before attempt n+1) is:
 *
 *   delay(n) = min(capMs, baseMs * 2^(n-1))
 *
 * The function is pure and deterministic: the same inputs always yield the same
 * delay, and there is no jitter, so tests over a {@link ManualClock} are exact.
 * (Jitter is a production concern for thundering herds and can be layered on by a
 * scheduler; the core schedule stays deterministic and auditable.)
 */
export interface BackoffPolicy {
  /** Base delay in milliseconds (delay before the 2nd attempt). */
  baseMs: number;
  /** Upper bound on any single delay, in milliseconds. */
  capMs: number;
}

/**
 * Compute the backoff delay (ms) to apply after `attempts` failed attempts.
 *
 * `attempts` is the number of attempts already made (>= 1). The exponent is
 * clamped so that `2^(attempts-1)` never overflows into a non-finite number for
 * large attempt counts; the cap dominates long before that anyway.
 */
export function backoffDelayMs(attempts: number, policy: BackoffPolicy): number {
  if (attempts < 1) {
    throw new RangeError("attempts must be >= 1");
  }
  if (policy.baseMs < 0 || policy.capMs < 0) {
    throw new RangeError("backoff base/cap must be non-negative");
  }
  // Clamp the exponent so base * 2^exp cannot exceed the cap-relevant range.
  // 2^52 already dwarfs any realistic cap; beyond it we just return the cap.
  const exponent = Math.min(attempts - 1, 52);
  const raw = policy.baseMs * 2 ** exponent;
  return Math.min(policy.capMs, raw);
}
