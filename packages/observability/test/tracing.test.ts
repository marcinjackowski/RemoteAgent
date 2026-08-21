import { describe, expect, it } from "vitest";

import { SecretRedactor } from "../src/redaction.js";
import {
  LogLevel,
  StructuredLogger,
  TraceRecorder,
  TraceStage,
  assertCausalChain,
  type LogRecord,
  type TraceSpan,
} from "../src/tracing.js";

const TOKEN = "glpat-ABCDEFGHIJKLMNOPQRST";
const HOST_PATH = "/Users/marcin/Private/RemoteAgent/packages/policy/src/scope.ts";
const LITERAL_SECRET = "ra-live-token-4f9c2a";

/** A deterministic clock, so no test depends on wall time. */
function clock(): () => number {
  let t = 1_000;
  return () => {
    t += 10;
    return t;
  };
}

describe("TraceRecorder redacts at the boundary (AC2, traces)", () => {
  it("masks a secret in a span attribute", () => {
    const recorder = new TraceRecorder("trace-1", { now: clock() });
    const span = recorder.startSpan({
      stage: TraceStage.EVENT,
      name: "jira.webhook",
      attributes: { authorization: `Bearer ${TOKEN}`, path: HOST_PATH, issue: "MOBL-1" },
    });
    const serialized = JSON.stringify(span.attributes);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("marcin/Private");
    // Non-sensitive data survives; a redactor that ate everything would be turned off.
    expect(serialized).toContain("MOBL-1");
  });

  it("masks a secret in the span NAME, not only in attributes", () => {
    // A span name derived from an error message carries host paths, and nothing here
    // can distinguish that from a server-owned tool name.
    const recorder = new TraceRecorder("trace-1", { now: clock() });
    const span = recorder.startSpan({ stage: TraceStage.EVENT, name: `failed at ${HOST_PATH}` });
    expect(span.name).not.toContain("marcin/Private");
  });

  it("masks a registered literal that matches no pattern", () => {
    const recorder = new TraceRecorder("trace-1", {
      now: clock(),
      knownSecrets: [LITERAL_SECRET],
    });
    const span = recorder.startSpan({
      stage: TraceStage.EVENT,
      name: "x",
      attributes: { note: `used ${LITERAL_SECRET} to authenticate` },
    });
    expect(JSON.stringify(span.attributes)).not.toContain(LITERAL_SECRET);
  });

  it("masks with NO knownSecrets configured", () => {
    // The `CTF-006` reachability case: the weak construction must still be safe.
    const recorder = new TraceRecorder("trace-1", { now: clock() });
    const span = recorder.startSpan({
      stage: TraceStage.EVENT,
      name: "x",
      attributes: { token: TOKEN, cwd: HOST_PATH },
    });
    expect(JSON.stringify(span.attributes)).not.toContain(TOKEN);
  });

  it("masks a secret nested deep inside an attribute object", () => {
    const recorder = new TraceRecorder("trace-1", { now: clock() });
    const span = recorder.startSpan({
      stage: TraceStage.EVENT,
      name: "x",
      attributes: { outer: { inner: [{ deep: `Bearer ${TOKEN}` }] } },
    });
    expect(JSON.stringify(span.attributes)).not.toContain(TOKEN);
  });

  it("emits every span to the sink, so an exporter sees the same redacted value", () => {
    const seen: TraceSpan[] = [];
    const recorder = new TraceRecorder("trace-1", {
      now: clock(),
      sink: { span: (span) => seen.push(span) },
    });
    recorder.startSpan({ stage: TraceStage.EVENT, name: "x", attributes: { token: TOKEN } });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0]!.attributes)).not.toContain(TOKEN);
  });

  it("gives every span a distinct id and a shared trace id", () => {
    const recorder = new TraceRecorder("trace-1", { now: clock() });
    const a = recorder.startSpan({ stage: TraceStage.EVENT, name: "a" });
    const b = recorder.startSpan({ stage: TraceStage.CASE, name: "b", parentSpanId: a.ids.spanId });
    expect(a.ids.spanId).not.toBe(b.ids.spanId);
    expect(a.ids.traceId).toBe("trace-1");
    expect(b.ids.traceId).toBe("trace-1");
    expect(a.ids.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records the end and status of a span", () => {
    const recorder = new TraceRecorder("trace-1", { now: clock() });
    const span = recorder.startSpan({ stage: TraceStage.EVENT, name: "x" });
    recorder.endSpan(span, "ERROR");
    const recorded = recorder.spans()[0]!;
    expect(recorded.status).toBe("ERROR");
    expect(recorded.endedAtMs).toBeGreaterThan(recorded.startedAtMs);
  });
});

describe("causal chain event -> case -> run -> tool -> action -> receipt", () => {
  /** Build the full, correct chain. */
  function fullChain(): TraceRecorder {
    const recorder = new TraceRecorder("trace-full", { now: clock() });
    const event = recorder.startSpan({ stage: TraceStage.EVENT, name: "jira.webhook" });
    const kase = recorder.startSpan({
      stage: TraceStage.CASE,
      name: "case.open",
      parentSpanId: event.ids.spanId,
      caseId: "case-1",
    });
    const run = recorder.startSpan({
      stage: TraceStage.RUN,
      name: "run.start",
      parentSpanId: kase.ids.spanId,
      caseId: "case-1",
    });
    const tool = recorder.startSpan({
      stage: TraceStage.TOOL,
      name: "jira.issue.comment",
      parentSpanId: run.ids.spanId,
      caseId: "case-1",
    });
    const action = recorder.startSpan({
      stage: TraceStage.ACTION,
      name: "action.execute",
      parentSpanId: tool.ids.spanId,
      caseId: "case-1",
    });
    recorder.startSpan({
      stage: TraceStage.RECEIPT,
      name: "receipt.record",
      parentSpanId: action.ids.spanId,
      caseId: "case-1",
    });
    return recorder;
  }

  it("accepts the complete chain", () => {
    expect(assertCausalChain(fullChain().spans())).toEqual([]);
  });

  it("carries the case id on every span, so it is searchable without a join", () => {
    const spans = fullChain().spans();
    const withCase = spans.filter((span) => span.ids.caseId === "case-1");
    // Every span except the root event, which exists before a case does.
    expect(withCase).toHaveLength(spans.length - 1);
  });

  it("rejects a receipt parented directly to the event, skipping four stages", () => {
    // The violation that matters, and the one that caught a real defect in this
    // function: a first version compared stage RANKS, so `event -> receipt` passed
    // `0 < 5`. The chain looks connected while hiding which action produced the
    // receipt — the one question a receipt exists to answer. Hence adjacency.
    const recorder = new TraceRecorder("trace-skip", { now: clock() });
    const event = recorder.startSpan({ stage: TraceStage.EVENT, name: "e" });
    recorder.startSpan({
      stage: TraceStage.RECEIPT,
      name: "receipt",
      parentSpanId: event.ids.spanId,
    });
    const violations = assertCausalChain(recorder.spans());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("skipped");
  });

  it.each([
    ["case", TraceStage.CASE],
    ["run", TraceStage.RUN],
    ["tool", TraceStage.TOOL],
  ] as const)("rejects a receipt parented to a %s span", (_name, parentStage) => {
    // Every shortcut, not only the longest one: a rank comparison would have accepted
    // all three of these too.
    const recorder = new TraceRecorder(`trace-${parentStage}`, { now: clock() });
    const event = recorder.startSpan({ stage: TraceStage.EVENT, name: "e" });
    const parent = recorder.startSpan({
      stage: parentStage,
      name: "p",
      parentSpanId: event.ids.spanId,
    });
    recorder.startSpan({
      stage: TraceStage.RECEIPT,
      name: "receipt",
      parentSpanId: parent.ids.spanId,
    });
    const violations = assertCausalChain(recorder.spans());
    // The intermediate span may itself be misparented; the receipt violation is the
    // one asserted here.
    expect(violations.some((v) => v.reason.includes("receipt span is parented"))).toBe(true);
  });

  it("allows several tools under one run and several actions under one tool", () => {
    // Adjacency constrains the KIND of a parent, not the number of children. A rule
    // that also required one-to-one would reject every real run.
    const recorder = new TraceRecorder("trace-fan", { now: clock() });
    const event = recorder.startSpan({ stage: TraceStage.EVENT, name: "e" });
    const kase = recorder.startSpan({
      stage: TraceStage.CASE,
      name: "c",
      parentSpanId: event.ids.spanId,
    });
    const run = recorder.startSpan({
      stage: TraceStage.RUN,
      name: "r",
      parentSpanId: kase.ids.spanId,
    });
    for (const toolName of ["read", "patch", "command"]) {
      const tool = recorder.startSpan({
        stage: TraceStage.TOOL,
        name: toolName,
        parentSpanId: run.ids.spanId,
      });
      const action = recorder.startSpan({
        stage: TraceStage.ACTION,
        name: `${toolName}.execute`,
        parentSpanId: tool.ids.spanId,
      });
      recorder.startSpan({
        stage: TraceStage.RECEIPT,
        name: `${toolName}.receipt`,
        parentSpanId: action.ids.spanId,
      });
    }
    expect(assertCausalChain(recorder.spans())).toEqual([]);
  });

  it("rejects an orphan span", () => {
    const recorder = new TraceRecorder("trace-orphan", { now: clock() });
    recorder.startSpan({ stage: TraceStage.EVENT, name: "e" });
    recorder.startSpan({ stage: TraceStage.ACTION, name: "a" });
    const violations = assertCausalChain(recorder.spans());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("no parent");
  });

  it("rejects a dangling parent reference", () => {
    // Reads as a complete chain until someone follows the reference.
    const recorder = new TraceRecorder("trace-dangle", { now: clock() });
    recorder.startSpan({ stage: TraceStage.EVENT, name: "e" });
    recorder.startSpan({ stage: TraceStage.CASE, name: "c", parentSpanId: "ffffffffffffffff" });
    const violations = assertCausalChain(recorder.spans());
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("not in this trace");
  });

  it("rejects an event that claims a parent", () => {
    const recorder = new TraceRecorder("trace-root", { now: clock() });
    const first = recorder.startSpan({ stage: TraceStage.EVENT, name: "e1" });
    recorder.startSpan({ stage: TraceStage.EVENT, name: "e2", parentSpanId: first.ids.spanId });
    expect(assertCausalChain(recorder.spans())).toHaveLength(1);
  });

  it("rejects a run parented to a tool — a later stage causing an earlier one", () => {
    // Backwards, which even a rank comparison catches. Kept so the adjacency rewrite
    // cannot regress the simpler direction.
    const recorder = new TraceRecorder("trace-inv", { now: clock() });
    const event = recorder.startSpan({ stage: TraceStage.EVENT, name: "e" });
    const kase = recorder.startSpan({
      stage: TraceStage.CASE,
      name: "c",
      parentSpanId: event.ids.spanId,
    });
    const tool = recorder.startSpan({
      stage: TraceStage.TOOL,
      name: "t",
      parentSpanId: kase.ids.spanId,
    });
    const run = recorder.startSpan({
      stage: TraceStage.RUN,
      name: "r",
      parentSpanId: tool.ids.spanId,
    });
    const violations = assertCausalChain(recorder.spans());
    // Two, and both are real: the tool skipped `run`, and the run is parented
    // backwards to that tool. Asserted on the specific span rather than on a count,
    // so the test says which violation it means.
    expect(violations.map((v) => v.spanId)).toContain(run.ids.spanId);
    expect(violations.find((v) => v.spanId === run.ids.spanId)!.reason).toContain(
      "parented to a tool span",
    );
  });
});

describe("StructuredLogger redacts at the boundary (AC2, logs)", () => {
  it("masks the message as well as the fields", () => {
    // The most common leak shape: an interpolated error message.
    const logger = new StructuredLogger({ now: clock() });
    const record = logger.error(`build failed at ${HOST_PATH}`, { token: TOKEN });
    expect(record.message).not.toContain("marcin/Private");
    expect(JSON.stringify(record.fields)).not.toContain(TOKEN);
  });

  it("masks with NO knownSecrets configured", () => {
    const logger = new StructuredLogger({ now: clock() });
    const record = logger.info("x", { cwd: HOST_PATH, gitlab: TOKEN });
    expect(JSON.stringify(record.fields)).not.toContain(TOKEN);
    expect(JSON.stringify(record.fields)).not.toContain("marcin/Private");
  });

  it("carries correlation ids on every line", () => {
    const logger = new StructuredLogger({
      now: clock(),
      ids: { traceId: "t-1", spanId: "s-1", caseId: "case-1" },
    });
    expect(logger.info("x").ids).toEqual({ traceId: "t-1", spanId: "s-1", caseId: "case-1" });
  });

  it("a child logger is never weaker than its parent", () => {
    // Load-bearing: rebuilding a redactor from options would drop `knownSecrets`,
    // because they cannot be read back off a SecretRedactor. A per-run child logger
    // would then silently lose exactly the live token it was given.
    const parent = new StructuredLogger({ now: clock(), knownSecrets: [LITERAL_SECRET] });
    const child = parent.child({ caseId: "case-1" });
    const record = child.info(`used ${LITERAL_SECRET}`, { note: LITERAL_SECRET });
    expect(record.message).not.toContain(LITERAL_SECRET);
    expect(JSON.stringify(record.fields)).not.toContain(LITERAL_SECRET);
    expect(record.ids.caseId).toBe("case-1");
  });

  it("a grandchild logger is also not weaker", () => {
    const parent = new StructuredLogger({ now: clock(), knownSecrets: [LITERAL_SECRET] });
    const grandchild = parent.child({ caseId: "c" }).child({ spanId: "s" });
    expect(grandchild.info(LITERAL_SECRET).message).not.toContain(LITERAL_SECRET);
  });

  it("shares an explicitly supplied redactor", () => {
    const redactor = new SecretRedactor({ knownSecrets: [LITERAL_SECRET] });
    const logger = new StructuredLogger({ now: clock(), redactor });
    expect(logger.info(LITERAL_SECRET).message).not.toContain(LITERAL_SECRET);
  });

  it("emits every level to the sink", () => {
    const seen: LogRecord[] = [];
    const logger = new StructuredLogger({ now: clock(), sink: { log: (r) => seen.push(r) } });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(seen.map((r) => r.level)).toEqual([
      LogLevel.DEBUG,
      LogLevel.INFO,
      LogLevel.WARN,
      LogLevel.ERROR,
    ]);
  });
});
