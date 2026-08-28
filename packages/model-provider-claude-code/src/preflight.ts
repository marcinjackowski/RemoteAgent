import {
  oneSubscriptionControlLine,
  runSubscriptionControlCommand,
  subscriptionModelProfileV1,
  subscriptionProcessEnvironment,
  SubscriptionProcessConfigurationError,
  type SubscriptionAuthPreflight,
  type SubscriptionAuthPreflightResult,
} from "@remoteagent/model-runtime";

import { CLAUDE_CODE_SUPPORTED_VERSIONS } from "./invocation.js";

const CONTROL_OUTPUT_LIMIT = 4096;
const CONTROL_TIMEOUT_LIMIT_MS = 30_000;
const exactSemver = /^\d+\.\d+\.\d+$/u;

function refusal(
  status: "AUTH_REQUIRED" | "API_CREDENTIALS_PRESENT" | "UNSUPPORTED_CLIENT" | "PREFLIGHT_FAILED",
  reasonCode: string,
): SubscriptionAuthPreflightResult {
  return Object.freeze({ status, reason_code: reasonCode });
}

function supportedVersions(input: readonly string[]): ReadonlySet<string> {
  if (
    input.length === 0 ||
    input.some((value) => !exactSemver.test(value)) ||
    new Set(input).size !== input.length ||
    input.some((value, index) => index > 0 && input[index - 1]! >= value)
  ) {
    throw new Error("Claude supported versions must be unique sorted exact semvers");
  }
  return new Set(input);
}

function parseVersion(stdout: string): string | null {
  const line = oneSubscriptionControlLine(stdout);
  const match = line?.match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/u);
  return match?.[1] ?? null;
}

function classifyAuth(
  stdout: string,
): "SUBSCRIPTION" | "AUTH_REQUIRED" | "API_OR_CLOUD" | "INVALID" {
  if (Buffer.byteLength(stdout, "utf8") > CONTROL_OUTPUT_LIMIT) return "INVALID";
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "INVALID";
    const value = parsed as Record<string, unknown>;
    if (value.loggedIn === false) return "AUTH_REQUIRED";
    if (value.loggedIn !== true) return "INVALID";
    if (value.authMethod === "claude.ai" && value.apiProvider === "firstParty") {
      return "SUBSCRIPTION";
    }
    if (
      value.authMethod === "console" ||
      value.authMethod === "oauth_token" ||
      value.authMethod === "third_party" ||
      value.apiProvider === "bedrock" ||
      value.apiProvider === "vertex" ||
      value.apiProvider === "foundry"
    ) {
      return "API_OR_CLOUD";
    }
    return "INVALID";
  } catch {
    return "INVALID";
  }
}

export function createClaudeSubscriptionAuthPreflight(
  input: {
    supportedClientVersions?: readonly string[];
    environment?: NodeJS.ProcessEnv;
  } = {},
): SubscriptionAuthPreflight {
  const versions = supportedVersions(
    input.supportedClientVersions ?? CLAUDE_CODE_SUPPORTED_VERSIONS,
  );
  const verify: SubscriptionAuthPreflight["verify"] = async ({
    profile: untrustedProfile,
    signal,
  }) => {
    const profile = subscriptionModelProfileV1.parse(untrustedProfile);
    if (profile.provider !== "claude_code") {
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
      const version = await runSubscriptionControlCommand({
        profile,
        argv: ["--version"],
        environment: rawEnvironment,
        deadline,
        maxOutputBytes: CONTROL_OUTPUT_LIMIT,
        ...(signal === undefined ? {} : { signal }),
      });
      const clientVersion = parseVersion(version.stdout);
      if (
        version.exitCode !== 0 ||
        version.stderr !== "" ||
        clientVersion === null ||
        !versions.has(clientVersion)
      ) {
        return refusal("UNSUPPORTED_CLIENT", "CLIENT_VERSION_MISMATCH");
      }

      const auth = await runSubscriptionControlCommand({
        profile,
        argv: ["auth", "status", "--json"],
        environment: rawEnvironment,
        deadline,
        maxOutputBytes: CONTROL_OUTPUT_LIMIT,
        ...(signal === undefined ? {} : { signal }),
      });
      if (auth.stderr !== "") return refusal("PREFLIGHT_FAILED", "AUTH_STATUS_STDERR");
      const classification = classifyAuth(auth.stdout);
      if (classification === "AUTH_REQUIRED" || auth.exitCode === 1) {
        return refusal("AUTH_REQUIRED", "CLAUDE_SUBSCRIPTION_LOGIN_REQUIRED");
      }
      if (classification === "API_OR_CLOUD") {
        return refusal("API_CREDENTIALS_PRESENT", "NON_SUBSCRIPTION_LOGIN_ACTIVE");
      }
      if (auth.exitCode !== 0 || classification !== "SUBSCRIPTION") {
        return refusal("PREFLIGHT_FAILED", "UNKNOWN_AUTH_STATUS");
      }
      return Object.freeze({
        status: "SUBSCRIPTION_AUTHENTICATED" as const,
        provider: "claude_code" as const,
        profile_name: profile.profile_name,
        client_version: clientVersion,
        model: profile.model,
      });
    } catch {
      return refusal("PREFLIGHT_FAILED", "CONTROL_COMMAND_FAILED");
    }
  };
  return Object.freeze({ verify });
}
