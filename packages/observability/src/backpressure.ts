/**
 * Controlled backpressure (RA-024-WU-08, AC7).
 *
 * AC7: "the system maintains controlled backpressure instead of overloading
 * providers." The failure this prevents is specific and is not "the provider gets
 * slow": it is that a provider under strain returns 429s, our retry logic treats
 * those as transient, and the retries add load — so the system's response to
 * overload is MORE load. That loop ends in a revoked credential or a rate-limit ban,
 * which is an outage we inflicted on ourselves and cannot retry out of.
 *
 * THREE MECHANISMS, EACH ANSWERING A DIFFERENT QUESTION:
 *
 *   1. {@link ConcurrencyLimiter} — "may another request start right now?" A hard
 *      ceiling on in-flight work per provider.
 *   2. {@link TokenBucket} — "have we exceeded the rate the provider published?"
 *      Averages over time, which a concurrency cap cannot do: one request at a time
 *      can still be 100 requests per second.
 *   3. {@link CircuitBreaker} — "has the provider already told us to stop?" Opens on
 *      observed throttling and STAYS open for a cooldown, which is the only
 *      mechanism that reacts to the provider's own signal.
 *
 * All three REFUSE rather than queue. That is the deliberate choice, and the reason
 * is the durable queue: work that cannot proceed now is already safely persisted as a
 * job with a lease and a retry schedule, so refusing returns it to a place designed
 * to hold it. Queueing in memory instead would (a) lose the work on restart, and (b)
 * hide the overload from the metrics an operator reads — the queue depth would look
 * healthy while an unbounded array grew inside a worker.
 *
 * Everything here is deterministic and clock-injected. A rate limiter tested with
 * real time is a flaky test, and this repository has spent three cross-task findings
 * on flakes (`CTF-003`, `CTF-007`, `CTF-012`).
 */

/** Why a request was refused, so a caller can tell "wait" from "stop". */
export const BackpressureRefusal = {
  /** Too many requests already in flight for this provider. */
  CONCURRENCY_LIMIT: "CONCURRENCY_LIMIT",
  /** The published rate would be exceeded. */
  RATE_LIMIT: "RATE_LIMIT",
  /** The provider itself signalled throttling recently. */
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
} as const;

export type BackpressureRefusal = (typeof BackpressureRefusal)[keyof typeof BackpressureRefusal];

/** A refusal carries how long to wait, so a caller never has to guess. */
export interface BackpressureDecision {
  readonly allowed: boolean;
  readonly refusal?: BackpressureRefusal;
  /**
   * Milliseconds after which a retry is plausible.
   *
   * Advisory, and deliberately so: the authoritative retry schedule lives on the
   * durable job row. This value exists so a caller can set that row's `available_at`
   * rather than inventing a delay.
   */
  readonly retryAfterMs?: number;
}

const ALLOWED: BackpressureDecision = Object.freeze({ allowed: true });

function refuse(refusal: BackpressureRefusal, retryAfterMs: number): BackpressureDecision {
  // Rounded UP: a retry one millisecond early is refused again, which converts a
  // rate limit into a busy loop against our own limiter.
  return { allowed: false, refusal, retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)) };
}

/** A hard ceiling on in-flight requests. */
export class ConcurrencyLimiter {
  #inFlight = 0;

  public constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`concurrency limit must be a positive integer, got ${String(limit)}`);
    }
  }

  public get inFlight(): number {
    return this.#inFlight;
  }

  /** Try to take a slot. Returns whether one was taken. */
  public tryAcquire(): BackpressureDecision {
    if (this.#inFlight >= this.limit) {
      // No useful `retryAfterMs` is knowable: a slot frees when a request finishes,
      // and this limiter does not know how long that takes. One second is stated as a
      // floor rather than a prediction, and the durable job's own backoff is what
      // actually schedules the retry.
      return refuse(BackpressureRefusal.CONCURRENCY_LIMIT, 1_000);
    }
    this.#inFlight += 1;
    return ALLOWED;
  }

  /** Release a slot. Safe to call once per successful acquire, and only once. */
  public release(): void {
    if (this.#inFlight === 0) {
      // Fail loudly. A double release silently raises the effective ceiling, which
      // is the failure mode that makes a limiter look present while doing nothing.
      throw new RangeError("released a concurrency slot that was never acquired");
    }
    this.#inFlight -= 1;
  }
}

/**
 * A token bucket: `capacity` requests, refilled at `refillPerSecond`.
 *
 * Chosen over a fixed window because a fixed window permits a double-rate burst
 * across its boundary — `capacity` at the end of one window and `capacity` at the
 * start of the next, which is exactly the shape that trips a provider's own limiter
 * while our metrics show we stayed under it.
 */
export class TokenBucket {
  #tokens: number;
  #lastRefillMs: number;

  public constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number,
  ) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be >= 1, got ${String(capacity)}`);
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new RangeError(`refillPerSecond must be > 0, got ${String(refillPerSecond)}`);
    }
    this.#tokens = capacity;
    this.#lastRefillMs = now();
  }

  public get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  public tryConsume(count = 1): BackpressureDecision {
    this.#refill();
    if (this.#tokens >= count) {
      this.#tokens -= count;
      return ALLOWED;
    }
    const deficit = count - this.#tokens;
    return refuse(BackpressureRefusal.RATE_LIMIT, (deficit / this.refillPerSecond) * 1_000);
  }

  #refill(): void {
    const now = this.now();
    const elapsedMs = now - this.#lastRefillMs;
    if (elapsedMs <= 0) {
      // A clock that went backwards must not mint tokens. Guarded because a
      // monotonic clock is an assumption, not a guarantee, and the failure direction
      // matters: minting tokens on a backwards clock is a burst at the provider.
      this.#lastRefillMs = now;
      return;
    }
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + (elapsedMs / 1_000) * this.refillPerSecond,
    );
    this.#lastRefillMs = now;
  }
}

/** Circuit states. */
export const CircuitState = {
  /** Requests flow. */
  CLOSED: "CLOSED",
  /** Refusing everything until the cooldown elapses. */
  OPEN: "OPEN",
  /** Letting exactly one request through to test the water. */
  HALF_OPEN: "HALF_OPEN",
} as const;

export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

/**
 * Opens when the provider signals throttling, and stays open for a cooldown.
 *
 * This is the mechanism that reacts to the provider's OWN signal, which the other
 * two cannot: a 429 means our configured limits were wrong, and continuing at a
 * limit the provider has just rejected is the self-inflicted outage AC7 is about.
 *
 * `HALF_OPEN` lets exactly ONE request through. Not a percentage and not a burst:
 * the point of a probe is to learn the provider's state at minimum cost, and N
 * concurrent probes against a still-overloaded provider is another small flood.
 */
export class CircuitBreaker {
  #state: CircuitState = CircuitState.CLOSED;
  #consecutiveThrottles = 0;
  #openedAtMs = 0;
  #probeInFlight = false;

  public constructor(
    private readonly options: {
      /** Consecutive throttle signals before opening. */
      readonly threshold: number;
      /** How long to stay open, in ms. */
      readonly cooldownMs: number;
      readonly now: () => number;
    },
  ) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new RangeError("threshold must be a positive integer");
    }
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs <= 0) {
      throw new RangeError("cooldownMs must be > 0");
    }
  }

  public get state(): CircuitState {
    this.#maybeHalfOpen();
    return this.#state;
  }

  public tryEnter(): BackpressureDecision {
    this.#maybeHalfOpen();
    if (this.#state === CircuitState.CLOSED) return ALLOWED;
    if (this.#state === CircuitState.HALF_OPEN && !this.#probeInFlight) {
      this.#probeInFlight = true;
      return ALLOWED;
    }
    const elapsed = this.options.now() - this.#openedAtMs;
    return refuse(BackpressureRefusal.CIRCUIT_OPEN, Math.max(1, this.options.cooldownMs - elapsed));
  }

  /** The provider signalled throttling (429, `Retry-After`, a throttling trait). */
  public recordThrottled(): void {
    this.#probeInFlight = false;
    this.#consecutiveThrottles += 1;
    if (this.#consecutiveThrottles >= this.options.threshold) {
      // A throttle while HALF_OPEN re-opens for a FULL cooldown. The probe was the
      // question; a throttled probe is the answer.
      this.#state = CircuitState.OPEN;
      this.#openedAtMs = this.options.now();
    }
  }

  /** The provider responded normally. */
  public recordSuccess(): void {
    this.#probeInFlight = false;
    // Reset to zero, not decrement: `threshold` means CONSECUTIVE throttles, and
    // decrementing would let an alternating success/throttle pattern never open the
    // circuit while sustaining exactly the load the provider is rejecting.
    this.#consecutiveThrottles = 0;
    this.#state = CircuitState.CLOSED;
  }

  #maybeHalfOpen(): void {
    if (this.#state !== CircuitState.OPEN) return;
    if (this.options.now() - this.#openedAtMs >= this.options.cooldownMs) {
      this.#state = CircuitState.HALF_OPEN;
      this.#probeInFlight = false;
    }
  }
}

/** Per-provider limits. RA-025 owns the values; the shape is fixed here. */
export interface ProviderBackpressureConfig {
  readonly maxConcurrent: number;
  readonly requestsPerSecond: number;
  readonly burstCapacity: number;
  readonly throttleThreshold: number;
  readonly cooldownMs: number;
}

export const DEFAULT_BACKPRESSURE: ProviderBackpressureConfig = Object.freeze({
  maxConcurrent: 4,
  requestsPerSecond: 5,
  burstCapacity: 10,
  // ONE throttle signal opens the circuit. A provider saying "too fast" is not noise
  // to be averaged over several samples — by the time a second 429 arrives we have
  // already sent the request that caused it.
  throttleThreshold: 1,
  cooldownMs: 30_000,
});

/**
 * All three mechanisms for one provider, checked in the cheapest-first order that is
 * also the safest: circuit, then rate, then concurrency.
 *
 * The circuit goes FIRST because it represents the provider's own instruction, and
 * consuming a rate token or a concurrency slot for a request that the circuit will
 * refuse anyway would distort both. Concurrency goes LAST because it is the only one
 * that takes a resource which must then be released — so it is acquired only once
 * the request is definitely going to be attempted.
 */
export class ProviderBackpressure {
  readonly #concurrency: ConcurrencyLimiter;
  readonly #bucket: TokenBucket;
  readonly #circuit: CircuitBreaker;

  public constructor(
    public readonly provider: string,
    config: ProviderBackpressureConfig = DEFAULT_BACKPRESSURE,
    now: () => number = () => Date.now(),
  ) {
    this.#concurrency = new ConcurrencyLimiter(config.maxConcurrent);
    this.#bucket = new TokenBucket(config.burstCapacity, config.requestsPerSecond, now);
    this.#circuit = new CircuitBreaker({
      threshold: config.throttleThreshold,
      cooldownMs: config.cooldownMs,
      now,
    });
  }

  public get circuitState(): CircuitState {
    return this.#circuit.state;
  }

  public get inFlight(): number {
    return this.#concurrency.inFlight;
  }

  /** May a request start? On `allowed`, the caller MUST later call `finish`. */
  public tryStart(): BackpressureDecision {
    const circuit = this.#circuit.tryEnter();
    if (!circuit.allowed) return circuit;
    const rate = this.#bucket.tryConsume();
    if (!rate.allowed) return rate;
    return this.#concurrency.tryAcquire();
  }

  /**
   * Report the outcome and release the slot.
   *
   * One method rather than separate `release` and `recordX` calls, so a caller
   * cannot release the slot while forgetting to report a throttle — which would
   * leave the circuit permanently closed against a provider that is rejecting us.
   */
  public finish(outcome: "OK" | "THROTTLED"): void {
    this.#concurrency.release();
    if (outcome === "THROTTLED") this.#circuit.recordThrottled();
    else this.#circuit.recordSuccess();
  }
}
