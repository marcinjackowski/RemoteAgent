import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { EngineeringStage } from "@remoteagent/contracts";
import { CodexCliTransport } from "@remoteagent/model-provider-codex-cli";
import { ClaudeCodeTransport } from "@remoteagent/model-provider-claude-code";
import {
  createRuntimeConfig,
  createSubscriptionModelInvocationDescriptor,
  subscriptionModelInvocationDescriptorV1,
  subscriptionModelProfileV1,
  type SubscriptionAuthPreflight,
  type RuntimeTransport,
} from "@remoteagent/model-runtime";

import {
  bindProductionModelRuntimes,
  createClaudeSubscriptionModelTransport,
  createCodexSubscriptionModelTransport,
} from "../src/worker.js";
import { legacyConversationRuntimeConfigFromEnv } from "../src/legacy-conversation-model.js";

const config = createRuntimeConfig({
  model: { provider: "legacy-conversation", model_id: "legacy-model" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
});
const conversation: RuntimeTransport = {
  converse: async () => ({ model: config.model, content: [] }),
};

it("keeps the historical Bedrock defaults inside the named legacy conversation owner", () => {
  const legacy = legacyConversationRuntimeConfigFromEnv("legacy-only", {
    RA_MODEL_PROVIDER: "codex_cli",
    RA_MODEL_ID: "must-not-override-resolved-id",
  });
  expect(legacy.model).toEqual({ provider: "bedrock", model_id: "legacy-only" });
});

it("keeps Bedrock and OpenCode imports outside the production Engineering boundary", async () => {
  const files = [
    "worker.ts",
    "roles.ts",
    "engineering-execution.ts",
    "engineering-workflow.ts",
    "engineering-model-routing.ts",
    "engineering-live-qualification.ts",
    "engineering-qualification.ts",
  ];
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")),
  );
  for (const [index, source] of sources.entries()) {
    expect(source.toLowerCase(), files[index]).not.toContain("bedrock");
    expect(source.toLowerCase(), files[index]).not.toContain("opencode");
  }
});

const codexProfile = subscriptionModelProfileV1.parse({
  schema_version: 1,
  profile_name: "codex-local",
  provider: "codex_cli",
  executable: "/opt/remoteagent/bin/codex",
  model: "gpt-5.6-codex",
  timeout_ms: 1_000,
  kill_grace_ms: 50,
  max_stdin_bytes: 65_536,
  max_stdout_bytes: 65_536,
  max_stderr_bytes: 4096,
});
const invocation = subscriptionModelInvocationDescriptorV1.parse(
  createSubscriptionModelInvocationDescriptor({
    role: "IMPLEMENTER",
    profile: codexProfile,
    clientVersion: "0.147.0",
    deploymentConfigDigest: `sha256:${"2".repeat(64)}`,
  }),
);
const authenticated: SubscriptionAuthPreflight = {
  verify: async () => ({
    status: "SUBSCRIPTION_AUTHENTICATED",
    provider: "codex_cli",
    profile_name: "codex-local",
    client_version: "0.147.0",
    model: "gpt-5.6-codex",
  }),
};

const claudeProfile = subscriptionModelProfileV1.parse({
  ...codexProfile,
  profile_name: "claude-local",
  provider: "claude_code",
  executable: "/opt/remoteagent/bin/claude",
  model: "claude-opus-4-8",
});
const claudeInvocation = createSubscriptionModelInvocationDescriptor({
  role: "IMPLEMENTER",
  profile: claudeProfile,
  clientVersion: "2.1.248",
  deploymentConfigDigest: `sha256:${"3".repeat(64)}`,
});
const claudeAuthenticated: SubscriptionAuthPreflight = {
  verify: async () => ({
    status: "SUBSCRIPTION_AUTHENTICATED",
    provider: "claude_code",
    profile_name: "claude-local",
    client_version: "2.1.248",
    model: "claude-opus-4-8",
  }),
};

it("does not reuse the legacy conversation transport as an Engineering fallback", () => {
  const bindings = bindProductionModelRuntimes({
    conversation: { transport: conversation, config },
  });
  expect(bindings.conversation.transport).toBe(conversation);
  expect(bindings.engineering).toBeNull();
});

it("accepts only an explicit preflight-capable subscription Engineering slot", async () => {
  const engineering = createCodexSubscriptionModelTransport({
    profile: codexProfile,
    preflight: authenticated,
  });
  expect(engineering).toBeInstanceOf(CodexCliTransport);
  const bound = bindProductionModelRuntimes({
    conversation: { transport: conversation, config },
    subscriptionEngineering: {
      authority: "OFFICIAL_SUBSCRIPTION_CLI",
      transport: engineering,
      assertReadyForInvocation: (input) => engineering.assertInvocationReady(input),
      config: createRuntimeConfig({
        model: { provider: "codex_cli", model_id: "gpt-5.6-codex" },
        timeoutMs: 1_000,
        toolLimits: { maxIterations: 0, maxCalls: 0 },
      }),
      stageInvocation: () => invocation,
      implementationInvocation: invocation,
      reviewInvocation: { ...invocation, role: "REVIEWER" },
    },
  });
  expect(bound.engineering?.authority).toBe("OFFICIAL_SUBSCRIPTION_CLI");
  expect(bound.engineering?.transport).toBe(engineering);
  expect(bound.engineering?.transport).not.toBe(conversation);
  await expect(
    bound.engineering?.assertReadyForInvocation({ invocation }),
  ).resolves.toBeUndefined();
  await expect(
    bound.engineering?.assertReadyForInvocation({
      invocation: { ...invocation, model: "foreign-model" },
    }),
  ).rejects.toThrow(/identity does not match preflight/u);

  const unauthorized = createCodexSubscriptionModelTransport({
    profile: codexProfile,
    preflight: {
      verify: async () => ({
        status: "API_CREDENTIALS_PRESENT",
        reason_code: "API_KEY_LOGIN_ACTIVE",
      }),
    },
  });
  await expect(unauthorized.assertInvocationReady({ invocation })).rejects.toThrow(
    /preflight refused with API_CREDENTIALS_PRESENT/u,
  );
});

it("exposes Claude as the same explicit subscription slot without selecting a role", async () => {
  const engineering = createClaudeSubscriptionModelTransport({
    profile: claudeProfile,
    preflight: claudeAuthenticated,
  });
  expect(engineering).toBeInstanceOf(ClaudeCodeTransport);
  const bound = bindProductionModelRuntimes({
    conversation: { transport: conversation, config },
    subscriptionEngineering: {
      authority: "OFFICIAL_SUBSCRIPTION_CLI",
      transport: engineering,
      assertReadyForInvocation: (input) => engineering.assertInvocationReady(input),
      config: createRuntimeConfig({
        model: { provider: "claude_code", model_id: claudeProfile.model },
        timeoutMs: 1_000,
        toolLimits: { maxIterations: 0, maxCalls: 0 },
      }),
      stageInvocation: () => claudeInvocation,
      implementationInvocation: claudeInvocation,
      reviewInvocation: { ...claudeInvocation, role: "REVIEWER" },
    },
  });
  expect(bound.engineering?.transport).toBe(engineering);
  expect(bound.engineering?.transport).not.toBe(conversation);
  await expect(
    bound.engineering?.assertReadyForInvocation({ invocation: claudeInvocation }),
  ).resolves.toBeUndefined();
  await expect(
    bound.engineering?.assertReadyForInvocation({
      invocation: { ...claudeInvocation, provider: "codex_cli" },
    }),
  ).rejects.toThrow(/identity does not match preflight/u);
});

it("refuses an official production binding that omits a model-stage descriptor", () => {
  const engineering = createCodexSubscriptionModelTransport({
    profile: codexProfile,
    preflight: authenticated,
  });
  const bound = bindProductionModelRuntimes({
    conversation: { transport: conversation, config },
    subscriptionEngineering: {
      authority: "OFFICIAL_SUBSCRIPTION_CLI",
      transport: engineering,
      assertReadyForInvocation: (input) => engineering.assertInvocationReady(input),
      config: createRuntimeConfig({
        model: { provider: "codex_cli", model_id: "gpt-5.6-codex" },
        timeoutMs: 1_000,
        toolLimits: { maxIterations: 0, maxCalls: 0 },
      }),
      stageInvocation: (() => null) as never,
      implementationInvocation: invocation,
      reviewInvocation: { ...invocation, role: "REVIEWER" },
    },
  });

  expect(() => bound.engineering?.stageInvocation(EngineeringStage.PROGRAM_DESIGN)).toThrow();
});
