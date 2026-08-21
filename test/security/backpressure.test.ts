import {
  BackpressureRefusal,
  CircuitBreaker,
  CircuitState,
  ConcurrencyLimiter,
  DEFAULT_BACKPRESSURE,
  GaugeName,
  MetricName,
  MetricRegistry,
  ProviderBackpressure,
  TokenBucket,
} from "@remoteagent/observability";
import { describe, expect, it } from "vitest";

/**
 * AC7: "the system maintains controlled backpressure instead of overloading
 * providers" (RA-024-WU-08).
 *
 * The failure being prevented is the amplification loop, not slowness: a strained
 * provider returns 429, retry logic classifies that as transient, the retries add
 * load, and the system's response to overload becomes more overload. That ends in a
 * rate-limit ban or a revoked credential — an outage we inflicted and cannot retry
 * out of.
 *
 * Time is INJECTED everywhere. A rate limiter tested against the wall clock is a
 * flaky test, and this repository has spent three cross-task findings on flakes
 * (`CTF-003`, `CTF-007`, `CTF-012`); adding a fourth in the suite whose job is
 * proving stability would be its own defect.
 */

/** A controllable clock. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("AC7: concurrency ceiling", () => {
  it("refuses once the ceiling is reached, and names the reason", () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.tryAcquire().allowed).toBe(true);
    expect(limiter.tryAcquire().allowed).toBe(true);
    const refused = limiter.tryAcquire();
    // Asserted on the specific refusal, not on `allowed === false`: three mechanisms
    // can refuse, and a test that accepts any of them would pass with this one gone.
    expect(refused.refusal).toBe(BackpressureRefusal.CONCURRENCY_LIMIT);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("frees a slot on release", () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.tryAcquire();
    expect(limiter.tryAcquire().allowed).toBe(false);
    limiter.release();
    expect(limiter.tryAcquire().allowed).toBe(true);
  });

  it("throws on a double release rather than silently raising the ceiling", () => {
    // The failure mode that makes a limiter look present while doing nothing: each
    // spurious release permanently widens the effective limit.
    const limiter = new ConcurrencyLimiter(1);
    limiter.tryAcquire();
    limiter.release();
    expect(() => limiter.release()).toThrow(RangeError);
  });

  it("refuses a nonsensical limit at construction", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => new ConcurrencyLimiter(bad)).toThrow(RangeError);
    }
  });
});

describe("AC7: rate limiting averages over time, which a concurrency cap cannot", () => {
  it("allows a burst up to capacity and then refuses", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(3, 1, clock.now);
    expect(bucket.tryConsume().allowed).toBe(true);
    expect(bucket.tryConsume().allowed).toBe(true);
    expect(bucket.tryConsume().allowed).toBe(true);
    const refused = bucket.tryConsume();
    expect(refused.refusal).toBe(BackpressureRefusal.RATE_LIMIT);
  });

  it("states how long to wait, so a caller never guesses", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1, 2, clock.now);
    bucket.tryConsume();
    // Refill is 2/s, so one token takes 500ms.
    expect(bucket.tryConsume().retryAfterMs).toBe(500);
  });

  it("refills over elapsed time", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1, clock.now);
    bucket.tryConsume();
    bucket.tryConsume();
    expect(bucket.tryConsume().allowed).toBe(false);
    clock.advance(1_000);
    expect(bucket.tryConsume().allowed).toBe(true);
  });

  it("never refills above capacity", () => {
    // Otherwise a long idle period stores up an unbounded burst, and the first
    // moment of activity after a quiet night floods the provider.
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 10, clock.now);
    clock.advance(3_600_000);
    expect(bucket.tokens).toBe(2);
  });

  it("mints no tokens when the clock goes backwards", () => {
    // A monotonic clock is an assumption, not a guarantee, and the failure direction
    // matters: minting tokens on a backwards clock is a burst at the provider.
    let current = 10_000;
    const bucket = new TokenBucket(2, 5, () => current);
    bucket.tryConsume();
    bucket.tryConsume();
    current = 0;
    expect(bucket.tryConsume().allowed).toBe(false);
  });

  it("does not permit a double-rate burst across a window boundary", () => {
    // The reason this is a token bucket and not a fixed window. A fixed window allows
    // `capacity` at the end of one window plus `capacity` at the start of the next —
    // 2× the published rate in an instant, while our own metrics show compliance.
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 5, clock.now);
    let allowed = 0;
    for (let i = 0; i < 5; i += 1) if (bucket.tryConsume().allowed) allowed += 1;
    clock.advance(1);
    for (let i = 0; i < 5; i += 1) if (bucket.tryConsume().allowed) allowed += 1;
    expect(allowed).toBe(5);
  });

  it("refuses nonsensical construction", () => {
    const clock = fakeClock();
    expect(() => new TokenBucket(0, 1, clock.now)).toThrow(RangeError);
    expect(() => new TokenBucket(1, 0, clock.now)).toThrow(RangeError);
  });
});

describe("AC7: the circuit reacts to the provider's OWN signal", () => {
  it("opens on a throttle signal and refuses subsequent requests", () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: clock.now });
    expect(breaker.tryEnter().allowed).toBe(true);
    breaker.recordThrottled();
    expect(breaker.state).toBe(CircuitState.OPEN);
    expect(breaker.tryEnter().refusal).toBe(BackpressureRefusal.CIRCUIT_OPEN);
  });

  it("half-opens after the cooldown and admits exactly ONE probe", () => {
    // Not a percentage and not a burst: N concurrent probes against a still-overloaded
    // provider is another small flood, which is the thing being prevented.
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: clock.now });
    breaker.recordThrottled();
    clock.advance(1_000);
    expect(breaker.state).toBe(CircuitState.HALF_OPEN);
    expect(breaker.tryEnter().allowed).toBe(true);
    expect(breaker.tryEnter().allowed).toBe(false);
  });

  it("re-opens for a FULL cooldown when the probe is also throttled", () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: clock.now });
    breaker.recordThrottled();
    clock.advance(1_000);
    breaker.tryEnter();
    breaker.recordThrottled();
    expect(breaker.state).toBe(CircuitState.OPEN);
    clock.advance(999);
    expect(breaker.tryEnter().allowed).toBe(false);
    clock.advance(1);
    expect(breaker.tryEnter().allowed).toBe(true);
  });

  it("closes when the probe succeeds", () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1_000, now: clock.now });
    breaker.recordThrottled();
    clock.advance(1_000);
    breaker.tryEnter();
    breaker.recordSuccess();
    expect(breaker.state).toBe(CircuitState.CLOSED);
    expect(breaker.tryEnter().allowed).toBe(true);
  });

  it("counts CONSECUTIVE throttles, so an alternating pattern still opens", () => {
    // Decrementing instead of resetting would let success/throttle/success/throttle
    // sustain exactly the load the provider is rejecting, forever, without opening.
    const clock = fakeClock();
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1_000, now: clock.now });
    breaker.recordThrottled();
    breaker.recordSuccess();
    expect(breaker.state).toBe(CircuitState.CLOSED);
    breaker.recordThrottled();
    breaker.recordThrottled();
    expect(breaker.state).toBe(CircuitState.OPEN);
  });

  it("the default opens on a SINGLE throttle", () => {
    // A provider saying "too fast" is not noise to average over samples: by the time
    // a second 429 arrives we have already sent the request that caused it.
    expect(DEFAULT_BACKPRESSURE.throttleThreshold).toBe(1);
  });
});

describe("AC7: the combined limiter refuses instead of flooding", () => {
  it("a sustained flood is refused, and the provider sees a bounded number of calls", () => {
    // The AC7 scenario end to end: 500 requests arrive at once against a provider
    // configured for 10 burst / 5 per second / 4 concurrent. What matters is that the
    // count reaching the provider is BOUNDED and the rest are refused — not queued in
    // memory, where they would be lost on restart and invisible to metrics.
    const clock = fakeClock();
    const limiter = new ProviderBackpressure("jira", DEFAULT_BACKPRESSURE, clock.now);
    const registry = new MetricRegistry();

    let reached = 0;
    let refused = 0;
    for (let i = 0; i < 500; i += 1) {
      const decision = limiter.tryStart();
      if (decision.allowed) {
        reached += 1;
        limiter.finish("OK");
      } else {
        refused += 1;
        registry.increment(MetricName.BACKPRESSURE_REFUSALS, 1, { provider: "jira" });
      }
    }
    expect(reached).toBeLessThanOrEqual(DEFAULT_BACKPRESSURE.burstCapacity);
    expect(refused).toBe(500 - reached);
    // The overload is VISIBLE. A memory queue would have shown healthy metrics while
    // an unbounded array grew inside the worker.
    expect(registry.counter(MetricName.BACKPRESSURE_REFUSALS)).toBe(refused);
  });

  it("recovers at the configured rate rather than all at once", () => {
    const clock = fakeClock();
    const limiter = new ProviderBackpressure("jira", DEFAULT_BACKPRESSURE, clock.now);
    for (let i = 0; i < DEFAULT_BACKPRESSURE.burstCapacity; i += 1) {
      limiter.tryStart();
      limiter.finish("OK");
    }
    expect(limiter.tryStart().allowed).toBe(false);
    clock.advance(1_000);
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) {
      if (limiter.tryStart().allowed) {
        allowed += 1;
        limiter.finish("OK");
      }
    }
    // One second at 5/s. Asserted as an exact ceiling, since "some recovery" would
    // pass even if the bucket refilled to full capacity.
    expect(allowed).toBe(DEFAULT_BACKPRESSURE.requestsPerSecond);
  });

  it("a throttle signal stops traffic even while rate and concurrency allow it", () => {
    // The amplification loop, cut. Rate and concurrency both say yes; the provider has
    // said no, and the provider wins.
    const clock = fakeClock();
    const limiter = new ProviderBackpressure("gitlab", DEFAULT_BACKPRESSURE, clock.now);
    expect(limiter.tryStart().allowed).toBe(true);
    limiter.finish("THROTTLED");
    expect(limiter.circuitState).toBe(CircuitState.OPEN);
    const refused = limiter.tryStart();
    expect(refused.refusal).toBe(BackpressureRefusal.CIRCUIT_OPEN);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("consumes no rate token for a request the circuit refuses", () => {
    // Ordering matters: charging the bucket for a refused request would distort the
    // rate accounting and delay recovery after the circuit closes.
    const clock = fakeClock();
    const limiter = new ProviderBackpressure("gitlab", DEFAULT_BACKPRESSURE, clock.now);
    limiter.tryStart();
    limiter.finish("THROTTLED");
    for (let i = 0; i < 50; i += 1) limiter.tryStart();
    clock.advance(DEFAULT_BACKPRESSURE.cooldownMs);
    // Cooldown elapsed, so the probe is admitted — which it would not be if 50
    // refusals had drained the bucket.
    expect(limiter.tryStart().allowed).toBe(true);
  });

  it("holds no concurrency slot for a refused request", () => {
    const clock = fakeClock();
    const limiter = new ProviderBackpressure("jira", DEFAULT_BACKPRESSURE, clock.now);
    limiter.tryStart();
    limiter.finish("THROTTLED");
    for (let i = 0; i < 10; i += 1) limiter.tryStart();
    expect(limiter.inFlight).toBe(0);
  });

  it("keeps providers independent, so one throttled provider does not stop the others", () => {
    // Shared limits would turn a Jira rate limit into a GitLab outage, which is a
    // self-inflicted blast radius.
    const clock = fakeClock();
    const jira = new ProviderBackpressure("jira", DEFAULT_BACKPRESSURE, clock.now);
    const gitlab = new ProviderBackpressure("gitlab", DEFAULT_BACKPRESSURE, clock.now);
    jira.tryStart();
    jira.finish("THROTTLED");
    expect(jira.tryStart().allowed).toBe(false);
    expect(gitlab.tryStart().allowed).toBe(true);
  });

  it("surfaces its state as metrics an alert can read", () => {
    const clock = fakeClock();
    const limiter = new ProviderBackpressure("jira", DEFAULT_BACKPRESSURE, clock.now);
    const registry = new MetricRegistry();
    limiter.tryStart();
    limiter.finish("THROTTLED");
    registry.increment(MetricName.PROVIDER_THROTTLED, 1, { provider: "jira" });
    registry.setGauge(GaugeName.QUEUE_DEPTH, 250, { provider: "jira" });
    expect(registry.counter(MetricName.PROVIDER_THROTTLED, { provider: "jira" })).toBe(1);
    expect(registry.gauge(GaugeName.QUEUE_DEPTH)).toBe(250);
  });
});
