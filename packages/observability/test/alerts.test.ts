import { describe, expect, it } from "vitest";

import {
  AlertClass,
  AlertSeverity,
  DEFAULT_ALERT_THRESHOLDS,
  assertAllAlertClassesImplemented,
  evaluateAlerts,
} from "../src/alerts.js";
import {
  GaugeName,
  MetricName,
  MetricRegistry,
  type MetricSnapshot,
} from "../src/metrics.js";
import { HealthState, liveness, readiness } from "../src/health.js";

function snapshotWith(build: (registry: MetricRegistry) => void): MetricSnapshot {
  const registry = new MetricRegistry();
  build(registry);
  return registry.snapshot();
}

describe("AC4: all four alert classes exist and fire", () => {
  it("a quiet system fires nothing", () => {
    expect(evaluateAlerts(snapshotWith(() => {}))).toEqual([]);
  });

  it("every one of the four classes is reachable from some snapshot", () => {
    // Driven rather than asserted against a hand-written list: a list would only
    // prove the constant still exists, not that any code path produces it.
    expect(() => assertAllAlertClassesImplemented()).not.toThrow();
  });

  it("DLQ: a single dead-lettered job is CRITICAL", () => {
    // Threshold 1 on purpose: a job reaches the DLQ only after exhausting every
    // retry, so it is work the system has definitively abandoned, and nothing polls
    // the DLQ. "Routine" is not an available reading.
    const alerts = evaluateAlerts(
      snapshotWith((r) => r.setGauge(GaugeName.DLQ_DEPTH, 1)),
    );
    expect(alerts.map((a) => a.alertClass)).toEqual([AlertClass.DLQ]);
    expect(alerts[0]!.severity).toBe(AlertSeverity.CRITICAL);
    expect(alerts[0]!.runbook).toContain("Do NOT bulk-requeue");
  });

  it("RENEWAL_FAILURE: one failed renewal is CRITICAL", () => {
    const alerts = evaluateAlerts(
      snapshotWith((r) => r.increment(MetricName.RENEWALS_FAILED, 1, { provider: "calendar" })),
    );
    expect(alerts.map((a) => a.alertClass)).toEqual([AlertClass.RENEWAL_FAILURE]);
    expect(alerts[0]!.severity).toBe(AlertSeverity.CRITICAL);
    // A blind retry of an ambiguous credential write destroys a token the provider
    // already issued, so the runbook must say so rather than "retry".
    expect(alerts[0]!.runbook).toContain("NOT retried automatically");
  });

  it("RENEWAL_FAILURE does not fire on successful renewals", () => {
    const alerts = evaluateAlerts(
      snapshotWith((r) => r.increment(MetricName.RENEWALS_SUCCEEDED, 50)),
    );
    expect(alerts).toEqual([]);
  });

  it("STALE_LEASE: a past-expiry lease is WARNING, because recovery is automatic", () => {
    const alerts = evaluateAlerts(snapshotWith((r) => r.setGauge(GaugeName.LEASES_STALE, 2)));
    expect(alerts.map((a) => a.alertClass)).toEqual([AlertClass.STALE_LEASE]);
    // WARNING not CRITICAL: the reaper requeues these. The PATTERN needs a human,
    // not the individual event.
    expect(alerts[0]!.severity).toBe(AlertSeverity.WARNING);
    expect(alerts[0]!.runbook).toContain("RECONCILING");
  });

  it("STALE_LEASE does not fire merely because leases are held", () => {
    const alerts = evaluateAlerts(snapshotWith((r) => r.setGauge(GaugeName.LEASES_HELD, 20)));
    expect(alerts).toEqual([]);
  });

  it("COST_ANOMALY: spend over budget with an EMPTY queue is CRITICAL", () => {
    // The dangerous shape: spend growing with no work to show for it, i.e. a loop.
    const alerts = evaluateAlerts(
      snapshotWith((r) => {
        r.increment(MetricName.MODEL_INPUT_TOKENS, DEFAULT_ALERT_THRESHOLDS.tokenBudget);
        r.increment(MetricName.MODEL_OUTPUT_TOKENS, 1);
      }),
    );
    expect(alerts.map((a) => a.alertClass)).toEqual([AlertClass.COST_ANOMALY]);
    expect(alerts[0]!.severity).toBe(AlertSeverity.CRITICAL);
    expect(alerts[0]!.summary).toContain("NOT backed up");
  });

  it("COST_ANOMALY: the same spend with a backed-up queue is WARNING", () => {
    const alerts = evaluateAlerts(
      snapshotWith((r) => {
        r.increment(MetricName.MODEL_INPUT_TOKENS, DEFAULT_ALERT_THRESHOLDS.tokenBudget);
        r.setGauge(GaugeName.QUEUE_DEPTH, DEFAULT_ALERT_THRESHOLDS.queueDepth);
      }),
    );
    expect(alerts[0]!.alertClass).toBe(AlertClass.COST_ANOMALY);
    expect(alerts[0]!.severity).toBe(AlertSeverity.WARNING);
  });

  it("COST_ANOMALY counts input and output tokens together", () => {
    // Splitting the budget across two counters would let each stay under it while
    // total spend doubled.
    const half = DEFAULT_ALERT_THRESHOLDS.tokenBudget / 2;
    const alerts = evaluateAlerts(
      snapshotWith((r) => {
        r.increment(MetricName.MODEL_INPUT_TOKENS, half);
        r.increment(MetricName.MODEL_OUTPUT_TOKENS, half);
      }),
    );
    expect(alerts.map((a) => a.alertClass)).toEqual([AlertClass.COST_ANOMALY]);
  });

  it("reports EVERY firing alert, not just the most severe", () => {
    // An operator restoring after an outage trips several at once; reporting only the
    // worst hides the rest until it is cleared.
    const alerts = evaluateAlerts(
      snapshotWith((r) => {
        r.setGauge(GaugeName.DLQ_DEPTH, 3);
        r.setGauge(GaugeName.LEASES_STALE, 1);
        r.increment(MetricName.RENEWALS_FAILED, 2);
        r.increment(MetricName.MODEL_INPUT_TOKENS, DEFAULT_ALERT_THRESHOLDS.tokenBudget);
      }),
    );
    expect(new Set(alerts.map((a) => a.alertClass))).toEqual(
      new Set(Object.values(AlertClass)),
    );
  });

  it("every alert carries a runbook, so it is actionable and not a notification", () => {
    const alerts = evaluateAlerts(
      snapshotWith((r) => {
        r.setGauge(GaugeName.DLQ_DEPTH, 1);
        r.setGauge(GaugeName.LEASES_STALE, 1);
        r.increment(MetricName.RENEWALS_FAILED, 1);
        r.increment(MetricName.MODEL_INPUT_TOKENS, DEFAULT_ALERT_THRESHOLDS.tokenBudget);
      }),
    );
    for (const alert of alerts) {
      expect(alert.runbook.length, `${alert.alertClass} has no runbook`).toBeGreaterThan(40);
      expect(alert.observed).toBeGreaterThanOrEqual(alert.threshold);
    }
  });

  it("honours overridden thresholds", () => {
    const quiet = evaluateAlerts(snapshotWith((r) => r.setGauge(GaugeName.DLQ_DEPTH, 4)), {
      ...DEFAULT_ALERT_THRESHOLDS,
      dlqDepth: 5,
    });
    expect(quiet).toEqual([]);
  });

  it("cannot record a metric while evaluating", () => {
    // Alerts take a read-only snapshot. An alert that recorded would change the
    // numbers the next rule reads and make evaluation order significant.
    const snapshot = snapshotWith((r) => r.setGauge(GaugeName.DLQ_DEPTH, 1));
    expect(Reflect.get(snapshot, "increment")).toBeUndefined();
    expect(Reflect.get(snapshot, "setGauge")).toBeUndefined();
  });
});

describe("MetricRegistry", () => {
  it("sums a counter across label sets", () => {
    const registry = new MetricRegistry();
    registry.increment(MetricName.RENEWALS_FAILED, 1, { provider: "gmail" });
    registry.increment(MetricName.RENEWALS_FAILED, 2, { provider: "calendar" });
    expect(registry.counter(MetricName.RENEWALS_FAILED)).toBe(3);
    expect(registry.counter(MetricName.RENEWALS_FAILED, { provider: "gmail" })).toBe(1);
  });

  it("treats label order as irrelevant to series identity", () => {
    const registry = new MetricRegistry();
    registry.increment(MetricName.JOBS_RETRIED, 1, { provider: "jira", kind: "sync" });
    registry.increment(MetricName.JOBS_RETRIED, 1, { kind: "sync", provider: "jira" });
    expect(registry.counter(MetricName.JOBS_RETRIED, { provider: "jira", kind: "sync" })).toBe(2);
  });

  it.each([
    ["worst last", [1, 3, 7]],
    ["worst first", [7, 3, 1]],
    ["worst in the middle", [3, 7, 1]],
  ] as const)(
    "takes the HIGHEST gauge across labels, so one bad shard still alerts (%s)",
    (_name, values) => {
      // Three DISTINCT non-zero values in three orders, and both weaker
      // implementations are excluded by construction:
      //
      //   - `[0, 7]` alone let "last wins" pass, because iteration follows insertion
      //     order and the worst value happened to be last;
      //   - `[0, 7]` and `[7, 0]` together let "first non-zero wins" pass, because 7
      //     was the only non-zero value in both.
      //
      // Both survived a mutation run and were caught by it, which is why this looks
      // over-specified. Averaging, first-wins and last-wins all now fail at least one
      // ordering. The consequence of getting this wrong is a healthy provider masking
      // a broken one — silent DLQ abandonment.
      const registry = new MetricRegistry();
      const providers = ["jira", "gitlab", "gmail"] as const;
      values.forEach((value, index) => {
        registry.setGauge(GaugeName.DLQ_DEPTH, value, { provider: providers[index]! });
      });
      expect(registry.gauge(GaugeName.DLQ_DEPTH)).toBe(7);
    },
  );

  it("alerts on the worst shard even when a healthy shard was recorded later", () => {
    // The consequence, asserted end to end rather than only on the accessor.
    const registry = new MetricRegistry();
    registry.setGauge(GaugeName.DLQ_DEPTH, 5, { provider: "gitlab" });
    registry.setGauge(GaugeName.DLQ_DEPTH, 0, { provider: "jira" });
    const alerts = evaluateAlerts(registry.snapshot());
    expect(alerts.map((a) => a.alertClass)).toEqual([AlertClass.DLQ]);
    expect(alerts[0]!.observed).toBe(5);
  });

  it("refuses a negative counter delta", () => {
    const registry = new MetricRegistry();
    expect(() => registry.increment(MetricName.JOBS_RETRIED, -1)).toThrow(RangeError);
  });

  it("refuses a non-finite gauge", () => {
    const registry = new MetricRegistry();
    expect(() => registry.setGauge(GaugeName.QUEUE_DEPTH, Number.NaN)).toThrow(RangeError);
  });

  it("reports zero for an unrecorded metric rather than undefined", () => {
    // An alert predicate comparing `undefined >= 1` is silently false, which is
    // fail-quiet — the direction this repository has been burned by.
    const registry = new MetricRegistry();
    expect(registry.counter(MetricName.RENEWALS_FAILED)).toBe(0);
    expect(registry.gauge(GaugeName.DLQ_DEPTH)).toBe(0);
  });
});

describe("health and readiness are different questions", () => {
  const base = { processResponsive: true, databaseReachable: true, killSwitchActive: false };

  it("both UP when everything is fine", () => {
    expect(liveness(base).state).toBe(HealthState.UP);
    expect(readiness(base).state).toBe(HealthState.UP);
  });

  it("a database outage makes the process UNREADY but still ALIVE", () => {
    // The load-bearing case. Reporting unhealthy would restart-loop every worker
    // during the exact incident when their in-flight leases and logs are the only
    // available evidence — turning a recoverable outage into evidence loss.
    const input = { ...base, databaseReachable: false };
    expect(liveness(input).state).toBe(HealthState.UP);
    expect(readiness(input).state).toBe(HealthState.DEGRADED);
  });

  it("an unresponsive process is DOWN on both", () => {
    const input = { ...base, processResponsive: false };
    expect(liveness(input).state).toBe(HealthState.DOWN);
    expect(readiness(input).state).toBe(HealthState.DOWN);
  });

  it("a kill switch changes NEITHER verdict, but is reported", () => {
    // AC6: a kill switch stops external effects while preserving reads and evidence.
    // Reporting unready would stop the reconciliation and audit reads an operator
    // needs mid-incident.
    const input = { ...base, killSwitchActive: true };
    expect(liveness(input).state).toBe(HealthState.UP);
    expect(readiness(input).state).toBe(HealthState.UP);
    expect(readiness(input).checks.map((c) => c.name)).toContain("kill_switch");
    expect(liveness(input).checks.map((c) => c.name)).toContain("kill_switch");
  });

  it("a draining worker is UNREADY but ALIVE", () => {
    const input = { ...base, draining: true };
    expect(liveness(input).state).toBe(HealthState.UP);
    expect(readiness(input).state).toBe(HealthState.DEGRADED);
  });

  it("liveness does not depend on the database at all", () => {
    // Stated as a structural assertion, not just a state check: if `postgres` ever
    // appears in the liveness report, someone has made a restart the response to a
    // database outage.
    expect(liveness({ ...base, databaseReachable: false }).checks.map((c) => c.name)).not.toContain(
      "postgres",
    );
  });
});
