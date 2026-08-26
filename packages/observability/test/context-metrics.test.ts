import { describe, expect, it } from "vitest";

import { ContextCacheState, MetricName, MetricRegistry } from "../src/metrics.js";

describe("context metrics", () => {
  it("keeps actual and estimated input tokens in distinct series", () => {
    const metrics = new MetricRegistry();
    metrics.increment(MetricName.CONTEXT_ESTIMATED_INPUT_TOKENS, 100, { kind: "DISCOVERY" });
    metrics.increment(MetricName.MODEL_INPUT_TOKENS, 37, { kind: "SUPERVISOR" });

    expect(metrics.counter(MetricName.CONTEXT_ESTIMATED_INPUT_TOKENS)).toBe(100);
    expect(metrics.counter(MetricName.MODEL_INPUT_TOKENS)).toBe(37);
  });

  it("represents absent cache evidence explicitly without sensitive labels", () => {
    const metrics = new MetricRegistry();
    metrics.increment(MetricName.CONTEXT_CACHE_OBSERVATIONS, 1, {
      kind: "DISCOVERY",
      outcome: ContextCacheState.NOT_OBSERVED,
    });

    const sample = metrics
      .snapshot()
      .counters.find(({ name }) => name === MetricName.CONTEXT_CACHE_OBSERVATIONS);
    expect(sample).toEqual({
      name: MetricName.CONTEXT_CACHE_OBSERVATIONS,
      labels: { kind: "DISCOVERY", outcome: "NOT_OBSERVED" },
      value: 1,
    });
    expect(sample?.labels).not.toHaveProperty("case_id");
    expect(sample?.labels).not.toHaveProperty("owner_id");
    expect(sample?.labels).not.toHaveProperty("ref");
  });

  it("redacts and freeze-copies telemetry labels at the registry boundary", () => {
    const labels = { kind: "owner@example.test", outcome: "+48 501 234 567 /Users/alice/repo" };
    const metrics = new MetricRegistry();
    metrics.increment(MetricName.CONTEXT_CACHE_OBSERVATIONS, 1, labels);
    labels.kind = "mutated-after-recording";

    const sample = metrics.snapshot().counters[0]!;
    expect(JSON.stringify(sample)).not.toMatch(/owner@example\.test|501 234|Users\/alice/);
    expect(JSON.stringify(sample)).toContain("[REDACTED]");
    expect(sample.labels.kind).not.toBe("mutated-after-recording");
    expect(Object.isFrozen(sample.labels)).toBe(true);
    expect(
      metrics.counter(MetricName.CONTEXT_CACHE_OBSERVATIONS, {
        kind: "owner@example.test",
        outcome: "+48 501 234 567 /Users/alice/repo",
      }),
    ).toBe(1);
  });

  it("redacts a registered opaque literal from telemetry", () => {
    const metrics = new MetricRegistry(["opaque-canary-no-shape"]);
    metrics.increment(MetricName.CONTEXT_CACHE_OBSERVATIONS, 1, {
      kind: "opaque-canary-no-shape",
    });
    expect(JSON.stringify(metrics.snapshot().counters)).not.toContain("opaque-canary-no-shape");
  });

  it("keeps engineering telemetry on closed stage/outcome dimensions", () => {
    const metrics = new MetricRegistry();
    metrics.increment(MetricName.ENGINEERING_STAGE_TRANSITIONS, 1, {
      kind: "SLICE_REVIEW",
      outcome: "ARTIFACT_RECORDED",
    });
    metrics.increment(MetricName.ENGINEERING_TERMINALS, 1, {
      kind: "workflow",
      outcome: "NO_PROGRESS",
    });
    expect(metrics.counter(MetricName.ENGINEERING_STAGE_TRANSITIONS)).toBe(1);
    expect(metrics.counter(MetricName.ENGINEERING_TERMINALS)).toBe(1);
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(
      /case_id|owner_id|run_id|work_unit_id|operation_id|checkpoint_revision/u,
    );
  });
});
