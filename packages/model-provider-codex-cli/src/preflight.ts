import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

import {
  subscriptionModelProfileV1,
  subscriptionProcessEnvironment,
  SubscriptionProcessConfigurationError,
  type SubscriptionAuthPreflight,
  type SubscriptionAuthPreflightResult,
  type SubscriptionModelProfileV1,
} from "@remoteagent/model-runtime";

import { CODEX_CLI_SUPPORTED_VERSION } from "./invocation.js";

const CONTROL_OUTPUT_LIMIT = 4096;
const CONTROL_TIMEOUT_LIMIT_MS = 30_000;

type ControlResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (child?.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The control command may have exited between the state check and signal.
    }
  }
}

function decode(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function oneCanonicalLine(value: string): string | null {
  const line = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  return line.includes("\n") || line.includes("\r") || line.trim() !== line ? null : line;
}

async function assertExecutable(path: string): Promise<void> {
  const [canonical, info] = await Promise.all([realpath(path), stat(path)]);
  if (canonical !== path || !info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error("Codex executable is not a canonical executable file");
  }
}

async function runControlCommand(input: {
  profile: SubscriptionModelProfileV1;
  argv: readonly string[];
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  deadline: number;
}): Promise<ControlResult> {
  if (input.signal?.aborted || Date.now() >= input.deadline) throw new Error("control cancelled");
  await assertExecutable(input.profile.executable);
  const environment = subscriptionProcessEnvironment(input.environment);
  if (input.signal?.aborted || Date.now() >= input.deadline) throw new Error("control cancelled");

  return new Promise<ControlResult>((resolve, reject) => {
    let child: ChildProcess | undefined;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let terminalError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(
      () => stop(new Error("control timed out")),
      Math.max(1, input.deadline - Date.now()),
    );
    timeout.unref();

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
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), input.profile.kill_grace_ms);
      killTimer.unref();
    };
    const onAbort = () => stop(new Error("control cancelled"));
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child = spawn(input.profile.executable, input.argv, {
        env: environment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error("control start failed"));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = CONTROL_OUTPUT_LIMIT - stdout.byteLength;
      if (remaining > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) stop(new Error("control output exceeded limit"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = CONTROL_OUTPUT_LIMIT - stderr.byteLength;
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      if (chunk.byteLength > remaining) stop(new Error("control output exceeded limit"));
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
        resolve(Object.freeze({ stdout: decode(stdout), stderr: decode(stderr), exitCode }));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function refusal(
  status: "AUTH_REQUIRED" | "API_CREDENTIALS_PRESENT" | "UNSUPPORTED_CLIENT" | "PREFLIGHT_FAILED",
  reasonCode: string,
): SubscriptionAuthPreflightResult {
  return Object.freeze({ status, reason_code: reasonCode });
}

export function createCodexSubscriptionAuthPreflight(
  input: {
    expectedClientVersion?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): SubscriptionAuthPreflight {
  const expectedVersion = input.expectedClientVersion ?? CODEX_CLI_SUPPORTED_VERSION;
  if (!/^\d+\.\d+\.\d+$/u.test(expectedVersion)) {
    throw new Error("Codex client version must be exact semver");
  }

  const verify: SubscriptionAuthPreflight["verify"] = async ({
    profile: untrustedProfile,
    signal,
  }) => {
    const profile = subscriptionModelProfileV1.parse(untrustedProfile);
    if (profile.provider !== "codex_cli") {
      return refusal("UNSUPPORTED_CLIENT", "WRONG_PROVIDER");
    }
    const rawEnvironment = input.environment ?? process.env;
    try {
      subscriptionProcessEnvironment(rawEnvironment);
    } catch (error) {
      if (error instanceof SubscriptionProcessConfigurationError) {
        return refusal("API_CREDENTIALS_PRESENT", "API_CREDENTIAL_ENVIRONMENT_PRESENT");
      }
      return refusal("PREFLIGHT_FAILED", "ENVIRONMENT_CHECK_FAILED");
    }
    const deadline = Date.now() + Math.min(profile.timeout_ms, CONTROL_TIMEOUT_LIMIT_MS);
    try {
      const version = await runControlCommand({
        profile,
        argv: ["--version"],
        environment: rawEnvironment,
        deadline,
        ...(signal === undefined ? {} : { signal }),
      });
      const versionLine = oneCanonicalLine(version.stdout);
      if (
        version.exitCode !== 0 ||
        version.stderr !== "" ||
        versionLine !== `codex-cli ${expectedVersion}`
      ) {
        return refusal("UNSUPPORTED_CLIENT", "CLIENT_VERSION_MISMATCH");
      }

      const auth = await runControlCommand({
        profile,
        argv: ["login", "status"],
        environment: rawEnvironment,
        deadline,
        ...(signal === undefined ? {} : { signal }),
      });
      const authLine = oneCanonicalLine(auth.stdout);
      if (auth.stderr !== "") return refusal("PREFLIGHT_FAILED", "AUTH_STATUS_STDERR");
      if (authLine === "Logged in using an API key") {
        return refusal("API_CREDENTIALS_PRESENT", "API_KEY_LOGIN_ACTIVE");
      }
      if (authLine === "Not logged in") return refusal("AUTH_REQUIRED", "CHATGPT_LOGIN_REQUIRED");
      if (auth.exitCode !== 0 || authLine !== "Logged in using ChatGPT") {
        return refusal("PREFLIGHT_FAILED", "UNKNOWN_AUTH_STATUS");
      }
      return Object.freeze({
        status: "SUBSCRIPTION_AUTHENTICATED" as const,
        provider: "codex_cli" as const,
        profile_name: profile.profile_name,
        client_version: expectedVersion,
        model: profile.model,
      });
    } catch {
      return refusal("PREFLIGHT_FAILED", "CONTROL_COMMAND_FAILED");
    }
  };
  return Object.freeze({ verify });
}
