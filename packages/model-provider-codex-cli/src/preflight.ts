import {
  oneSubscriptionControlLine,
  runSubscriptionControlCommand,
  subscriptionModelProfileV1,
  subscriptionProcessEnvironment,
  SubscriptionProcessConfigurationError,
  type SubscriptionAuthPreflight,
  type SubscriptionAuthPreflightResult,
} from "@remoteagent/model-runtime";

import { CODEX_CLI_SUPPORTED_VERSION } from "./invocation.js";

const CONTROL_OUTPUT_LIMIT = 4096;
const CONTROL_TIMEOUT_LIMIT_MS = 30_000;

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
      const version = await runSubscriptionControlCommand({
        profile,
        argv: ["--version"],
        environment: rawEnvironment,
        deadline,
        maxOutputBytes: CONTROL_OUTPUT_LIMIT,
        ...(signal === undefined ? {} : { signal }),
      });
      const versionLine = oneSubscriptionControlLine(version.stdout);
      if (
        version.exitCode !== 0 ||
        version.stderr !== "" ||
        versionLine !== `codex-cli ${expectedVersion}`
      ) {
        return refusal("UNSUPPORTED_CLIENT", "CLIENT_VERSION_MISMATCH");
      }

      const auth = await runSubscriptionControlCommand({
        profile,
        argv: ["login", "status"],
        environment: rawEnvironment,
        deadline,
        maxOutputBytes: CONTROL_OUTPUT_LIMIT,
        ...(signal === undefined ? {} : { signal }),
      });
      const authLine = oneSubscriptionControlLine(auth.stdout);
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
