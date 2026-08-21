/**
 * Traces and structured logs across `event → case → run → tool → action → receipt`
 * (RA-024-WU-05, AC2).
 *
 * WHAT THIS IS FOR. The six stages above are the whole causal chain of this system:
 * a Jira webhook becomes a case, which starts a run, which calls a tool, which
 * proposes an action, which produces a receipt. When an owner asks "why did this
 * comment appear on my issue?", the answer must be reconstructible — and every stage
 * currently records its own ids in its own table with no shared correlation.
 *
 * REDACTION IS AT THE EXPORT BOUNDARY, NOT AT THE CALL SITE, and that is the central
 * decision here. `CTF-006` happened because redaction was something callers had to
 * remember: three tables, one weak, applied inconsistently. If a span attribute or a
 * log field could be written unredacted, then AC2 ("canary secrets never appear in
 * logs, traces or model context") would depend on every future caller remembering —
 * which is exactly the assurance model that failed. So {@link StructuredLogger} and
 * {@link TraceRecorder} redact everything on the way out, unconditionally, and there
 * is no method that skips it.
 *
 * WHY NOT THE OTEL SDK. `@opentelemetry/api` is a declared dependency, but the SDK,
 * the exporter and the sampling policy are deployment configuration and belong to
 * RA-025. Attaching a real `TracerProvider` later requires no call-site change: the
 * recorder below produces spans with W3C-shaped ids and the same
 * parent/child/attribute structure, so an exporter can be bolted on at the boundary.
 * Keeping the SDK out also keeps this package importable from every other package,
 * which `CTF-006` showed is a security property and not a convenience.
 */
import { maskSecretShapes } from "./secret-patterns.js";
import { SecretRedactor } from "./redaction.js";

/**
 * The six stages of the causal chain, in order.
 *
 * Ordered and closed, so {@link assertCausalChain} can verify that a span's parent is
 * an earlier stage. A receipt whose parent is an event rather than an action means a
 * stage was skipped, and a skipped stage is precisely what makes "why did this
 * happen?" unanswerable.
 */
export const TraceStage = {
  EVENT: "event",
  CASE: "case",
  RUN: "run",
  TOOL: "tool",
  ACTION: "action",
  RECEIPT: "receipt",
} as const;

export type TraceStage = (typeof TraceStage)[keyof typeof TraceStage];

const STAGE_ORDER: readonly TraceStage[] = [
  TraceStage.EVENT,
  TraceStage.CASE,
  TraceStage.RUN,
  TraceStage.TOOL,
  TraceStage.ACTION,
  TraceStage.RECEIPT,
];

/** Rank of a stage in the chain; `-1` for an unknown stage. */
export function stageRank(stage: string): number {
  return STAGE_ORDER.indexOf(stage as TraceStage);
}

/**
 * Correlation ids carried on every span and every log line.
 *
 * `traceId` is the whole chain; `spanId` is one stage. `caseId` is denormalised onto
 * every span deliberately: it is the id an operator actually searches by, and
 * requiring a join back to the root span to find it would make the common query the
 * expensive one.
 */
export interface CorrelationIds {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly caseId?: string;
}

/** One recorded span. */
export interface TraceSpan {
  readonly stage: TraceStage;
  /** Operation name, e.g. `jira.issue.comment`. */
  readonly name: string;
  readonly ids: CorrelationIds;
  /** Attributes, ALREADY redacted — the recorder redacts on the way in. */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly startedAtMs: number;
  endedAtMs?: number;
  status?: "OK" | "ERROR";
}

/** Severity of a structured log line. */
export const LogLevel = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** One structured log line, with correlation ids and redacted fields. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly ids: Partial<CorrelationIds>;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly atMs: number;
}

/** Where a recorded span or log line goes. Supplied by the host process. */
export interface TelemetrySink {
  span?(span: TraceSpan): void;
  log?(record: LogRecord): void;
}

/** Options shared by the recorder and the logger. */
export interface TelemetryOptions {
  /**
   * Literal secret values this process knows — a live token, the workspace root.
   *
   * The shared pattern table cannot recognise these (a bare token matches no shape),
   * so a caller that HAS them must pass them. A caller that does not is still
   * covered for every recognisable shape, which is the `CTF-006` fix: the
   * no-arguments case is safe, not merely less safe.
   */
  readonly knownSecrets?: readonly string[];
  /** Monotonic clock, injected so tests are deterministic. */
  readonly now?: () => number;
  readonly sink?: TelemetrySink;
  /**
   * An already-configured redactor to share.
   *
   * Used by {@link StructuredLogger.child} so a derived logger cannot end up weaker
   * than the one it came from. Takes precedence over `knownSecrets`; passing both is
   * a caller error, and the redactor wins because it is the stronger of the two.
   */
  readonly redactor?: SecretRedactor;
}

/** 16 hex chars — a W3C span id. Derived from a counter, not from randomness. */
function spanIdFrom(traceId: string, sequence: number): string {
  // Deterministic so a resumed workflow produces stable ids and so tests do not
  // depend on `Math.random`. Derived from the trace id so two chains never collide.
  let hash = 0x811c9dc5;
  const material = `${traceId}:${String(sequence)}`;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(2);
}

/**
 * Records the causal chain, redacting every attribute on the way in.
 *
 * There is no method that records an unredacted attribute. That is the point: AC2
 * cannot depend on callers remembering, because `CTF-006` is the record of what
 * happens when it does.
 */
export class TraceRecorder {
  readonly #redactor: SecretRedactor;
  readonly #now: () => number;
  readonly #sink: TelemetrySink | undefined;
  readonly #spans: TraceSpan[] = [];
  #sequence = 0;

  public constructor(
    public readonly traceId: string,
    options: TelemetryOptions = {},
  ) {
    this.#redactor =
      options.redactor ??
      new SecretRedactor(
        options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets },
      );
    this.#now = options.now ?? (() => Date.now());
    this.#sink = options.sink;
  }

  /**
   * Start a span at one stage of the chain.
   *
   * `parent` is required for every stage except `event`, and
   * {@link assertCausalChain} verifies the ordering afterwards. Not enforced here as
   * a throw, because a partially-recorded chain is still evidence and losing it to
   * an exception during an incident would be the worse trade — the assertion is a
   * gate, and telemetry must not be able to fail the operation it describes.
   */
  public startSpan(input: {
    stage: TraceStage;
    name: string;
    parentSpanId?: string;
    caseId?: string;
    attributes?: Record<string, unknown>;
  }): TraceSpan {
    this.#sequence += 1;
    const span: TraceSpan = {
      stage: input.stage,
      // The operation NAME is redacted too. A tool name is server-owned and safe, but
      // an error-derived span name is not, and there is no way to tell them apart
      // here — so the safe direction is applied to both.
      name: maskSecretShapes(input.name),
      ids: {
        traceId: this.traceId,
        spanId: spanIdFrom(this.traceId, this.#sequence),
        ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
        ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      },
      attributes: this.#redactAttributes(input.attributes ?? {}),
      startedAtMs: this.#now(),
    };
    this.#spans.push(span);
    this.#sink?.span?.(span);
    return span;
  }

  /** Close a span. */
  public endSpan(span: TraceSpan, status: "OK" | "ERROR" = "OK"): void {
    const recorded = this.#spans.find((candidate) => candidate.ids.spanId === span.ids.spanId);
    if (recorded === undefined) return;
    recorded.endedAtMs = this.#now();
    recorded.status = status;
    this.#sink?.span?.(recorded);
  }

  /** Every span recorded on this trace, in start order. */
  public spans(): readonly TraceSpan[] {
    return [...this.#spans];
  }

  #redactAttributes(attributes: Record<string, unknown>): Readonly<Record<string, unknown>> {
    // `redact` handles the key-name rule (`authorization`, a bare `token`) as well as
    // the value shapes, which a plain string pass would miss.
    return this.#redactor.redact(attributes) as Readonly<Record<string, unknown>>;
  }
}

/**
 * Structured logging with correlation ids, redacted on the way out.
 *
 * Same rule as the recorder: there is no unredacted path. `message` is redacted as
 * well as `fields`, because the single most common leak is an interpolated error
 * message — which is how absolute host paths reach logs in the first place.
 */
export class StructuredLogger {
  readonly #redactor: SecretRedactor;
  readonly #now: () => number;
  readonly #sink: TelemetrySink | undefined;
  readonly #ids: Partial<CorrelationIds>;
  readonly #records: LogRecord[] = [];

  public constructor(options: TelemetryOptions & { ids?: Partial<CorrelationIds> } = {}) {
    this.#redactor =
      options.redactor ??
      new SecretRedactor(
        options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets },
      );
    this.#now = options.now ?? (() => Date.now());
    this.#sink = options.sink;
    this.#ids = options.ids ?? {};
  }

  /**
   * A logger bound to more specific correlation ids.
   *
   * The child SHARES the parent's redactor instance rather than constructing one
   * from an option set. That is load-bearing: rebuilding from options would drop
   * `knownSecrets` (they are not readable back off a `SecretRedactor`), so a child
   * would be silently weaker than its parent — a per-run logger losing exactly the
   * live token it was given. A test asserts the child still masks the parent's
   * registered secrets, because "shares the redactor" is a claim, not evidence.
   */
  public child(ids: Partial<CorrelationIds>): StructuredLogger {
    return new StructuredLogger({
      now: this.#now,
      ...(this.#sink === undefined ? {} : { sink: this.#sink }),
      ids: { ...this.#ids, ...ids },
      redactor: this.#redactor,
    });
  }

  public log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): LogRecord {
    const record: LogRecord = {
      level,
      // The MESSAGE is redacted as well as the fields. The most common leak in this
      // repository's history is an interpolated error message: that is how absolute
      // host paths reach logs at all.
      message: this.#redactor.redactString(message),
      ids: this.#ids,
      fields: this.#redactor.redact(fields) as Readonly<Record<string, unknown>>,
      atMs: this.#now(),
    };
    this.#records.push(record);
    this.#sink?.log?.(record);
    return record;
  }

  public debug(message: string, fields?: Record<string, unknown>): LogRecord {
    return this.log(LogLevel.DEBUG, message, fields);
  }
  public info(message: string, fields?: Record<string, unknown>): LogRecord {
    return this.log(LogLevel.INFO, message, fields);
  }
  public warn(message: string, fields?: Record<string, unknown>): LogRecord {
    return this.log(LogLevel.WARN, message, fields);
  }
  public error(message: string, fields?: Record<string, unknown>): LogRecord {
    return this.log(LogLevel.ERROR, message, fields);
  }

  /** Every record this logger produced. */
  public records(): readonly LogRecord[] {
    return [...this.#records];
  }
}

/** Why a recorded chain is not a valid `event → … → receipt` causal chain. */
export interface CausalChainViolation {
  readonly spanId: string;
  readonly reason: string;
}

/**
 * Verify that a recorded trace really is the causal chain AC's telemetry clause
 * requires, rather than a bag of spans sharing a trace id.
 *
 * Three things are checked, and each corresponds to a way the chain becomes useless
 * without becoming obviously broken:
 *
 *   1. every non-`event` span has a parent — an orphan span cannot be placed in the
 *      story at all;
 *   2. every parent exists in the same trace — a dangling reference reads as a
 *      complete chain until someone follows it;
 *   3. a parent's stage is the one IMMEDIATELY before the child's.
 *
 * The third rule is adjacency, not merely "earlier", and the distinction is the
 * whole value of this function. A first version compared stage ranks — and a test
 * caught that `event → receipt` satisfied `0 < 5` and passed. That chain looks
 * connected while hiding which action produced the receipt, which is the one
 * question a receipt exists to answer. "Earlier" would also accept
 * `case → receipt`, `run → receipt` and every other shortcut.
 *
 * Adjacency is strict on purpose. Multiple tools under one run and multiple actions
 * under one tool are all still valid — adjacency constrains the KIND of the parent,
 * not how many children a span may have. If a future stage genuinely needs to be
 * skippable, that is a deliberate change with a stated reason, not something a
 * loose comparison should allow by accident.
 *
 * Returns violations rather than throwing, so a caller can record the fact that its
 * telemetry is incomplete instead of failing the operation it was describing.
 */
export function assertCausalChain(spans: readonly TraceSpan[]): readonly CausalChainViolation[] {
  const violations: CausalChainViolation[] = [];
  const byId = new Map(spans.map((span) => [span.ids.spanId, span]));

  for (const span of spans) {
    const parentId = span.ids.parentSpanId;
    if (span.stage === TraceStage.EVENT) {
      // An event is a root: it is caused by the outside world, not by us.
      if (parentId !== undefined) {
        violations.push({
          spanId: span.ids.spanId,
          reason: `event span has parent ${parentId}; an event is caused outside the system`,
        });
      }
      continue;
    }
    if (parentId === undefined) {
      violations.push({
        spanId: span.ids.spanId,
        reason: `${span.stage} span has no parent, so it cannot be placed in the chain`,
      });
      continue;
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      violations.push({
        spanId: span.ids.spanId,
        reason: `parent ${parentId} is not in this trace`,
      });
      continue;
    }
    const expected = STAGE_ORDER[stageRank(span.stage) - 1];
    if (parent.stage !== expected) {
      violations.push({
        spanId: span.ids.spanId,
        reason:
          `${span.stage} span is parented to a ${parent.stage} span; ` +
          `the immediately earlier stage ${String(expected)} was skipped`,
      });
    }
  }
  return violations;
}
