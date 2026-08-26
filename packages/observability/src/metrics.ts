import { SecretRedactor } from "./redaction.js";

/**
 * Metrics, and the four alert classes AC4 names (RA-024-WU-06).
 *
 * This module holds an in-process registry rather than an OpenTelemetry SDK export
 * pipeline, and that is a deliberate scope line, not a shortcut. Choosing an
 * exporter, an endpoint and a sampling policy is deployment configuration, which is
 * RA-025's subject; this package must stay a library that any process can import.
 * `@opentelemetry/api` is a declared dependency so a real meter can be attached
 * without changing a call site (see `./tracing.ts` for the same split applied to
 * traces).
 *
 * WHY THE ALERTS ARE CODE AND NOT A DASHBOARD CONFIG. AC4 requires four specific
 * alert classes: DLQ, credential renewal failure, stale lease and cost anomaly. A
 * dashboard threshold cannot be tested, cannot be mutated, and would have to be
 * re-created after every restore — so RA-026's "backup/restore proven by drill"
 * would not cover it. Expressed as pure predicates over a metric snapshot, each
 * threshold gets a red test when it is broken.
 *
 * The four are not arbitrary. Each corresponds to a failure this repository has
 * already seen or explicitly reasoned about:
 *
 *   - **DLQ** — a job that exhausted its attempts stops silently. Nothing polls it.
 *   - **Renewal failure** — a Calendar watch or an OAuth credential that fails to
 *     renew degrades to "quietly stopped working", which is the worst shape of
 *     failure because reads keep succeeding for a while.
 *   - **Stale lease** — a lease held past its expiry with no heartbeat means a
 *     worker died mid-effect. `CTF-007` proved this area had a real production
 *     defect (a missing `pool.on("error")`).
 *   - **Cost anomaly** — the tool loop can retry, and token spend has no natural
 *     ceiling. Without a threshold, cost growth produces no failing anything.
 */

/** Monotonic counters. Names are stable: an alert predicate reads them by key. */
export const MetricName = {
  /** Jobs moved to the dead-letter queue. */
  JOBS_DEAD_LETTERED: "jobs.dead_lettered",
  /** Job claim attempts that found nothing, per poll. */
  JOBS_CLAIMED: "jobs.claimed",
  /** Job attempts that failed and will be retried. */
  JOBS_RETRIED: "jobs.retried",
  /** Leases reclaimed by the reaper because they expired. */
  LEASES_EXPIRED: "leases.expired",
  /** Credential or watch renewals that failed. */
  RENEWALS_FAILED: "renewals.failed",
  /** Credential or watch renewals that succeeded. */
  RENEWALS_SUCCEEDED: "renewals.succeeded",
  /** Watch/webhook registrations observed within their expiry window. */
  WATCHES_EXPIRING: "watches.expiring",
  /** Model input tokens consumed. */
  MODEL_INPUT_TOKENS: "model.input_tokens",
  /** Model output tokens consumed. */
  MODEL_OUTPUT_TOKENS: "model.output_tokens",
  /** Model invocations. */
  MODEL_INVOCATIONS: "model.invocations",
  /** UTF-8 bytes in a compiled, model-bound context packet. */
  CONTEXT_PACKET_BYTES: "context.packet_bytes",
  /** UTF-8 bytes selected from one three-layer context class. */
  CONTEXT_SOURCE_BYTES: "context.source_bytes",
  /** Token estimate used for budgeting only; never presented as provider usage. */
  CONTEXT_ESTIMATED_INPUT_TOKENS: "context.estimated_input_tokens",
  /** Durable sources omitted while fitting a packet to its byte budget. */
  CONTEXT_COMPACTIONS: "context.compactions",
  /** Prompt-cache observations, including an explicit absence of provider signal. */
  CONTEXT_CACHE_OBSERVATIONS: "context.cache_observations",
  /** External writes that produced a confirmed receipt. */
  ACTIONS_SUCCEEDED: "actions.succeeded",
  /** External writes whose outcome could not be established. */
  ACTIONS_AMBIGUOUS: "actions.ambiguous",
  /** Actions refused by policy. */
  ACTIONS_DENIED: "actions.denied",
  /** Requests refused to protect a provider from overload. */
  BACKPRESSURE_REFUSALS: "backpressure.refusals",
  /** Provider responses that reported rate limiting. */
  PROVIDER_THROTTLED: "provider.throttled",
} as const;

export type MetricName = (typeof MetricName)[keyof typeof MetricName];

/** A missing transport cache signal is observable state, not an inferred miss. */
export const ContextCacheState = {
  HIT: "HIT",
  MISS: "MISS",
  NOT_OBSERVED: "NOT_OBSERVED",
} as const;

export type ContextCacheState = (typeof ContextCacheState)[keyof typeof ContextCacheState];

/** Gauges: a current level, not a total. */
export const GaugeName = {
  /** Jobs runnable now but not yet claimed — the queue lag signal. */
  QUEUE_DEPTH: "queue.depth",
  /** Oldest runnable job's age in ms. Depth alone hides a single stuck job. */
  QUEUE_OLDEST_AGE_MS: "queue.oldest_age_ms",
  /** Leases currently held. */
  LEASES_HELD: "leases.held",
  /** Leases held past expiry — a dead worker's footprint. */
  LEASES_STALE: "leases.stale",
  /** Jobs currently in the dead-letter queue. */
  DLQ_DEPTH: "dlq.depth",
  /** Actions sitting in AMBIGUOUS, awaiting reconciliation. */
  ACTIONS_AMBIGUOUS_OPEN: "actions.ambiguous_open",
} as const;

export type GaugeName = (typeof GaugeName)[keyof typeof GaugeName];

/** Labels a metric may carry. Closed, so a cardinality explosion is impossible. */
export interface MetricLabels {
  /** Provider slug, when the metric is per-provider. */
  readonly provider?: string;
  /** Job type or tool name. */
  readonly kind?: string;
  /**
   * Deliberately absent: `case_id`, `connection_id`, `owner_id`. Per-case labels
   * would make cardinality unbounded and would put owner-identifying data into
   * telemetry, which AC2 forbids. Correlation to a case belongs in a trace or in
   * `audit_log`, both of which are access-controlled; a metric is not.
   */
  readonly outcome?: string;
}

function labelKey(labels: MetricLabels | undefined): string {
  if (labels === undefined) return "";
  // Sorted, so the same labels always produce the same series regardless of the
  // order a caller wrote them in.
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",");
}

/** One observed series: a name, its labels, and its value. */
export interface MetricSample {
  readonly name: string;
  readonly labels: MetricLabels;
  readonly value: number;
}

/**
 * An in-process metric registry.
 *
 * Counters only ever increase and gauges are set outright, which is what makes the
 * alert predicates below expressible as pure functions over a snapshot.
 */
export class MetricRegistry {
  readonly #counters = new Map<string, MetricSample>();
  readonly #gauges = new Map<string, MetricSample>();
  readonly #redactor: SecretRedactor;

  constructor(knownSecrets: readonly string[] = []) {
    this.#redactor = new SecretRedactor({ knownSecrets });
  }

  #safeLabels(labels: MetricLabels): MetricLabels {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      if (value !== undefined) {
        safe[this.#redactor.redactString(key)] = this.#redactor.redactString(value);
      }
    }
    return Object.freeze(safe) as MetricLabels;
  }

  /** Add to a counter. Rejects a negative delta: a counter that can go down is a gauge. */
  public increment(name: MetricName, delta = 1, labels: MetricLabels = {}): void {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new RangeError(`counter ${name} cannot move by ${String(delta)}`);
    }
    const safeLabels = this.#safeLabels(labels);
    const key = `${name}|${labelKey(safeLabels)}`;
    const existing = this.#counters.get(key);
    this.#counters.set(key, {
      name,
      labels: safeLabels,
      value: (existing?.value ?? 0) + delta,
    });
  }

  /** Set a gauge to its current level. */
  public setGauge(name: GaugeName, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) {
      throw new RangeError(`gauge ${name} cannot be set to ${String(value)}`);
    }
    const safeLabels = this.#safeLabels(labels);
    this.#gauges.set(`${name}|${labelKey(safeLabels)}`, { name, labels: safeLabels, value });
  }

  /** Sum of every series of one counter, across labels. */
  public counter(name: MetricName, labels?: MetricLabels): number {
    if (labels !== undefined) {
      return this.#counters.get(`${name}|${labelKey(this.#safeLabels(labels))}`)?.value ?? 0;
    }
    let total = 0;
    for (const sample of this.#counters.values()) {
      if (sample.name === name) total += sample.value;
    }
    return total;
  }

  /** Highest value of a gauge across labels — the level an alert must react to. */
  public gauge(name: GaugeName, labels?: MetricLabels): number {
    if (labels !== undefined) {
      return this.#gauges.get(`${name}|${labelKey(this.#safeLabels(labels))}`)?.value ?? 0;
    }
    let highest = 0;
    for (const sample of this.#gauges.values()) {
      if (sample.name === name) highest = Math.max(highest, sample.value);
    }
    return highest;
  }

  /** Every series, for an exporter or a test. */
  public snapshot(): MetricSnapshot {
    return {
      counters: [...this.#counters.values()],
      gauges: [...this.#gauges.values()],
      counter: (name, labels) => this.counter(name, labels),
      gauge: (name, labels) => this.gauge(name, labels),
    };
  }
}

/**
 * A read-only view an alert predicate is evaluated against.
 *
 * Alerts take this rather than a `MetricRegistry` so they provably cannot record
 * anything: an alert that mutated state would change the very numbers the next
 * alert reads.
 */
export interface MetricSnapshot {
  readonly counters: readonly MetricSample[];
  readonly gauges: readonly MetricSample[];
  counter(name: MetricName, labels?: MetricLabels): number;
  gauge(name: GaugeName, labels?: MetricLabels): number;
}
