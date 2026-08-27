import { expect, it } from "vitest";

import {
  createRuntimeConfig,
  subscriptionModelInvocationDescriptorV1,
  type RuntimeTransport,
} from "@remoteagent/model-runtime";

import { bindProductionModelRuntimes } from "../src/worker.js";

const config = createRuntimeConfig({
  model: { provider: "legacy-conversation", model_id: "legacy-model" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
});
const conversation: RuntimeTransport = {
  converse: async () => ({ model: config.model, content: [] }),
};

const invocation = subscriptionModelInvocationDescriptorV1.parse({
  schema_version: 1,
  role: "IMPLEMENTER",
  provider: "codex_cli",
  profile_name: "codex-local",
  client_version: "1.2.3",
  model: "gpt-5.6-codex",
  executable_digest: `sha256:${"1".repeat(64)}`,
  deployment_config_digest: `sha256:${"2".repeat(64)}`,
  profile_config_digest: `sha256:${"3".repeat(64)}`,
});

it("does not reuse the legacy conversation transport as an Engineering fallback", () => {
  const bindings = bindProductionModelRuntimes({
    conversation: { transport: conversation, config },
  });
  expect(bindings.conversation.transport).toBe(conversation);
  expect(bindings.engineering).toBeNull();
});

it("accepts only an explicit official-subscription Engineering composition slot", () => {
  const engineering: RuntimeTransport = {
    converse: async () => ({
      model: { provider: "codex_cli", model_id: "gpt-5.6-codex" },
      content: [],
    }),
  };
  const bound = bindProductionModelRuntimes({
    conversation: { transport: conversation, config },
    subscriptionEngineering: {
      authority: "OFFICIAL_SUBSCRIPTION_CLI",
      transport: engineering,
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
});
