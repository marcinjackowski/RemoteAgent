import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeConfig,
  runToolLoop,
  subscriptionModelProfileV1,
  type NormalizedSubscriptionModelEvent,
} from "@remoteagent/model-runtime";
import { expect, it } from "vitest";

import { CodexCliTransport, createCodexSubscriptionAuthPreflight } from "../src/index.js";

const RUN_LIVE = process.env.RA_RUN_LIVE_CODEX_SUBSCRIPTION === "1";
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
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
] as const);

function requiredEnvironment(name: "RA_CODEX_EXECUTABLE" | "RA_CODEX_MODEL"): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required for the live Codex subscription test`);
  }
  return value;
}

function subscriptionEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SAFE_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined || value === "" ? [] : [[key, value]];
    }),
  );
}

it.skipIf(!RUN_LIVE)(
  "returns one strict result through the production Codex subscription preflight and transport",
  async () => {
    const configuredExecutable = requiredEnvironment("RA_CODEX_EXECUTABLE");
    const executable = await realpath(configuredExecutable);
    expect(configuredExecutable).toBe(executable);
    const model = requiredEnvironment("RA_CODEX_MODEL");
    const temporaryParent = await mkdtemp(join(tmpdir(), "ra-live-codex-"));
    const environment = subscriptionEnvironment();
    const profile = subscriptionModelProfileV1.parse({
      schema_version: 1,
      profile_name: "codex-live-subscription-smoke",
      provider: "codex_cli",
      executable,
      model,
      timeout_ms: 180_000,
      kill_grace_ms: 2_000,
      max_stdin_bytes: 64 * 1024,
      max_stdout_bytes: 1024 * 1024,
      max_stderr_bytes: 64 * 1024,
    });
    const events: NormalizedSubscriptionModelEvent[] = [];
    const preflight = createCodexSubscriptionAuthPreflight({ environment });
    const transport = new CodexCliTransport({
      profile,
      preflight,
      environment,
      temporaryParent,
      onEvent: (event) => events.push(event),
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: model },
      timeoutMs: 180_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 250 },
    });

    try {
      const response = await runToolLoop(transport, config, {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Return the exact status required by the response schema.",
              },
            ],
          },
        ],
        tools: [],
        outputSchema: {
          name: "CodexEngineeringSubscriptionSmokeV1",
          schema: {
            type: "object",
            properties: {
              schema_version: { type: "integer", const: 1 },
              status: { type: "string", const: "CODEX_ENGINEERING_OK" },
            },
            required: ["schema_version", "status"],
            additionalProperties: false,
          },
        },
        execute: async () => {
          throw new Error("Codex subscription smoke has no tools");
        },
      });

      expect(response).toMatchObject({
        model: { provider: "codex_cli", model_id: model },
        content: [
          {
            type: "json",
            value: { schema_version: 1, status: "CODEX_ENGINEERING_OK" },
          },
        ],
      });
      expect(response.requestId).toMatch(/^[A-Za-z0-9._:-]{1,256}$/u);
      expect(response.usage).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        totalTokens: expect.any(Number),
      });
      expect(response.usage?.inputTokens).toBeGreaterThanOrEqual(0);
      expect(response.usage?.outputTokens).toBeGreaterThanOrEqual(0);
      expect(response.usage?.totalTokens).toBeGreaterThanOrEqual(0);
      expect(response.transportAttempts).toBeGreaterThanOrEqual(1);
      expect(response.transportAttempts).toBeLessThanOrEqual(2);
      console.info(
        JSON.stringify({
          event: "CODEX_LIVE_USAGE",
          model,
          input_tokens: response.usage?.inputTokens,
          output_tokens: response.usage?.outputTokens,
          total_tokens: response.usage?.totalTokens,
          transport_attempts: response.transportAttempts,
        }),
      );
      expect(events.filter(({ event }) => event === "PREFLIGHT_STARTED")).toHaveLength(
        response.transportAttempts,
      );
      expect(events.filter(({ event }) => event === "PROCESS_EXITED")).toHaveLength(
        response.transportAttempts,
      );
      expect(events.filter(({ event }) => event === "MODEL_TURN_FINISHED")).toHaveLength(1);
      expect(events.at(-3)).toMatchObject({ event: "PROCESS_EXITED", outcome: "SUCCEEDED" });
      expect(events.at(-2)).toMatchObject({ event: "MODEL_SESSION_STARTED" });
      expect(events.at(-1)).toMatchObject({
        event: "MODEL_TURN_FINISHED",
        outcome: "SUCCEEDED",
      });
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { recursive: true, force: true });
    }
  },
  200_000,
);
