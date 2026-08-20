import { spawn } from "node:child_process";
import { createWorkspacePathPolicy } from "./path-policy.js";
import { prepareNetworkLaunch, ProcessRunnerError, type NetworkMode } from "./network-policy.js";
export { ProcessRunnerError, type ProcessRunnerErrorCode } from "./network-policy.js";

export type ProcessLimits = Readonly<{
  timeoutMs: number;
  outputBytes?: number;
  cpuTimeMs?: number;
  memoryBytes?: number;
}>;

export type ProcessRunInput = Readonly<{
  executable: string;
  args: readonly string[];
  workspaceRoot: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  network?: NetworkMode;
  limits: ProcessLimits;
}>;

export type ProcessRunResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}>;

const SAFE_ENV = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function validateInput(input: ProcessRunInput): void {
  if (
    typeof input.executable !== "string" ||
    input.executable.length === 0 ||
    input.executable.includes("\0")
  ) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Executable must be a non-empty path");
  }
  if (
    !Array.isArray(input.args) ||
    input.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Arguments must be a NUL-free string array");
  }
  if (!Number.isFinite(input.limits.timeoutMs) || input.limits.timeoutMs <= 0) {
    throw new ProcessRunnerError("INVALID_COMMAND", "timeoutMs must be positive");
  }
  if (
    !Number.isFinite(input.limits.outputBytes ?? 1024 * 1024) ||
    (input.limits.outputBytes ?? 1) <= 0
  ) {
    throw new ProcessRunnerError("INVALID_COMMAND", "outputBytes must be positive");
  }
  if (
    (input.limits.cpuTimeMs !== undefined &&
      (!Number.isFinite(input.limits.cpuTimeMs) || input.limits.cpuTimeMs <= 0)) ||
    (input.limits.memoryBytes !== undefined &&
      (!Number.isFinite(input.limits.memoryBytes) || input.limits.memoryBytes <= 0))
  ) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Resource limits must be finite and positive");
  }
  if (input.limits.cpuTimeMs !== undefined || input.limits.memoryBytes !== undefined) {
    throw new ProcessRunnerError(
      "NOT_ENFORCEABLE",
      "CPU and memory limits are unavailable on this adapter",
    );
  }
  if (
    input.env !== undefined &&
    (typeof input.env !== "object" || input.env === null || Array.isArray(input.env))
  ) {
    throw new ProcessRunnerError("INVALID_ENVIRONMENT", "Environment must be a string map");
  }
  for (const name of Object.keys(input.env ?? {})) {
    if (
      !SAFE_ENV.has(name) ||
      typeof input.env?.[name] !== "string" ||
      input.env[name].includes("\0")
    ) {
      throw new ProcessRunnerError(
        "INVALID_ENVIRONMENT",
        `Environment variable is not allowlisted: ${name}`,
      );
    }
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runProcess(input: ProcessRunInput): Promise<ProcessRunResult> {
  validateInput(input);
  const policy = await createWorkspacePathPolicy(input.workspaceRoot);
  const cwd = await policy.validateCommandCwd(input.cwd);
  // Re-check immediately before launch so a symlink swap fails closed at the boundary.
  await policy.validateCommandCwd(input.cwd);
  const launch = await prepareNetworkLaunch(
    input.executable,
    input.args,
    policy.root,
    input.network ?? "DENY",
  );
  await policy.validateCommandCwd(input.cwd);
  const outputLimit = input.limits.outputBytes ?? 1024 * 1024;
  const environment: Record<string, string> = { PATH: SAFE_PATH, HOME: policy.root };
  Object.assign(environment, input.env ?? {});

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputSize = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(launch.executable, [...launch.args], {
      cwd,
      env: environment,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = outputLimit - outputSize;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const text = chunk.subarray(0, remaining).toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;
      outputSize += chunk.length;
      if (chunk.length > remaining) outputTruncated = true;
      if (outputTruncated) killTree(child);
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessRunnerError("SPAWN_FAILED", error.message));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut, outputTruncated });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, input.limits.timeoutMs);
    timer.unref();
  });
}
