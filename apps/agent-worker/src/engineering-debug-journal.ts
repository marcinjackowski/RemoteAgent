/** Bounded, content-free diagnostic journal for one Engineering invocation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { canonicalDigest, sha256Digest } from "@remoteagent/contracts";
import type { Database, JobLease } from "@remoteagent/database";
import {
  implementationToolResult,
  type ImplementationToolResult,
} from "@remoteagent/implementation-tools";
import type { StructuredLogger } from "@remoteagent/observability";
import type {
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeTransport,
  RuntimeUsage,
} from "@remoteagent/bedrock-runtime";
import * as z from "zod";

const id = z.string().min(1).max(512);
const boundedName = z.string().min(1).max(128);
export const ENGINEERING_MODEL_HARD_TOKEN_LIMIT = 250_000;
export const ENGINEERING_MODEL_CALL_TOKEN_RESERVE = 35_000;
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !isAbsolute(value) && !value.split(/[/\\]+/u).includes(".."));

const usage = z.strictObject({
  event: z.literal("MODEL_USAGE"),
  stage: boundedName.nullable(),
  responses: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  responses_without_usage: z.number().int().nonnegative(),
  responses_with_partial_usage: z.number().int().nonnegative(),
  comparison: z.enum(["TARGET", "WARNING", "HARD_LIMIT"]),
});

const toolBatch = z.strictObject({
  event: z.literal("TOOL_BATCH"),
  tools: z
    .array(
      z.strictObject({
        name: boundedName,
        relative_path: relativePath.nullable(),
        query_digest: sha256Digest.nullable(),
        files: z.array(relativePath).max(64),
        input_keys: z.array(boundedName).max(32),
      }),
    )
    .min(1)
    .max(64),
});

const toolResult = z.strictObject({
  event: z.literal("TOOL_RESULT"),
  kind: boundedName,
  outcome: z.enum(["SUCCEEDED", "FAILED", "AMBIGUOUS"]),
  failure_code: boundedName.nullable(),
  changed_files: z.array(relativePath).max(512),
  operation_id_digest: sha256Digest.nullable(),
  output_truncated: z.boolean(),
});

const debugEvent = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("RUN_STARTED"),
    case_id: id,
    run_id: id,
    model: boundedName,
    base_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    config_digest: sha256Digest,
  }),
  usage,
  toolBatch,
  toolResult,
  z.strictObject({
    event: z.literal("MODEL_OUTPUT_SHAPE"),
    keys: z.array(boundedName).max(64),
    artifact_kind: boundedName.nullable(),
    changed_files: z.array(relativePath).max(512).nullable(),
  }),
  z.strictObject({
    event: z.literal("STAGE_ERROR"),
    stage: boundedName,
    error_name: boundedName,
    error_digest: sha256Digest,
  }),
  z.strictObject({
    event: z.literal("GATE_BOUNDARY_ERROR"),
    gate_id: boundedName,
    target: boundedName,
    phase: boundedName,
    error_name: boundedName,
    error_code: boundedName.nullable(),
    protected_changes: z
      .array(
        z.strictObject({
          relative_path: relativePath,
          change: z.enum(["ADDED", "REMOVED", "MODIFIED"]),
        }),
      )
      .max(128),
    error_digest: sha256Digest,
  }),
  z.strictObject({
    event: z.literal("RUN_DIAGNOSTIC"),
    artifacts: z
      .array(
        z.strictObject({
          artifact_kind: boundedName,
          stage: boundedName,
          stage_attempt: z.number().int().positive(),
        }),
      )
      .max(512),
    operations: z
      .array(
        z.strictObject({
          stage: boundedName,
          stage_attempt: z.number().int().positive(),
          effect_class: boundedName,
          started: z.boolean(),
          completed: z.boolean(),
        }),
      )
      .max(512),
    gate_receipts: z
      .array(
        z.strictObject({
          gate_id: boundedName,
          target: boundedName,
          outcome: boundedName,
          exit_code: z.number().int().nullable(),
          duration_ms: z.number().int().nonnegative(),
          tree_digest: sha256Digest,
          config_digest: sha256Digest,
          command_digest: sha256Digest,
          log_digest: sha256Digest.nullable(),
        }),
      )
      .max(512),
    error_digest: sha256Digest.nullable(),
  }),
  z.strictObject({
    event: z.literal("RUN_COMPLETED"),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    artifact_kinds: z.array(boundedName).max(512),
  }),
]);

export type EngineeringDebugEvent = z.infer<typeof debugEvent>;

type UsageTotals = {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responsesWithoutUsage: number;
  responsesWithPartialUsage: number;
};

type JournalContext = {
  readonly journal: EngineeringDebugJournal;
  readonly state: { usage: UsageTotals };
  readonly stage: string | null;
};

const journalContext = new AsyncLocalStorage<JournalContext>();

type StoredEvent = EngineeringDebugEvent & {
  schema_version: 1;
  sequence: number;
  recorded_at: string;
};

export function engineeringDebugErrorDigest(error: unknown): string {
  return canonicalDigest({
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "unknown",
  });
}

function safeName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 ? value : fallback;
}

function safeRelativePath(value: unknown): string | null {
  const parsed = relativePath.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function jsonObject(value: RuntimeJsonValue): Readonly<Record<string, RuntimeJsonValue>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requestedFiles(input: Readonly<Record<string, RuntimeJsonValue>>): string[] {
  const candidate = Array.isArray(input.files)
    ? input.files
    : Array.isArray(input.replacement_files)
      ? input.replacement_files
      : [];
  return candidate
    .slice(0, 64)
    .map((entry) => {
      const object =
        entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
      return safeRelativePath(object?.relative_path);
    })
    .filter((value): value is string => value !== null);
}

function toolBatchEvent(content: readonly RuntimeContent[]): EngineeringDebugEvent | null {
  const tools = content
    .filter(
      (item): item is Extract<RuntimeContent, { type: "tool-use" }> => item.type === "tool-use",
    )
    .slice(0, 64)
    .map((item) => {
      const input = jsonObject(item.input) ?? {};
      const query = typeof input.query === "string" ? input.query : null;
      return {
        name: safeName(item.name, "INVALID_TOOL_NAME"),
        relative_path: safeRelativePath(input.relative_path),
        query_digest: query === null ? null : canonicalDigest({ query }),
        files: requestedFiles(input),
        input_keys: Object.keys(input)
          .filter((key) => key.length >= 1 && key.length <= 128)
          .sort()
          .slice(0, 32),
      };
    });
  return tools.length === 0 ? null : { event: "TOOL_BATCH", tools };
}

function outputShapeEvents(content: readonly RuntimeContent[]): EngineeringDebugEvent[] {
  return content
    .filter((item): item is Extract<RuntimeContent, { type: "json" }> => item.type === "json")
    .slice(0, 16)
    .map((item) => {
      const object = jsonObject(item.value);
      const changed = object?.changed_files;
      const changedFiles = Array.isArray(changed)
        ? changed
            .slice(0, 512)
            .map((value) => safeRelativePath(value))
            .filter((value): value is string => value !== null)
        : null;
      return {
        event: "MODEL_OUTPUT_SHAPE" as const,
        keys:
          object === null
            ? []
            : Object.keys(object)
                .filter((key) => key.length >= 1 && key.length <= 128)
                .sort()
                .slice(0, 64),
        artifact_kind: safeName(object?.artifact_kind, "") || null,
        changed_files: changedFiles,
      };
    });
}

function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function addUsage(current: UsageTotals, usage: RuntimeUsage | undefined): UsageTotals {
  if (usage === undefined) {
    return {
      ...current,
      responses: current.responses + 1,
      responsesWithoutUsage: current.responsesWithoutUsage + 1,
    };
  }
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const reportedTotal = tokenCount(usage.totalTokens);
  const complete = inputTokens !== undefined && outputTokens !== undefined;
  return {
    responses: current.responses + 1,
    inputTokens: current.inputTokens + (inputTokens ?? 0),
    outputTokens: current.outputTokens + (outputTokens ?? 0),
    totalTokens:
      current.totalTokens + (reportedTotal ?? (complete ? inputTokens + outputTokens : 0)),
    responsesWithoutUsage: current.responsesWithoutUsage,
    responsesWithPartialUsage:
      current.responsesWithPartialUsage +
      (inputTokens === undefined || outputTokens === undefined || reportedTotal === undefined
        ? 1
        : 0),
  };
}

function usageComparison(totalTokens: number): "TARGET" | "WARNING" | "HARD_LIMIT" {
  if (totalTokens > ENGINEERING_MODEL_HARD_TOKEN_LIMIT) return "HARD_LIMIT";
  if (totalTokens > 150_000) return "WARNING";
  return "TARGET";
}

/** Refuse a new provider call when its conservative reserve would cross the hard ceiling. */
export function assertEngineeringModelCallBudget(totalTokens: number): void {
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    throw new Error("Engineering model token total is invalid");
  }
  if (totalTokens > ENGINEERING_MODEL_HARD_TOKEN_LIMIT - ENGINEERING_MODEL_CALL_TOKEN_RESERVE) {
    throw new Error(
      "Engineering model call refused because the 35000-token reserve would exceed the 250000-token hard limit",
    );
  }
}

/** Scope all async model/tool callbacks to the journal of exactly one leased invocation. */
export function runWithEngineeringDebugJournal<T>(
  journal: EngineeringDebugJournal,
  work: () => Promise<T>,
): Promise<T> {
  return journalContext.run(
    {
      journal,
      state: {
        usage: {
          responses: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responsesWithoutUsage: 0,
          responsesWithPartialUsage: 0,
        },
      },
      stage: "ENGINEERING_INVOCATION",
    },
    work,
  );
}

/** Attribute provider usage to the exact server-selected stage without exposing prompt text. */
export function runWithEngineeringDebugStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const context = journalContext.getStore();
  if (context === undefined) return work();
  return journalContext.run({ ...context, stage: safeName(stage, "INVALID_STAGE") }, work);
}

/** Instrument the shared transport without leaking one concurrent run into another journal. */
export function createEngineeringDebugTransport(delegate: RuntimeTransport): RuntimeTransport {
  return {
    async converse(request, config) {
      const context = journalContext.getStore();
      if (context !== undefined) assertEngineeringModelCallBudget(context.state.usage.totalTokens);
      const response = await delegate.converse(request, config);
      if (context === undefined) return response;
      context.state.usage = addUsage(context.state.usage, response.usage);
      const usage = context.state.usage;
      const comparison = usageComparison(usage.totalTokens);
      try {
        await context.journal.append({
          event: "MODEL_USAGE",
          stage: context.stage,
          responses: usage.responses,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          responses_without_usage: usage.responsesWithoutUsage,
          responses_with_partial_usage: usage.responsesWithPartialUsage,
          comparison,
        });
        const batch = toolBatchEvent(response.content);
        if (batch !== null) await context.journal.append(batch);
        for (const event of outputShapeEvents(response.content))
          await context.journal.append(event);
      } catch {
        // A diagnostic write failure after a provider response cannot change stage semantics or
        // turn an otherwise recoverable model result into an unknown external effect.
      }
      if (comparison === "HARD_LIMIT") {
        throw new Error(
          `Engineering model usage exceeded the ${String(ENGINEERING_MODEL_HARD_TOKEN_LIMIT)}-token hard limit`,
        );
      }
      return response;
    },
  };
}

/** Record only the strict structural result; output.value is intentionally never journaled. */
export function recordEngineeringDebugToolResult(result: ImplementationToolResult): void {
  const context = journalContext.getStore();
  if (context === undefined) return;
  const parsed = implementationToolResult.parse(result);
  void context.journal
    .append({
      event: "TOOL_RESULT",
      kind: parsed.kind,
      outcome: parsed.outcome,
      failure_code: parsed.outcome === "FAILED" ? parsed.failure_code : null,
      changed_files: [...parsed.changed_files],
      operation_id_digest: canonicalDigest({ operation_id: parsed.operation_id }),
      output_truncated: parsed.output.truncated,
    })
    .catch(() => undefined);
}

/** Record a platform/disposable gate failure without persisting its path-bearing message. */
export function recordEngineeringDebugGateBoundaryError(input: {
  gate_id: string;
  target: string;
  phase: string;
  error: unknown;
}): void {
  const context = journalContext.getStore();
  if (context === undefined) return;
  const protectedChanges =
    typeof input.error === "object" &&
    input.error !== null &&
    "protectedChanges" in input.error &&
    Array.isArray(input.error.protectedChanges)
      ? input.error.protectedChanges.slice(0, 128).flatMap((candidate) => {
          if (candidate === null || typeof candidate !== "object") return [];
          const path = "path" in candidate ? safeRelativePath(candidate.path) : null;
          const change = "change" in candidate ? candidate.change : null;
          return path !== null &&
            (change === "ADDED" || change === "REMOVED" || change === "MODIFIED")
            ? [{ relative_path: path, change }]
            : [];
        })
      : [];
  void context.journal
    .append({
      event: "GATE_BOUNDARY_ERROR",
      gate_id: safeName(input.gate_id, "INVALID_GATE_ID"),
      target: safeName(input.target, "INVALID_GATE_TARGET"),
      phase: safeName(input.phase, "INVALID_GATE_PHASE"),
      error_name: safeName(
        input.error instanceof Error ? input.error.name : undefined,
        "UnknownError",
      ),
      error_code:
        typeof input.error === "object" &&
        input.error !== null &&
        "code" in input.error &&
        typeof input.error.code === "string"
          ? safeName(input.error.code, "INVALID_ERROR_CODE")
          : null,
      protected_changes: protectedChanges,
      error_digest: engineeringDebugErrorDigest(input.error),
    })
    .catch(() => undefined);
}

export interface EngineeringInvocationJournalRunner {
  run<T>(lease: JobLease, work: () => Promise<T>): Promise<T>;
}

type ArtifactDiagnosticRow = {
  artifact_kind: string;
  stage: string;
  stage_attempt: number;
  commit_sha: string | null;
};

type OperationDiagnosticRow = {
  stage: string;
  stage_attempt: number;
  effect_class: string;
  started: boolean;
  completed: boolean;
};

type GateDiagnosticRow = {
  gate_id: string;
  target: string;
  outcome: string;
  exit_code: number | null;
  duration_ms: number;
  tree_digest: string;
  config_digest: string;
  command_digest: string;
  log_digest: string | null;
};

/** Production invocation boundary: one unique file from handler entry through terminal state. */
export function createEngineeringInvocationJournalRunner(input: {
  artifactRoot: string;
  db: Database;
  model: string;
  configDigest: string;
  logger: StructuredLogger;
}): EngineeringInvocationJournalRunner {
  const parsedConfigDigest = sha256Digest.parse(input.configDigest);
  return {
    async run<T>(lease: JobLease, work: () => Promise<T>): Promise<T> {
      const caseId = lease.caseId;
      const runId = lease.payload.runId;
      if (
        caseId === null ||
        lease.payload.caseId !== caseId ||
        typeof runId !== "string" ||
        runId.length === 0
      ) {
        throw new Error("Engineering invocation lacks an exact case/run binding");
      }
      const journal = await EngineeringDebugJournal.create({
        artifactRoot: input.artifactRoot,
        invocationId: `${lease.jobId}:${String(lease.fencingToken)}:${String(lease.attempts)}:${randomUUID()}`,
      });
      input.logger.info("engineering debug journal created", {
        job_id: lease.jobId,
        case_id: caseId,
        file_name: journal.fileName,
      });
      let failure: unknown;
      try {
        return await runWithEngineeringDebugJournal(journal, async () => {
          await journal.append({
            event: "RUN_STARTED",
            case_id: caseId,
            run_id: runId,
            model: safeName(input.model, "UNKNOWN_MODEL"),
            base_sha: null,
            config_digest: parsedConfigDigest,
          });
          try {
            return await work();
          } catch (error) {
            failure = error;
            await journal
              .append({
                event: "STAGE_ERROR",
                stage: "ENGINEERING_INVOCATION",
                error_name: safeName(
                  error instanceof Error ? error.name : undefined,
                  "UnknownError",
                ),
                error_digest: engineeringDebugErrorDigest(error),
              })
              .catch(() => undefined);
            throw error;
          }
        });
      } finally {
        try {
          const [artifacts, operations, gateReceipts] = await Promise.all([
            input.db.query<ArtifactDiagnosticRow>(
              `SELECT artifact_kind, stage, stage_attempt,
                      CASE WHEN artifact_kind = 'LocalCommitReceipt'
                           THEN payload->>'commit_sha' ELSE NULL END AS commit_sha
                 FROM engineering_artifact_revisions
                WHERE run_id = $1
                ORDER BY revision`,
              [runId],
            ),
            input.db.query<OperationDiagnosticRow>(
              `SELECT o.stage, o.stage_attempt, o.effect_class,
                      EXISTS (
                        SELECT 1 FROM engineering_stage_events e
                         WHERE e.operation_id = o.operation_id AND e.event_type = 'STARTED'
                      ) AS started,
                      EXISTS (
                        SELECT 1 FROM job_completions c WHERE c.intent_id = o.intent_id
                      ) AS completed
                 FROM engineering_operations o
                WHERE o.run_id = $1
                ORDER BY o.recorded_at, o.operation_id`,
              [runId],
            ),
            input.db.query<GateDiagnosticRow>(
              `SELECT c.receipt->>'gate_id' AS gate_id,
                      c.receipt->>'target' AS target,
                      c.receipt->>'outcome' AS outcome,
                      (c.receipt->>'exit_code')::integer AS exit_code,
                      (c.receipt->>'duration_ms')::integer AS duration_ms,
                      c.receipt->>'tree_digest' AS tree_digest,
                      c.receipt->>'config_digest' AS config_digest,
                      c.receipt->>'command_digest' AS command_digest,
                      c.receipt->>'log_digest' AS log_digest
                 FROM job_completions c
                 JOIN job_intents i ON i.intent_id = c.intent_id
                 JOIN engineering_operations o ON o.intent_id = i.intent_id
                WHERE o.run_id = $1
                  AND i.kind = 'engineering.verification.gate'
                ORDER BY c.recorded_at, c.completion_id`,
              [runId],
            ),
          ]);
          await journal.append({
            event: "RUN_DIAGNOSTIC",
            artifacts: artifacts.rows.map((row) => ({
              artifact_kind: safeName(row.artifact_kind, "INVALID_ARTIFACT_KIND"),
              stage: safeName(row.stage, "INVALID_STAGE"),
              stage_attempt: row.stage_attempt,
            })),
            operations: operations.rows.map((row) => ({
              stage: safeName(row.stage, "INVALID_STAGE"),
              stage_attempt: row.stage_attempt,
              effect_class: safeName(row.effect_class, "INVALID_EFFECT_CLASS"),
              started: row.started,
              completed: row.completed,
            })),
            gate_receipts: gateReceipts.rows.map((row) => ({
              gate_id: safeName(row.gate_id, "INVALID_GATE_ID"),
              target: safeName(row.target, "INVALID_GATE_TARGET"),
              outcome: safeName(row.outcome, "INVALID_GATE_OUTCOME"),
              exit_code: row.exit_code,
              duration_ms: row.duration_ms,
              tree_digest: row.tree_digest,
              config_digest: row.config_digest,
              command_digest: row.command_digest,
              log_digest: row.log_digest,
            })),
            error_digest: failure === undefined ? null : engineeringDebugErrorDigest(failure),
          });
          const commitSha =
            artifacts.rows.find((row) => row.commit_sha !== null)?.commit_sha ?? null;
          await journal.append({
            event: "RUN_COMPLETED",
            status: failure === undefined ? "SUCCEEDED" : "FAILED",
            commit_sha: commitSha,
            artifact_kinds: artifacts.rows.map((row) =>
              safeName(row.artifact_kind, "INVALID_ARTIFACT_KIND"),
            ),
          });
        } catch (error) {
          await journal
            .append({
              event: "STAGE_ERROR",
              stage: "RUN_DIAGNOSTIC",
              error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
              error_digest: engineeringDebugErrorDigest(error),
            })
            .catch(() => undefined);
          await journal
            .append({
              event: "RUN_COMPLETED",
              status: failure === undefined ? "SUCCEEDED" : "FAILED",
              commit_sha: null,
              artifact_kinds: [],
            })
            .catch(() => undefined);
          input.logger.warn("engineering debug journal final diagnostic failed", {
            job_id: lease.jobId,
            case_id: caseId,
            error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
          });
        } finally {
          await journal.close().catch((error: unknown) => {
            input.logger.warn("engineering debug journal close failed", {
              job_id: lease.jobId,
              case_id: caseId,
              error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
            });
          });
        }
      }
    },
  };
}

export class EngineeringDebugJournal {
  readonly fileName: string;
  readonly filePath: string;
  #handle: FileHandle;
  #sequence = 0;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;
  #now: () => Date;

  private constructor(input: {
    handle: FileHandle;
    fileName: string;
    filePath: string;
    now: () => Date;
  }) {
    this.#handle = input.handle;
    this.fileName = input.fileName;
    this.filePath = input.filePath;
    this.#now = input.now;
  }

  static async create(input: {
    artifactRoot: string;
    invocationId: string;
    now?: () => Date;
  }): Promise<EngineeringDebugJournal> {
    id.parse(input.invocationId);
    const root = await realpath(input.artifactRoot);
    const directory = join(root, "engineering-debug");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    const child = relative(root, canonicalDirectory);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error("engineering debug directory escaped the artifact root");
    }
    const digest = canonicalDigest({ invocation_id: input.invocationId }).slice("sha256:".length);
    const fileName = `engineering-${digest}.jsonl`;
    const filePath = join(canonicalDirectory, fileName);
    const handle = await open(filePath, "wx", 0o600);
    return new EngineeringDebugJournal({
      handle,
      fileName,
      filePath,
      now: input.now ?? (() => new Date()),
    });
  }

  append(event: EngineeringDebugEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("engineering debug journal is closed"));
    const parsed = debugEvent.parse(event);
    const stored: StoredEvent = {
      schema_version: 1,
      sequence: this.#sequence,
      recorded_at: this.#now().toISOString(),
      ...parsed,
    };
    this.#sequence += 1;
    this.#pending = this.#pending.then(async () => {
      await this.#handle.appendFile(`${JSON.stringify(stored)}\n`, { encoding: "utf8" });
    });
    return this.#pending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    await this.#handle.close();
  }
}
