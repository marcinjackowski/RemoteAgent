import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  subscriptionAuthPreflightResult,
  type NormalizedSubscriptionModelEvent,
  type SubscriptionAuthPreflight,
  type SubscriptionModelProfileV1,
  type SubscriptionModelTerminalOutcome,
} from "./subscription.js";

const FORBIDDEN_ENV = [
  /^AWS_/u,
  /^BEDROCK_/u,
  /^OPENAI_API_KEY$/u,
  /^OPENAI_ACCESS_TOKEN$/u,
  /^CODEX_API_KEY$/u,
  /^ANTHROPIC_API_KEY$/u,
  /^ANTHROPIC_AUTH_TOKEN$/u,
  /^CLAUDE_CODE_OAUTH_TOKEN$/u,
  /^AZURE_OPENAI_/u,
  /^GOOGLE_APPLICATION_CREDENTIALS$/u,
  /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/u,
  /^(OPENAI|ANTHROPIC)_BASE_URL$/u,
] as const;
const SAFE_ENV = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "XDG_CONFIG_HOME",
]);
const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024;

export class SubscriptionProcessConfigurationError extends Error {
  readonly code = "SUBSCRIPTION_PROCESS_CONFIGURATION_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionProcessConfigurationError";
  }
}

export function subscriptionProcessEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "" && FORBIDDEN_ENV.some((pattern) => pattern.test(key))) {
      throw new SubscriptionProcessConfigurationError(
        "API-key or cloud-provider authentication environment is forbidden",
      );
    }
  }
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV) {
    const value = source[key];
    if (value !== undefined && value !== "" && !value.includes("\0")) safe[key] = value;
  }
  return Object.freeze(safe);
}

function validateArgv(argv: readonly string[]): readonly string[] {
  if (argv.length === 0 || argv.length > MAX_ARG_COUNT) {
    throw new SubscriptionProcessConfigurationError("argv has an invalid number of entries");
  }
  let bytes = 0;
  const copy = argv.map((argument) => {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new SubscriptionProcessConfigurationError("argv contains an invalid entry");
    }
    bytes += Buffer.byteLength(argument);
    return argument;
  });
  if (bytes > MAX_ARG_BYTES) {
    throw new SubscriptionProcessConfigurationError("argv exceeds the byte limit");
  }
  return Object.freeze(copy);
}

async function assertCanonicalExecutable(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new SubscriptionProcessConfigurationError("executable must be absolute");
  }
  const canonical = await realpath(path);
  const info = await stat(path);
  if (canonical !== path || !info.isFile() || (info.mode & 0o111) === 0) {
    throw new SubscriptionProcessConfigurationError(
      "executable must be a canonical executable file",
    );
  }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
}

function decoded(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SubscriptionProcessConfigurationError("provider output is not valid UTF-8");
  }
}

export type SubscriptionControlCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

/**
 * Run a bounded provider control surface such as `--version` or auth status.
 * It deliberately shares executable, environment, argv and process-tree
 * boundaries with model execution, but accepts no stdin and records no output.
 */
export async function runSubscriptionControlCommand(input: {
  profile: SubscriptionModelProfileV1;
  argv: readonly string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  deadline: number;
  maxOutputBytes?: number;
}): Promise<SubscriptionControlCommandResult> {
  if (input.signal?.aborted || Date.now() >= input.deadline) {
    throw new SubscriptionProcessConfigurationError("subscription control command cancelled");
  }
  await assertCanonicalExecutable(input.profile.executable);
  const argv = validateArgv(input.argv);
  const environment = subscriptionProcessEnvironment(input.environment ?? process.env);
  const maxOutputBytes = input.maxOutputBytes ?? 4096;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_CONTROL_OUTPUT_BYTES
  ) {
    throw new SubscriptionProcessConfigurationError("control output limit is invalid");
  }
  if (input.signal?.aborted || Date.now() >= input.deadline) {
    throw new SubscriptionProcessConfigurationError("subscription control command cancelled");
  }

  return new Promise<SubscriptionControlCommandResult>((resolve, reject) => {
    const child = spawn(input.profile.executable, argv, {
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let terminalError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = (error: Error) => {
      if (settled || terminalError !== undefined) return;
      terminalError = error;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, input.profile.kill_grace_ms);
      killTimer.unref();
    };
    const onAbort = () => stop(new Error("subscription control command cancelled"));
    const timeout = setTimeout(
      () => stop(new Error("subscription control command timed out")),
      Math.max(1, input.deadline - Date.now()),
    );
    timeout.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdout.byteLength;
      if (remaining > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) {
        stop(new Error("subscription control output exceeded limit"));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - stderr.byteLength;
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) {
        stop(new Error("subscription control output exceeded limit"));
      }
    });
    child.once("error", (error) => fail(error));
    child.once("close", (exitCode) => {
      if (settled) return;
      if (terminalError !== undefined) {
        fail(terminalError);
        return;
      }
      settled = true;
      cleanup();
      try {
        resolve(Object.freeze({ stdout: decoded(stdout), stderr: decoded(stderr), exitCode }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function oneSubscriptionControlLine(value: string): string | null {
  const line = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  return line.includes("\n") || line.includes("\r") || line.trim() !== line ? null : line;
}

export type SubscriptionProcessResult = Readonly<{
  outcome: SubscriptionModelTerminalOutcome;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  clientVersion: string | null;
}>;

type PendingEvent =
  | Readonly<{ event: "PREFLIGHT_STARTED" }>
  | Readonly<{
      event: "PREFLIGHT_FINISHED";
      status:
        | "SUBSCRIPTION_AUTHENTICATED"
        | "AUTH_REQUIRED"
        | "API_CREDENTIALS_PRESENT"
        | "UNSUPPORTED_CLIENT"
        | "PREFLIGHT_FAILED"
        | "TIMED_OUT"
        | "CANCELLED";
    }>
  | Readonly<{ event: "PROCESS_STARTED" }>
  | Readonly<{
      event: "PROCESS_EXITED";
      outcome: SubscriptionModelTerminalOutcome;
      exit_code: number | null;
      signal: NodeJS.Signals | null;
    }>;

type PreflightAttempt =
  | Readonly<{ kind: "RESULT"; result: unknown }>
  | Readonly<{ kind: "TERMINAL"; outcome: "PREFLIGHT_FAILED" | "TIMED_OUT" | "CANCELLED" }>;

async function runBoundedPreflight(input: {
  preflight: SubscriptionAuthPreflight;
  profile: SubscriptionModelProfileV1;
  signal?: AbortSignal;
  deadline: number;
}): Promise<PreflightAttempt> {
  if (input.signal?.aborted) return { kind: "TERMINAL", outcome: "CANCELLED" };
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) return { kind: "TERMINAL", outcome: "TIMED_OUT" };

  return new Promise<PreflightAttempt>((resolve) => {
    let settled = false;
    const finish = (result: PreflightAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ kind: "TERMINAL", outcome: "CANCELLED" });
    const timer = setTimeout(() => finish({ kind: "TERMINAL", outcome: "TIMED_OUT" }), remaining);
    timer.unref();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void input.preflight
      .verify({
        profile: input.profile,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      .then(
        (result) => finish({ kind: "RESULT", result }),
        () => finish({ kind: "TERMINAL", outcome: "PREFLIGHT_FAILED" }),
      );
  });
}

export async function runSubscriptionProcess(input: {
  profile: SubscriptionModelProfileV1;
  argv: readonly string[];
  stdin: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  preflight: SubscriptionAuthPreflight;
  onEvent?: (event: NormalizedSubscriptionModelEvent) => void;
}): Promise<SubscriptionProcessResult> {
  const deadline = Date.now() + input.profile.timeout_ms;
  await assertCanonicalExecutable(input.profile.executable);
  const argv = validateArgv(input.argv);
  const stdin = Buffer.from(input.stdin, "utf8");
  if (stdin.byteLength > input.profile.max_stdin_bytes) {
    throw new SubscriptionProcessConfigurationError("stdin exceeds the configured byte limit");
  }
  const environment = subscriptionProcessEnvironment(input.environment ?? process.env);
  let sequence = 0;
  const event = (value: PendingEvent) => {
    sequence += 1;
    input.onEvent?.({ ...value, sequence } as NormalizedSubscriptionModelEvent);
  };
  event({ event: "PREFLIGHT_STARTED" });
  const preflightAttempt = await runBoundedPreflight({
    preflight: input.preflight,
    profile: input.profile,
    deadline,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (preflightAttempt.kind === "TERMINAL") {
    event({ event: "PREFLIGHT_FINISHED", status: preflightAttempt.outcome });
    return Object.freeze({
      outcome: preflightAttempt.outcome,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      clientVersion: null,
    });
  }
  const preflight = subscriptionAuthPreflightResult.parse(preflightAttempt.result);
  event({ event: "PREFLIGHT_FINISHED", status: preflight.status });
  if (preflight.status !== "SUBSCRIPTION_AUTHENTICATED") {
    return Object.freeze({
      outcome: preflight.status,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      clientVersion: null,
    });
  }
  if (
    preflight.provider !== input.profile.provider ||
    preflight.profile_name !== input.profile.profile_name ||
    preflight.model !== input.profile.model
  ) {
    throw new SubscriptionProcessConfigurationError("preflight identity does not match profile");
  }
  if (input.signal?.aborted) {
    return Object.freeze({
      outcome: "CANCELLED",
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      clientVersion: preflight.client_version,
    });
  }

  return new Promise<SubscriptionProcessResult>((resolve, reject) => {
    let outcome: SubscriptionModelTerminalOutcome | null = null;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
      const exactOutcome = outcome ?? (exitCode === 0 ? "SUCCEEDED" : "FAILED");
      let stdoutText: string;
      let stderrText: string;
      try {
        stdoutText = decoded(stdout);
        stderrText = decoded(stderr);
      } catch (error) {
        event({ event: "PROCESS_EXITED", outcome: "FAILED", exit_code: exitCode, signal });
        reject(error);
        return;
      }
      event({ event: "PROCESS_EXITED", outcome: exactOutcome, exit_code: exitCode, signal });
      resolve(
        Object.freeze({
          outcome: exactOutcome,
          stdout: stdoutText,
          stderr: stderrText,
          exitCode,
          signal,
          clientVersion: preflight.client_version,
        }),
      );
    };
    const stop = (reason: SubscriptionModelTerminalOutcome) => {
      if (outcome !== null) return;
      outcome = reason;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), input.profile.kill_grace_ms);
      killTimer.unref();
    };
    const child = spawn(input.profile.executable, argv, {
      cwd: input.cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const onAbort = () => stop("CANCELLED");
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    child.stdin?.on("error", () => {
      // A provider may close stdin before consuming it; the exit classification remains authority.
    });
    child.once("spawn", () => {
      event({ event: "PROCESS_STARTED" });
      timeout = setTimeout(() => stop("TIMED_OUT"), Math.max(0, deadline - Date.now()));
      timeout.unref();
      child.stdin?.end(stdin);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = input.profile.max_stdout_bytes - stdout.byteLength;
      if (remaining > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) stop("OUTPUT_LIMIT_EXCEEDED");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = input.profile.max_stderr_bytes - stderr.byteLength;
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) stop("OUTPUT_LIMIT_EXCEEDED");
    });
    child.once("error", () => {
      outcome = "START_FAILED";
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
}
