/**
 * The four alert classes AC4 requires, as testable predicates (RA-024-WU-06).
 *
 * AC4: "alerts cover DLQ, renewal failure, stale lease and cost anomaly threshold."
 * Four classes, named explicitly, because each is a way this system fails SILENTLY —
 * reads keep working, no test goes red, and the only symptom is that something
 * stopped happening. That is why they are code: a dashboard threshold cannot be
 * mutation-tested, and would have to be rebuilt after every restore drill, so
 * RA-026's "proven by drill" would not cover it.
 *
 * EVERY RULE IS FAIL-LOUD, NOT FAIL-QUIET. Where a threshold could plausibly go
 * either way, it fires. Two defects in RA-014 came from treating "no declaration" as
 * consent (`CTF-010`, finding 4), and an alert is the last place to repeat that: a
 * false alarm costs an operator a minute, a missed alarm costs a silently dead
 * integration.
 */
import { GaugeName, MetricName, type MetricSnapshot } from "./metrics.js";

/** How urgently an operator must look. */
export const AlertSeverity = {
  /** Something is already broken and will not fix itself. */
  CRITICAL: "CRITICAL",
  /** Degrading; will become CRITICAL if ignored. */
  WARNING: "WARNING",
} as const;

export type AlertSeverity = (typeof AlertSeverity)[keyof typeof AlertSeverity];

/** The four classes AC4 names. Closed set: a fifth needs an ADR, not a constant. */
export const AlertClass = {
  DLQ: "DLQ",
  RENEWAL_FAILURE: "RENEWAL_FAILURE",
  STALE_LEASE: "STALE_LEASE",
  COST_ANOMALY: "COST_ANOMALY",
} as const;

export type AlertClass = (typeof AlertClass)[keyof typeof AlertClass];

/** A firing alert: what, how bad, why, and what an operator should do. */
export interface Alert {
  readonly alertClass: AlertClass;
  readonly severity: AlertSeverity;
  /** The observed number that crossed the threshold. */
  readonly observed: number;
  /** The threshold it crossed. */
  readonly threshold: number;
  /** One line an operator reads first. */
  readonly summary: string;
  /**
   * The runbook step. Present on every alert, because an alert without a response
   * is a notification, and RA-026 AC4 requires a fresh operator to be able to act
   * from the runbook alone.
   */
  readonly runbook: string;
}

/**
 * Thresholds, in one place so they are reviewable as a set.
 *
 * All are overridable per deployment (RA-025 owns the values), but the DEFAULTS are
 * the interesting part: they are deliberately low. A DLQ threshold of 1 says that a
 * single dead-lettered job is worth waking someone — which is right, because a job
 * only reaches the DLQ after exhausting every retry, so it represents work the
 * system has definitively abandoned.
 */
export interface AlertThresholds {
  /** DLQ depth at which the alert fires. Default 1: abandonment is never routine. */
  readonly dlqDepth: number;
  /** Renewal failures at which the alert fires. Default 1. */
  readonly renewalFailures: number;
  /** Stale (past-expiry) leases at which the alert fires. Default 1. */
  readonly staleLeases: number;
  /** Token spend over the window that counts as anomalous. */
  readonly tokenBudget: number;
  /**
   * Queue depth that counts as backed up. Not one of AC4's four, but the signal
   * that distinguishes "cost anomaly because we are busy" from "cost anomaly
   * because something is looping", so it is carried alongside them.
   */
  readonly queueDepth: number;
  /** Oldest runnable job age (ms) that counts as stuck rather than merely deep. */
  readonly queueOldestAgeMs: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = Object.freeze({
  dlqDepth: 1,
  renewalFailures: 1,
  staleLeases: 1,
  tokenBudget: 2_000_000,
  queueDepth: 100,
  queueOldestAgeMs: 15 * 60 * 1000,
});

/**
 * Evaluate all four alert classes against one metric snapshot.
 *
 * Pure, and takes a read-only snapshot rather than the registry, so an alert
 * provably cannot record a metric — which would change the numbers the next rule
 * reads and make evaluation order significant.
 *
 * Returns every firing alert rather than the first: an operator restoring after an
 * outage will trip several at once, and reporting only the highest-severity one
 * hides the others until it is cleared.
 */
export function evaluateAlerts(
  snapshot: MetricSnapshot,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): readonly Alert[] {
  const alerts: Alert[] = [];

  // 1. DLQ. A dead-lettered job exhausted every attempt, so this is work the system
  //    has given up on. Nothing polls the DLQ, so without this alert the job is lost
  //    in the only sense that matters: nobody knows.
  const dlqDepth = snapshot.gauge(GaugeName.DLQ_DEPTH);
  if (dlqDepth >= thresholds.dlqDepth) {
    alerts.push({
      alertClass: AlertClass.DLQ,
      severity: AlertSeverity.CRITICAL,
      observed: dlqDepth,
      threshold: thresholds.dlqDepth,
      summary: `${String(dlqDepth)} job(s) in the dead-letter queue; each exhausted every retry`,
      runbook:
        "List with JobStore.listDeadLettered, read attemptHistory for the cause, fix it, " +
        "then requeue deliberately. Do NOT bulk-requeue: a job that dead-lettered after a " +
        "partial external effect must be reconciled against the provider first.",
    });
  }

  // 2. Renewal failure. The quietest failure in the system: an expired Calendar watch
  //    or a credential that failed to refresh keeps READING successfully for a while,
  //    so the only symptom is that events stop arriving.
  const renewalFailures = snapshot.counter(MetricName.RENEWALS_FAILED);
  if (renewalFailures >= thresholds.renewalFailures) {
    alerts.push({
      alertClass: AlertClass.RENEWAL_FAILURE,
      severity: AlertSeverity.CRITICAL,
      observed: renewalFailures,
      threshold: thresholds.renewalFailures,
      summary: `${String(renewalFailures)} credential or watch renewal(s) failed`,
      runbook:
        "Identify the connection, check its health and credential expiry, then re-run the " +
        "renewal. An AMBIGUOUS credential write is NOT retried automatically — the provider " +
        "may already have issued the new token, and a blind retry destroys it.",
    });
  }

  // 3. Stale lease. A lease held past its expiry with no heartbeat means a worker died,
  //    possibly mid-effect. `CTF-007` found a real production defect in exactly this
  //    area (a missing `pool.on("error")`), so this is not hypothetical.
  const staleLeases = snapshot.gauge(GaugeName.LEASES_STALE);
  if (staleLeases >= thresholds.staleLeases) {
    alerts.push({
      alertClass: AlertClass.STALE_LEASE,
      severity: AlertSeverity.WARNING,
      observed: staleLeases,
      threshold: thresholds.staleLeases,
      summary: `${String(staleLeases)} lease(s) held past expiry with no heartbeat`,
      runbook:
        "The reaper (JobStore.reapExpired) requeues these automatically; the alert exists " +
        "because a RECURRING stale lease means workers are dying rather than finishing. " +
        "WARNING rather than CRITICAL for that reason: recovery is automatic, the pattern " +
        "is what needs a human. A job whose effect may have landed goes to RECONCILING, " +
        "never straight back to the queue.",
    });
  }

  // 4. Cost anomaly. The tool loop retries, and token spend has no natural ceiling, so
  //    unbounded growth produces no failing test and no error — only a bill.
  const inputTokens = snapshot.counter(MetricName.MODEL_INPUT_TOKENS);
  const outputTokens = snapshot.counter(MetricName.MODEL_OUTPUT_TOKENS);
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens >= thresholds.tokenBudget) {
    const queueDepth = snapshot.gauge(GaugeName.QUEUE_DEPTH);
    const oldestAgeMs = snapshot.gauge(GaugeName.QUEUE_OLDEST_AGE_MS);
    // A backed-up queue distinguishes "expensive because we are genuinely busy" from
    // "expensive because something is looping". Both fire, at different severities:
    // spend over budget always needs an operator, but a runaway loop needs one NOW.
    const busy = queueDepth >= thresholds.queueDepth || oldestAgeMs >= thresholds.queueOldestAgeMs;
    alerts.push({
      alertClass: AlertClass.COST_ANOMALY,
      severity: busy ? AlertSeverity.WARNING : AlertSeverity.CRITICAL,
      observed: totalTokens,
      threshold: thresholds.tokenBudget,
      summary:
        `${String(totalTokens)} model tokens consumed against a budget of ` +
        `${String(thresholds.tokenBudget)}` +
        (busy
          ? "; the queue is also backed up, so this may be genuine load"
          : "; the queue is NOT backed up, so spend is growing without work to show for it"),
      runbook:
        "Compare model.invocations against actions.succeeded. A high ratio means the tool " +
        "loop is retrying without converging. The global kill switch stops new external " +
        "effects immediately while preserving reads and evidence (see the kill-switch drill).",
    });
  }

  return alerts;
}

/**
 * Whether every AC4 class is implemented.
 *
 * A startup check, not a test helper. AC4 names four classes; this asserts that
 * {@link evaluateAlerts} can actually produce each one, so a future refactor that
 * drops a rule fails loudly instead of silently reducing coverage to three.
 *
 * Implemented by driving a synthetic snapshot that trips everything, rather than by
 * comparing a hand-written list against `AlertClass` — a list would only prove the
 * constant still exists, not that any code path reaches it.
 */
export function assertAllAlertClassesImplemented(): void {
  const tripped = evaluateAlerts(trippingSnapshot());
  const produced = new Set(tripped.map((alert) => alert.alertClass));
  const missing = Object.values(AlertClass).filter((alertClass) => !produced.has(alertClass));
  if (missing.length > 0) {
    throw new Error(`AC4 violation: no rule can produce alert class(es) ${missing.join(", ")}`);
  }
}

/** A snapshot that trips every rule, for {@link assertAllAlertClassesImplemented}. */
function trippingSnapshot(): MetricSnapshot {
  const counters = new Map<string, number>([
    [MetricName.RENEWALS_FAILED, 1],
    [MetricName.MODEL_INPUT_TOKENS, DEFAULT_ALERT_THRESHOLDS.tokenBudget],
    [MetricName.MODEL_OUTPUT_TOKENS, 1],
  ]);
  const gauges = new Map<string, number>([
    [GaugeName.DLQ_DEPTH, 1],
    [GaugeName.LEASES_STALE, 1],
  ]);
  return {
    counters: [],
    gauges: [],
    counter: (name) => counters.get(name) ?? 0,
    gauge: (name) => gauges.get(name) ?? 0,
  };
}
