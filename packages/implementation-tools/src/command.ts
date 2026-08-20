/**
 * The model-facing `command` tool: run a *named*, server-owned command.
 *
 * This module is a **policy and envelope** layer. It contains no `child_process`
 * import and no second process runner: every execution decision that can be got
 * wrong — argument vector instead of a shell, absolute canonical executable,
 * `cwd` confinement re-checked immediately before launch, the four-name
 * environment allowlist with a forced `PATH`/`HOME`, the `sandbox-exec` network
 * profile, output byte capping and `killTree` on timeout — already lives in
 * `@remoteagent/workspace-runner`'s `runProcess` and is exercised by its own
 * suite. What is added here is the part `runProcess` deliberately does not own:
 * *who* is allowed to choose those parameters, what the model is allowed to see
 * of the result, and how an interrupted command is classified.
 *
 * Three properties are structural rather than conventional.
 *
 * 1. **The policy is server-owned and cannot be widened by an argument.**
 *    The model-facing request is `{ operation_id, command }` and nothing else —
 *    `command` is a *key* into a catalogue supplied by the server at construction
 *    time. Two independent layers enforce this. First,
 *    {@link implementationCommandRequest} is a strict object, so `env`, `cwd`,
 *    `network`, `timeoutMs` or `outputBytes` on the request are a *parse error*
 *    reported as {@link COMMAND_POLICY_NOT_EXTENSIBLE} — a loud refusal, not a
 *    silently ignored field, and it is raised before the ledger is touched and
 *    before anything is launched. Second, even with that check removed the
 *    request could not reach the runner: {@link toProcessInput} takes the
 *    resolved catalogue entry and the verified root and *nothing else*, so the
 *    `ProcessRunInput` is not constructed from model-supplied data at all. The
 *    catalogue itself is validated against hard ceilings
 *    ({@link MAX_COMMAND_TIMEOUT_MS}, {@link MAX_COMMAND_OUTPUT_BYTES},
 *    {@link COMMAND_ENV_ALLOWLIST}) when the tool is built, so a server
 *    misconfiguration fails at construction instead of at launch, and the
 *    network mode is one server-level decision that no catalogue entry can
 *    restate.
 *
 * 2. **Command output is redacted before it reaches either the log or the
 *    model, and the untruncated artifact stays out of the prompt.** Redaction
 *    runs *once*, on the raw streams, and every downstream consumer is fed from
 *    that redacted text: the log sink, the model-facing payload and the stored
 *    artifact. There is no path by which a raw stream byte escapes this module.
 *    See {@link redactCommandOutput} for why this is a local pattern table
 *    rather than a call into `@remoteagent/observability`.
 *
 * 3. **Interruption, cancellation and a plain non-zero exit are three different
 *    results.** A command is a real side effect — under the `DENY` network
 *    profile it may still write anywhere inside the workspace root — and this
 *    module never enumerates what it wrote. So the classification cannot come
 *    from a path list; it comes from *how the process ended* plus the workspace
 *    tree digest observed before and after:
 *
 *    - exit 0, post-state observed -> `SUCCEEDED`;
 *    - **plain non-zero exit** -> `FAILED` / {@link COMMAND_FAILED}. The process
 *      ran to completion and *decided* to exit; the post-state is fully
 *      observed, so there is nothing ambiguous about it;
 *    - **timeout** -> `AMBIGUOUS` / `INTERRUPTED`. `runProcess` SIGKILLed the
 *      tree at an arbitrary instant, so an unknown amount of work landed.
 *      Reporting this as `FAILED` would assert "no effect", which is exactly the
 *      claim that cannot be made;
 *    - **cancellation before launch** -> `FAILED` / {@link COMMAND_CANCELED},
 *      provably non-mutating because no process was ever started;
 *    - **cancellation after launch** -> `AMBIGUOUS` / `INTERRUPTED`, for the
 *      same reason as a timeout;
 *    - post-state not observable -> `AMBIGUOUS` / `UNVERIFIED_POST_STATE`.
 *
 *    `changed_files` is always empty, including on `AMBIGUOUS`: this tool cannot
 *    know which paths a command touched, and inventing a list would be worse
 *    than admitting none. The honest mutation signal is the digest pair, which
 *    the payload surfaces as `workspace_changed`; a `FAILED` result therefore
 *    still carries its observed `after_digest`, so "clean failure" is a claim the
 *    reader can check rather than one this module makes.
 *
 * As in `./patch.ts`, the model-facing outcome is derived from the **durable
 * ledger row**, not from what this process believes happened, so a replay of the
 * same `operation_id` reports the recorded outcome and launches nothing.
 *
 * Two limits are stated rather than faked:
 *
 * - **CPU and memory are not enforced.** `runProcess` rejects `cpuTimeMs` and
 *   `memoryBytes` with `NOT_ENFORCEABLE` on this adapter, so the catalogue has
 *   no field for them. An out-of-memory kill is therefore not distinguishable
 *   from any other external SIGKILL; the payload reports the raw `signal` and a
 *   SIGKILL that did not come from our timeout is classified `AMBIGUOUS`, which
 *   is the safe direction, not "OOM detected".
 * - **Cancellation does not kill the child early.** `runProcess` owns the child
 *   and exposes no abort channel, and this layer may not reach into it. A
 *   post-launch cancel therefore stops *waiting*; the server-owned `timeoutMs`
 *   remains the upper bound on the process's life. That is precisely why such a
 *   cancel is `AMBIGUOUS`.
 *
 * Failure *messages* never travel. `ProcessRunnerError` and
 * `WorkspacePathPolicyError` messages embed absolute host paths and this output
 * is model-visible, so only their stable `code` is carried.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { relative, isAbsolute as isAbsolutePath, resolve, sep } from "node:path";

import {
  TrustLevel,
  canonicalDigest,
  canonicalJsonStringify,
  idString,
} from "@remoteagent/contracts";
import type { Transaction } from "@remoteagent/database";
import {
  ProcessRunnerError,
  WorkspacePathPolicyError,
  computeTreeDigest,
  runProcess,
  validateWorkspaceRoot,
} from "@remoteagent/workspace-runner";
import type {
  NetworkMode,
  ProcessRunInput,
  ProcessRunResult,
  VerifiedWorkspacePath,
} from "@remoteagent/workspace-runner";
import * as z from "zod";

import {
  AmbiguityReason,
  MAX_TOOL_OUTPUT_BYTES,
  ToolKind,
  ToolOutcome,
  implementationToolResult,
} from "./contracts.js";
import type { ImplementationToolResult, ToolIdentity, ToolOutput } from "./contracts.js";
import { runExactlyOnce } from "./ledger.js";
import type { OperationLedgerRepository, OperationReceipt, OperationRecord } from "./ledger.js";
import { OperationStatus } from "./ledger.js";

/** Hard server ceiling on one command's wall-clock budget, in milliseconds. */
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Hard server ceiling on the bytes `runProcess` will collect from a command.
 * Larger than {@link MAX_TOOL_OUTPUT_BYTES} on purpose: the model sees a clipped
 * view, the stored artifact sees the whole capped stream.
 */
export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;

/**
 * The only environment variable names a catalogue entry may set. This mirrors
 * `runProcess`'s own `SAFE_ENV` so a bad entry is refused when the tool is
 * built, rather than surfacing as an `INVALID_ENVIRONMENT` throw at launch.
 */
export const COMMAND_ENV_ALLOWLIST = Object.freeze([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const satisfies readonly string[]);

/** The request carried a field that would widen the server-owned policy. */
export const COMMAND_POLICY_NOT_EXTENSIBLE = "POLICY_NOT_EXTENSIBLE";

/** The request did not satisfy the command contract; nothing was launched. */
export const INVALID_COMMAND_REQUEST = "INVALID_REQUEST";

/** The requested name is not in the server-owned command catalogue. */
export const COMMAND_NOT_ALLOWED = "COMMAND_NOT_ALLOWED";

/** The command ran to completion and exited non-zero. */
export const COMMAND_FAILED = "COMMAND_FAILED";

/** The caller cancelled before any process was started. */
export const COMMAND_CANCELED = "CANCELED";

/** The pre-state could not be read, so no run was attempted. */
export const COMMAND_PRE_STATE_UNREADABLE = "PRE_STATE_UNREADABLE";

/** Last-resort code for a fault with no stable classification. */
export const COMMAND_TOOL_FAILED = "COMMAND_TOOL_FAILED";

/** How the process ended. Distinct from the outcome, and always reported. */
export const CommandTermination = {
  /** No process was started at all. */
  NOT_LAUNCHED: "NOT_LAUNCHED",
  /** The process exited on its own, with any exit code. */
  EXIT: "EXIT",
  /** `runProcess` killed the tree because the server timeout elapsed. */
  TIMEOUT: "TIMEOUT",
  /** The caller cancelled; this layer stopped waiting. */
  CANCELED: "CANCELED",
  /** The process died on a signal that was neither our timeout nor a cancel. */
  SIGNALED: "SIGNALED",
} as const;

export type CommandTermination = (typeof CommandTermination)[keyof typeof CommandTermination];

/** Placeholder substituted for anything that must not reach a log or a model. */
export const COMMAND_REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Raised by the non-mutating pre-flight. The message *is* the code, so a host
 * path can never reach a model-visible envelope through it.
 */
export class ImplementationCommandError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ImplementationCommandError";
  }
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Patterns for material that must never reach a log line or the model context.
 *
 * **Why this table exists at all.** `@remoteagent/observability`'s
 * `SecretRedactor` is the repository's redaction primitive and would be the
 * right base layer, but it is not a declared dependency of this package and
 * `package.json` is outside this unit's allowed paths, so it is not resolvable
 * from here (a bare import fails at runtime; a relative import fails `rootDir`).
 * Independently of that, a coordinator probe against its built output showed it
 * does **not** cover the classes that dominate command output: absolute host
 * paths, `glpat-`/`gh*_` forwarding tokens, AWS access-key ids, PEM blocks and
 * JWTs. Command output is mostly stack traces, `cwd` echoes and compiler
 * diagnostics, i.e. host paths, so a layer covering only `Bearer`/`Basic`/URL
 * credentials would leave the dominant class untouched. The shapes below are
 * deliberately aligned with `repository-planner`'s `unsafeString` guard so the
 * two boundaries agree on what "unsafe" means.
 *
 * **Transitional.** This local table is a deliberate, self-contained stopgap, not
 * an accidental duplication: unifying every boundary onto one shared redactor
 * that covers these classes is tracked as RA-024 (`CTF-006`). Until that lands,
 * this module must not lean on `@remoteagent/observability`, whose `SecretRedactor`
 * still passes host paths and provider tokens through.
 *
 * Each entry keeps capture group 1 (the boundary character that preceded the
 * match, or the credential's own scheme prefix) and replaces the rest.
 */
const REDACTION_PATTERNS: readonly RegExp[] = Object.freeze([
  // PEM private key blocks, header through footer, including the body.
  /()-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  // `file://` URIs, which smuggle a host path past a leading-slash matcher.
  /()\bfile:\/\/\S+/giu,
  // POSIX host paths, and Windows drive paths, wherever they appear in a line.
  /(^|[\s"'`=(\[<{,;:])((?:\/(?:Users|home|root|private|var|tmp|etc|opt|srv|mnt|media|Volumes|usr\/local)\b|[A-Za-z]:[\\/])[^\s"'`)\]>}]*)/gmu,
  // Provider tokens with a self-identifying prefix.
  /()\b(?:glpat-|glrt-|gh[pousr]_|xox[abposr]-|sk-|AKIA|ASIA)[A-Za-z0-9_\-]{8,}/gu,
  // Compact JWTs (header.payload.signature).
  /()\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  // HTTP credential schemes.
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu,
  /(\bBasic\s+)[A-Za-z0-9+/=]+/giu,
  // Credentials embedded in a URL's userinfo.
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
  // `key=value` / `key: value` credential assignments.
  /(\b(?:password|passphrase|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|credential|private[_-]?key)\s*[:=]\s*)[^\s,;]+/giu,
  // Credentials in a query string.
  /([?&](?:access_token|refresh_token|api_key|key|token|password)=)[^&#\s]+/giu,
]);

/**
 * Redact one text once, for every consumer.
 *
 * `known` is substituted first, longest-first, so a value the server already
 * knows to be sensitive (the workspace root, the artifact root) is removed even
 * when it does not match any shape above. Only after that do the patterns run.
 */
export function redactCommandOutput(value: string, known: readonly string[] = []): string {
  let redacted = value;
  for (const literal of [...known]
    .filter((item) => item.length > 0)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(literal).join(COMMAND_REDACTION_PLACEHOLDER);
  }
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replace(
      pattern,
      (_match, prefix: string) => `${prefix}${COMMAND_REDACTION_PLACEHOLDER}`,
    );
  }
  return redacted;
}

const relativeCwd = z
  .string()
  .min(1)
  .refine((value) => !isAbsolutePath(value) && !value.includes("\0"), {
    message: "cwd must be a workspace-relative path",
  });

/**
 * One entry of the server-owned command catalogue.
 *
 * Note what is absent: there is no `network` field. The network mode is a single
 * server-level decision on {@link ImplementationCommandToolOptions}, so no entry
 * can quietly opt itself into egress.
 */
export const commandCatalogueEntry = z.strictObject({
  /** Absolute, canonical path; `runProcess` re-verifies both properties. */
  executable: z
    .string()
    .min(1)
    .refine((value) => isAbsolutePath(value) && !value.includes("\0"), {
      message: "executable must be an absolute path",
    }),
  args: z.array(z.string().refine((value) => !value.includes("\0"))).default([]),
  /** Workspace-relative; `runProcess` confines it, three times. */
  cwd: relativeCwd.default("."),
  env: z
    .partialRecord(
      z.enum(COMMAND_ENV_ALLOWLIST),
      z.string().refine((value) => !value.includes("\0")),
    )
    .default({}),
  timeoutMs: z.int().positive().max(MAX_COMMAND_TIMEOUT_MS),
  outputBytes: z.int().positive().max(MAX_COMMAND_OUTPUT_BYTES).default(MAX_COMMAND_OUTPUT_BYTES),
});

export type CommandCatalogueEntry = z.input<typeof commandCatalogueEntry>;

type ResolvedCommand = z.output<typeof commandCatalogueEntry>;

const commandCatalogue = z.record(idString, commandCatalogueEntry);

/**
 * The whole model-facing surface: a catalogue key and the operation identity.
 *
 * Strict, and that strictness is the enforcement point for acceptance criterion
 * 1 — an `env`, `cwd`, `network`, `timeoutMs` or `outputBytes` field here is an
 * unrecognized key, so the parse fails and no process is started.
 */
export const implementationCommandRequest = z.strictObject({
  operation_id: idString,
  command: idString,
});

export type ImplementationCommandRequest = z.infer<typeof implementationCommandRequest>;

/** Every request key that widens the policy rather than merely being wrong. */
const POLICY_KEYS = Object.freeze(
  new Set([
    "env",
    "environment",
    "cwd",
    "working_directory",
    "workingDirectory",
    "network",
    "network_mode",
    "networkMode",
    "timeoutMs",
    "timeout_ms",
    "timeout",
    "outputBytes",
    "output_bytes",
    "limits",
    "executable",
    "args",
    "argv",
    "shell",
    "cpuTimeMs",
    "memoryBytes",
  ]),
);

/** A durable, prompt-free handle on the complete output of one command. */
export type CommandArtifactReference = Readonly<{
  /** Artifact-root-relative; never an absolute host path. */
  reference: string;
  /** `sha256:` digest of the complete redacted output. */
  digest: string;
  byte_length: number;
}>;

/**
 * Progress seam. `beforeLaunch` is awaited immediately before `runProcess` is
 * called and *only* then, which is what lets a test prove that a refused
 * request launched nothing. It is deliberately given no return channel: an
 * observer cannot influence the policy or the classification.
 */
export type ImplementationCommandObserver = Readonly<{
  beforeLaunch?: (event: Readonly<{ command: string }>) => Promise<void> | void;
}>;

/** Redacted, structured log record. This is what reaches the log sink. */
export type CommandLogRecord = Readonly<{
  event: "command_completed";
  operation_id: string;
  command: string;
  outcome: ToolOutcome;
  termination: CommandTermination;
  exit_code: number | null;
  signal: string | null;
  workspace_changed: boolean | null;
  failure_code: string | null;
  ambiguity_reason: AmbiguityReason | null;
  artifact: CommandArtifactReference | null;
  /** Already redacted, and never truncated, so the log keeps full evidence. */
  stdout: string;
  stderr: string;
}>;

export type ImplementationCommandToolOptions = Readonly<{
  /** Workspace root; validated by the workspace-runner path policy. */
  root: string;
  identity: ToolIdentity;
  ledger: OperationLedgerRepository;
  /** Transaction boundary for ledger writes only; the run happens outside it. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** The closed set of runnable commands. Keys are the model-facing names. */
  catalogue: Readonly<Record<string, CommandCatalogueEntry>>;
  /** Server-level network decision. One value for every command. */
  network?: NetworkMode;
  /**
   * Directory for complete-output artifacts. Must be OUTSIDE the workspace
   * root, so writing an artifact cannot perturb the tree digest the outcome is
   * classified from, and so a command cannot read its predecessors' output.
   */
  artifactRoot: string;
  /**
   * Literal secret values the server already knows (forwarding tokens, injected
   * credentials). These are substituted before the pattern table runs, so a
   * value the server knows to be sensitive is removed even in a shape the shapes
   * below do not recognize. Kept out of prompts, logs and artifacts alike.
   */
  knownSecrets?: readonly string[];
  /** Redacted-only log sink. Injected so the log path is separately testable. */
  log?: (record: CommandLogRecord) => void;
  observer?: ImplementationCommandObserver;
}>;

export type ImplementationCommandInput = Readonly<{
  operation_id: string;
  command: string;
  /** Cooperative cancellation. See the module note on what it can and cannot do. */
  signal?: AbortSignal;
}>;

export type ImplementationCommandTool = Readonly<{
  /** The names the model may pass as `command`, for prompt construction. */
  readonly commands: readonly string[];
  run(input: ImplementationCommandInput): Promise<ImplementationToolResult>;
}>;

/**
 * Build the `ProcessRunInput`.
 *
 * The signature is the second half of criterion 1: the only inputs are the
 * resolved catalogue entry, the verified root and the server network mode. No
 * model-supplied value is in scope here, so there is nothing to widen even if
 * request validation were removed.
 */
function toProcessInput(
  entry: ResolvedCommand,
  root: VerifiedWorkspacePath,
  network: NetworkMode,
): ProcessRunInput {
  return {
    executable: entry.executable,
    args: entry.args,
    workspaceRoot: root,
    cwd: entry.cwd,
    env: entry.env,
    network,
    limits: { timeoutMs: entry.timeoutMs, outputBytes: entry.outputBytes },
  };
}

/** Map a thrown fault onto a stable code. Only codes travel, never messages. */
function failureCode(error: unknown): string {
  if (error instanceof ImplementationCommandError) return error.code;
  if (error instanceof ProcessRunnerError) return error.code;
  if (error instanceof WorkspacePathPolicyError) return error.code;
  return COMMAND_TOOL_FAILED;
}

/**
 * Classify a rejected request. A recognized policy key is reported as
 * {@link COMMAND_POLICY_NOT_EXTENSIBLE} rather than a generic invalid request,
 * so an attempt to widen the policy is distinguishable in logs and audits from
 * an ordinary malformed call.
 */
function rejectionCode(request: unknown): string {
  if (typeof request !== "object" || request === null) return INVALID_COMMAND_REQUEST;
  for (const key of Object.keys(request)) {
    if (POLICY_KEYS.has(key)) return COMMAND_POLICY_NOT_EXTENSIBLE;
  }
  return INVALID_COMMAND_REQUEST;
}

/** Cut at a code-point boundary so clipping cannot split a surrogate pair. */
function clip(value: string, units: number): string {
  if (units >= value.length) return value;
  const code = units > 0 ? value.charCodeAt(units - 1) : 0;
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? units - 1 : units);
}

/** Largest `n` in `[0, hi]` whose rendering fits the model-facing bound. */
function largestFitting(hi: number, render: (kept: number) => string): number {
  let low = 0;
  let high = hi;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(render(mid)) <= MAX_TOOL_OUTPUT_BYTES) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** Everything observed about one attempt, with output ALREADY redacted. */
type Observation = Readonly<{
  termination: CommandTermination;
  exitCode: number | null;
  signal: string | null;
  /** Redacted and complete (subject only to `runProcess`'s own byte cap). */
  stdout: string;
  stderr: string;
  /** `runProcess` hit `outputBytes`, so even the artifact is not the whole run. */
  runnerTruncated: boolean;
  afterDigest: string | null;
  workspaceChanged: boolean | null;
  artifact: CommandArtifactReference | null;
}>;

const NOT_LAUNCHED: Observation = Object.freeze({
  termination: CommandTermination.NOT_LAUNCHED,
  exitCode: null,
  signal: null,
  stdout: "",
  stderr: "",
  runnerTruncated: false,
  afterDigest: null,
  workspaceChanged: null,
  artifact: null,
});

/** Envelope-ready shape, decided solely from the durable ledger row. */
type Decision =
  | Readonly<{ outcome: typeof ToolOutcome.SUCCEEDED; afterDigest: string }>
  | Readonly<{
      outcome: typeof ToolOutcome.FAILED;
      afterDigest: string | null;
      failureCode: string;
    }>
  | Readonly<{
      outcome: typeof ToolOutcome.AMBIGUOUS;
      afterDigest: string | null;
      ambiguityReason: AmbiguityReason;
    }>;

/**
 * Translate a ledger row into the outcome the model is told about.
 *
 * `SUCCEEDED` requires the row to BE `SUCCEEDED` *and* to carry a digest. An
 * `INTENT_RECORDED` row — a crashed or still-running attempt — is `AMBIGUOUS`,
 * so a replay arriving while the effect is unresolved cannot report success.
 */
function decide(record: OperationRecord): Decision {
  if (record.status === OperationStatus.SUCCEEDED && record.afterDigest !== null) {
    return { outcome: ToolOutcome.SUCCEEDED, afterDigest: record.afterDigest };
  }
  if (record.status === OperationStatus.FAILED) {
    return {
      outcome: ToolOutcome.FAILED,
      afterDigest: record.afterDigest,
      failureCode: record.failureCode ?? COMMAND_TOOL_FAILED,
    };
  }
  return {
    outcome: ToolOutcome.AMBIGUOUS,
    afterDigest: record.afterDigest,
    ambiguityReason: record.ambiguityReason ?? AmbiguityReason.INTERRUPTED,
  };
}

/**
 * Render the model-facing payload from an already-redacted observation.
 *
 * Clipping is never silent: `complete` goes false, `dropped_output_bytes` states
 * how much redacted output was withheld, the envelope declares the pre-clip
 * `original_byte_length`, and `artifact` points at the untruncated copy.
 */
function render(
  command: string,
  decision: Decision,
  observed: Observation,
  beforeDigest: string,
): ToolOutput {
  const fullBytes = byteLength(observed.stdout) + byteLength(observed.stderr);
  const body = (kept: number, complete: boolean): Record<string, unknown> => {
    const stdout = clip(observed.stdout, kept);
    const stderr = clip(observed.stderr, kept);
    return {
      tool: "command",
      command,
      outcome: decision.outcome,
      complete,
      requires_reconciliation: decision.outcome === ToolOutcome.AMBIGUOUS,
      ambiguity_reason:
        decision.outcome === ToolOutcome.AMBIGUOUS ? decision.ambiguityReason : null,
      failure_code: decision.outcome === ToolOutcome.FAILED ? decision.failureCode : null,
      termination: observed.termination,
      exit_code: observed.exitCode,
      signal: observed.signal,
      workspace_changed: observed.workspaceChanged,
      before_digest: beforeDigest,
      after_digest: decision.afterDigest,
      runner_output_truncated: observed.runnerTruncated,
      dropped_output_bytes: fullBytes - byteLength(stdout) - byteLength(stderr),
      artifact: observed.artifact,
      stdout,
      stderr,
    };
  };
  const hi = Math.max(observed.stdout.length, observed.stderr.length);
  const complete = canonicalJsonStringify(body(hi, true));
  const original = byteLength(complete);
  if (original <= MAX_TOOL_OUTPUT_BYTES) {
    return {
      trust: TrustLevel.UNTRUSTED_DATA,
      value: complete,
      truncated: false,
      original_byte_length: original,
    };
  }
  const kept = largestFitting(hi, (n) => canonicalJsonStringify(body(n, false)));
  return {
    trust: TrustLevel.UNTRUSTED_DATA,
    value: canonicalJsonStringify(body(kept, false)),
    truncated: true,
    original_byte_length: original,
  };
}

/** Build the result envelope and re-parse it, so nothing malformed escapes. */
function envelope(
  command: string,
  identity: ToolIdentity,
  operationId: string,
  beforeDigest: string,
  decision: Decision,
  observed: Observation,
): ImplementationToolResult {
  const base = {
    schema_version: 1,
    operation_id: operationId,
    identity,
    kind: ToolKind.RUN_COMMAND,
    before_digest: beforeDigest,
    output: render(command, decision, observed, beforeDigest),
  };
  if (decision.outcome === ToolOutcome.SUCCEEDED) {
    return implementationToolResult.parse({
      ...base,
      outcome: ToolOutcome.SUCCEEDED,
      after_digest: decision.afterDigest,
      changed_files: [],
    });
  }
  if (decision.outcome === ToolOutcome.FAILED) {
    return implementationToolResult.parse({
      ...base,
      outcome: ToolOutcome.FAILED,
      after_digest: decision.afterDigest,
      changed_files: [],
      failure_code: decision.failureCode,
    });
  }
  return implementationToolResult.parse({
    ...base,
    outcome: ToolOutcome.AMBIGUOUS,
    after_digest: decision.afterDigest,
    changed_files: [],
    ambiguity_reason: decision.ambiguityReason,
    requires_reconciliation: true,
  });
}

/**
 * The abort race's result. A tagged union rather than a sentinel value, so
 * `finished === false` narrows `run` away and the compiler — not a cast —
 * guarantees a cancelled attempt never reads a `ProcessRunResult` field.
 */
type Raced = Readonly<{ finished: true; run: ProcessRunResult }> | Readonly<{ finished: false }>;

const CANCELED: Raced = Object.freeze({ finished: false });

/** Resolve on abort. The listener is always removed, abort or not. */
function abortRace(signal: AbortSignal | undefined): {
  promise: Promise<Raced> | null;
  dispose: () => void;
} {
  if (signal === undefined) return { promise: null, dispose: () => undefined };
  let dispose = (): void => undefined;
  const promise = new Promise<Raced>((settle) => {
    const onAbort = (): void => settle(CANCELED);
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, dispose };
}

/**
 * Build the `command` tool over a workspace root.
 *
 * Root, catalogue and artifact-root validation all happen here and *throw*: an
 * unusable root, an out-of-ceiling catalogue entry or an artifact root inside
 * the workspace are deterministic server-side configuration faults, not
 * model-visible tool outcomes.
 */
export async function createImplementationCommandTool(
  options: ImplementationCommandToolOptions,
): Promise<ImplementationCommandTool> {
  const root = await validateWorkspaceRoot(options.root);
  const catalogue = commandCatalogue.parse(options.catalogue);
  const network: NetworkMode = options.network ?? "DENY";
  const artifactRoot = resolve(options.artifactRoot);
  const inside = relative(root, artifactRoot);
  if (inside === "" || (!inside.startsWith("..") && !isAbsolutePath(inside))) {
    throw new ImplementationCommandError("ARTIFACT_ROOT_INSIDE_WORKSPACE");
  }
  const { identity, ledger, runTransaction, observer, log } = options;
  // Literals the server already knows are sensitive, redacted ahead of the
  // pattern table so a host path or a forwarded token is removed even in a shape
  // the patterns miss.
  const knownStrings: readonly string[] = [root, artifactRoot, ...(options.knownSecrets ?? [])];

  /**
   * Persist the complete redacted output outside the prompt and outside the
   * workspace. "Complete" means untruncated, not unredacted: truncation is what
   * the artifact undoes, redaction is never undone, so a secret in a command's
   * output does not become a file on disk either.
   */
  const storeArtifact = async (
    operationId: string,
    stdout: string,
    stderr: string,
  ): Promise<CommandArtifactReference | null> => {
    const digest = canonicalDigest({ stdout, stderr });
    const reference = `command-output/${encodeURIComponent(operationId)}.txt`;
    const contents = `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`;
    try {
      await mkdir(`${artifactRoot}${sep}command-output`, { recursive: true });
      await writeFile(`${artifactRoot}${sep}${reference}`, contents, { mode: 0o600 });
      return { reference, digest, byte_length: byteLength(contents) };
    } catch {
      // The command already ran; a storage fault cannot change its outcome. The
      // payload says `artifact: null` rather than pointing at a file that is not
      // there.
      return null;
    }
  };

  /**
   * Perform one attempt. Every exit is enumerated here, and every one of them
   * routes the raw streams through {@link redactCommandOutput} before they are
   * carried anywhere.
   */
  const attempt = async (
    command: string,
    entry: ResolvedCommand,
    operationId: string,
    beforeDigest: string,
    signal: AbortSignal | undefined,
    into: { observed: Observation },
  ): Promise<OperationReceipt> => {
    await observer?.beforeLaunch?.({ command });
    const race = abortRace(signal);
    let raced: Raced;
    try {
      const running = runProcess(toProcessInput(entry, root, network)).then((run): Raced => ({
        finished: true,
        run,
      }));
      raced = race.promise === null ? await running : await Promise.race([running, race.promise]);
      if (!raced.finished) {
        // `runProcess` owns the child and offers no abort channel, so the
        // process is left to the server-owned timeout. Do not leave its promise
        // unhandled.
        void running.catch(() => undefined);
      }
    } catch (error) {
      // Every throw from `runProcess` happens before or during spawn
      // (INVALID_COMMAND, INVALID_ENVIRONMENT, NOT_ENFORCEABLE, PATH_ESCAPE,
      // SYMLINK_NOT_ALLOWED, SPAWN_FAILED), so no command body ran.
      return { outcome: ToolOutcome.FAILED, failureCode: failureCode(error) };
    } finally {
      race.dispose();
    }

    // Redaction happens exactly once, here, on the raw streams. Every consumer
    // below — payload, log record, stored artifact — is fed from these two
    // strings, so there is no path by which a raw stream byte leaves this scope.
    const stdout = redactCommandOutput(raced.finished ? raced.run.stdout : "", knownStrings);
    const stderr = redactCommandOutput(raced.finished ? raced.run.stderr : "", knownStrings);
    const afterDigest = await computeTreeDigest(root).catch(() => null);
    const artifact = await storeArtifact(operationId, stdout, stderr);
    const termination = !raced.finished
      ? CommandTermination.CANCELED
      : raced.run.timedOut
        ? CommandTermination.TIMEOUT
        : raced.run.exitCode === null
          ? CommandTermination.SIGNALED
          : CommandTermination.EXIT;
    into.observed = {
      termination,
      exitCode: raced.finished ? raced.run.exitCode : null,
      signal: raced.finished ? raced.run.signal : null,
      stdout,
      stderr,
      runnerTruncated: raced.finished && raced.run.outputTruncated,
      afterDigest,
      workspaceChanged: afterDigest === null ? null : afterDigest !== beforeDigest,
      artifact,
    };

    // An interrupted process — our timeout, a cancel, or any other signal —
    // stopped at an arbitrary instant, so the amount of work applied is unknown.
    if (termination !== CommandTermination.EXIT) {
      return {
        outcome: ToolOutcome.AMBIGUOUS,
        ambiguityReason: AmbiguityReason.INTERRUPTED,
        ...(afterDigest === null ? {} : { afterDigest }),
      };
    }
    // The process ran to completion, so the post-state is knowable — but it must
    // actually have been observed before a success may be claimed.
    if (afterDigest === null) {
      return {
        outcome: ToolOutcome.AMBIGUOUS,
        ambiguityReason: AmbiguityReason.UNVERIFIED_POST_STATE,
      };
    }
    if (raced.finished && raced.run.exitCode === 0) {
      return { outcome: ToolOutcome.SUCCEEDED, afterDigest, changedFiles: [] };
    }
    return { outcome: ToolOutcome.FAILED, failureCode: COMMAND_FAILED };
  };

  const run = async (input: ImplementationCommandInput): Promise<ImplementationToolResult> => {
    // `signal` is a local execution control, not part of the model-facing wire
    // request; everything else the caller passed is validated as-is. Spreading
    // the rest (rather than reconstructing `{ operation_id, command }`) is what
    // makes criterion 1 real: an `env`, `cwd`, `network`, `timeoutMs` or
    // `outputBytes` field survives to the strict parse below and is refused,
    // instead of being silently dropped before validation ever sees it.
    const { signal, ...requested } = input;

    // Phase A: pure validation. Launches nothing, mints no ledger row. A field
    // that would widen the server-owned policy dies here.
    const parsed = implementationCommandRequest.safeParse(requested);
    const entry = parsed.success ? catalogue[parsed.data.command] : undefined;
    const refusal = !parsed.success
      ? rejectionCode(requested)
      : entry === undefined
        ? COMMAND_NOT_ALLOWED
        : signal?.aborted === true
          ? // Cancelled before anything started, so this is provably
            // non-mutating and a clean FAILED is honest.
            COMMAND_CANCELED
          : null;

    // Phase B: read-only pre-state. Needed for the claim, and its failure is
    // also provably non-mutating.
    let beforeDigest: string | null = null;
    if (refusal === null) {
      beforeDigest = await computeTreeDigest(root).catch(() => null);
    }
    const code = refusal ?? (beforeDigest === null ? COMMAND_PRE_STATE_UNREADABLE : null);
    if (code !== null || beforeDigest === null || entry === undefined) {
      const decision: Decision = {
        outcome: ToolOutcome.FAILED,
        afterDigest: null,
        failureCode: code ?? COMMAND_TOOL_FAILED,
      };
      const result = envelope(
        input.command,
        identity,
        input.operation_id,
        beforeDigest ?? canonicalDigest(null),
        decision,
        NOT_LAUNCHED,
      );
      emit(input, decision, NOT_LAUNCHED);
      return result;
    }

    // Phase C: the intent is committed, and only then may anything run. The
    // envelope below is built from the row that came BACK from the ledger.
    const into = { observed: NOT_LAUNCHED };
    const outcome = await runExactlyOnce(
      runTransaction,
      ledger,
      {
        operationId: parsed.success ? parsed.data.operation_id : input.operation_id,
        identity,
        kind: ToolKind.RUN_COMMAND,
        beforeDigest,
        // A command's write surface is not enumerable by this tool; the honest
        // mutation signal is the digest pair, not an invented path list.
        changedFiles: [],
      },
      async () => attempt(input.command, entry, input.operation_id, beforeDigest, signal, into),
    );
    const decision = decide(outcome.record);
    const result = envelope(
      input.command,
      identity,
      outcome.record.operationId,
      outcome.record.beforeDigest ?? beforeDigest,
      decision,
      into.observed,
    );
    emit(input, decision, into.observed);
    return result;
  };

  /**
   * Feed the log sink from the SAME redacted observation the model is served, so
   * the two paths cannot diverge. The log gets the untruncated text (it is
   * server-side evidence, not prompt budget) but never unredacted text.
   */
  function emit(
    input: ImplementationCommandInput,
    decision: Decision,
    observed: Observation,
  ): void {
    log?.({
      event: "command_completed",
      operation_id: input.operation_id,
      command: input.command,
      outcome: decision.outcome,
      termination: observed.termination,
      exit_code: observed.exitCode,
      signal: observed.signal,
      workspace_changed: observed.workspaceChanged,
      failure_code: decision.outcome === ToolOutcome.FAILED ? decision.failureCode : null,
      ambiguity_reason:
        decision.outcome === ToolOutcome.AMBIGUOUS ? decision.ambiguityReason : null,
      artifact: observed.artifact,
      stdout: observed.stdout,
      stderr: observed.stderr,
    });
  }

  return Object.freeze({ commands: Object.freeze(Object.keys(catalogue)), run });
}
