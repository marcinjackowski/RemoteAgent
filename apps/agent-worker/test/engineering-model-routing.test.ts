import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProductionEngineeringModelRouting,
  engineeringModelRoutingFromEnv,
} from "../src/engineering-model-routing.js";
import type {
  SubscriptionAuthPreflight,
  SubscriptionAuthPreflightResult,
  SubscriptionModelProviderKind,
} from "@remoteagent/model-runtime";
import { loadSubscriptionModelDeploymentConfig } from "@remoteagent/model-runtime";

const roots: string[] = [];

async function deploymentFile(routes: Record<string, string>): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "ra-engineering-models-"));
  const root = await realpath(created);
  roots.push(root);
  const path = join(root, "models.json");
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 2,
      profiles: [
        {
          schema_version: 1,
          profile_name: "claude-local",
          provider: "claude_code",
          executable: process.execPath,
          model: "claude-opus-4-8",
          timeout_ms: 10_000,
          kill_grace_ms: 100,
          max_stdin_bytes: 65_536,
          max_stdout_bytes: 65_536,
          max_stderr_bytes: 4096,
        },
        {
          schema_version: 1,
          profile_name: "codex-local",
          provider: "codex_cli",
          executable: process.execPath,
          model: "gpt-5.6-codex",
          timeout_ms: 10_000,
          kill_grace_ms: 100,
          max_stdin_bytes: 65_536,
          max_stdout_bytes: 65_536,
          max_stderr_bytes: 4096,
        },
      ],
      routes,
    }),
  );
  return path;
}

function authenticatedPreflight(
  calls: string[],
  override?: (provider: SubscriptionModelProviderKind) => SubscriptionAuthPreflightResult,
): SubscriptionAuthPreflight {
  return {
    verify: async ({ profile }) => {
      calls.push(profile.profile_name);
      if (override !== undefined) return override(profile.provider);
      return {
        status: "SUBSCRIPTION_AUTHENTICATED",
        provider: profile.provider,
        profile_name: profile.profile_name,
        client_version: profile.provider === "codex_cli" ? "0.147.0" : "2.1.250",
        model: profile.model,
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production Engineering model routing", () => {
  it("authenticates used profiles and resolves an arbitrary exact role combination", async () => {
    const calls: string[] = [];
    const path = await deploymentFile({
      DESIGNER: "codex-local",
      IMPLEMENTER: "claude-local",
      REVIEWER: "codex-local",
      VERIFIER: "claude-local",
    });
    const routing = await createProductionEngineeringModelRouting({
      configPath: path,
      codexPreflight: authenticatedPreflight(calls),
      claudePreflight: authenticatedPreflight(calls),
    });

    expect(calls).toEqual(["claude-local", "codex-local"]);
    expect(routing.authority).toBe("OFFICIAL_SUBSCRIPTION_CLI");
    expect(routing.forRole("DESIGNER").invocation).toMatchObject({
      role: "DESIGNER",
      provider: "codex_cli",
      profile_name: "codex-local",
      client_version: "0.147.0",
    });
    expect(routing.forRole("IMPLEMENTER").invocation).toMatchObject({
      role: "IMPLEMENTER",
      provider: "claude_code",
      profile_name: "claude-local",
      client_version: "2.1.250",
    });
    expect(routing.forRole("REVIEWER").transport).toBe(routing.forRole("DESIGNER").transport);
    expect(routing.forRole("VERIFIER").transport).toBe(routing.forRole("IMPLEMENTER").transport);
    expect(routing.forRole("DESIGNER").config.model).toEqual({
      provider: "codex_cli",
      model_id: "gpt-5.6-codex",
    });
    expect(routing.forRole("IMPLEMENTER").config.model).toEqual({
      provider: "claude_code",
      model_id: "claude-opus-4-8",
    });
    expect(Object.isFrozen(routing)).toBe(true);
    expect(Object.isFrozen(routing.roles)).toBe(true);
  });

  it.each(["AUTH_REQUIRED", "API_CREDENTIALS_PRESENT"] as const)(
    "refuses %s before constructing any provider transport",
    async (status) => {
      const path = await deploymentFile({
        DESIGNER: "claude-local",
        IMPLEMENTER: "codex-local",
        REVIEWER: "codex-local",
        VERIFIER: "codex-local",
      });
      let transports = 0;
      await expect(
        createProductionEngineeringModelRouting({
          configPath: path,
          codexPreflight: authenticatedPreflight([], () => ({
            status,
            reason_code: "EXPECTED_REFUSAL",
          })),
          createCodexTransport: () => {
            transports += 1;
            throw new Error("transport must not be constructed");
          },
          claudePreflight: authenticatedPreflight([]),
          createClaudeTransport: () => {
            transports += 1;
            throw new Error("transport must not be constructed");
          },
        }),
      ).rejects.toThrow(status);
      expect(transports).toBe(0);
    },
  );

  it("rejects a preflight identity that differs from the configured profile", async () => {
    const path = await deploymentFile({
      DESIGNER: "codex-local",
      IMPLEMENTER: "codex-local",
      REVIEWER: "codex-local",
      VERIFIER: "codex-local",
    });
    await expect(
      createProductionEngineeringModelRouting({
        configPath: path,
        codexPreflight: authenticatedPreflight([], () => ({
          status: "SUBSCRIPTION_AUTHENTICATED",
          provider: "codex_cli",
          profile_name: "foreign-profile",
          client_version: "0.147.0",
          model: "gpt-5.6-codex",
        })),
      }),
    ).rejects.toThrow(/identity/u);
  });

  it("rechecks caller-supplied invocation data against the immutable role", async () => {
    const path = await deploymentFile({
      DESIGNER: "codex-local",
      IMPLEMENTER: "claude-local",
      REVIEWER: "codex-local",
      VERIFIER: "claude-local",
    });
    const routing = await createProductionEngineeringModelRouting({
      configPath: path,
      codexPreflight: authenticatedPreflight([]),
      claudePreflight: authenticatedPreflight([]),
    });
    const implementer = routing.forRole("IMPLEMENTER");
    await expect(
      implementer.assertReadyForInvocation({ invocation: implementer.invocation }),
    ).resolves.toBeUndefined();
    await expect(
      implementer.assertReadyForInvocation({
        invocation: { ...implementer.invocation, role: "REVIEWER" },
      }),
    ).rejects.toThrow(/route/u);
  });

  it("treats a missing config as disabled and a present invalid config as fatal", async () => {
    await expect(engineeringModelRoutingFromEnv({})).resolves.toBeNull();
    await expect(
      engineeringModelRoutingFromEnv({ RA_ENGINEERING_MODEL_CONFIG_PATH: "relative.json" }),
    ).rejects.toThrow(/absolute/u);
  });

  it("ignores every legacy Bedrock environment variable when resolving Engineering routes", async () => {
    const path = await deploymentFile({
      DESIGNER: "codex-local",
      IMPLEMENTER: "claude-local",
      REVIEWER: "codex-local",
      VERIFIER: "claude-local",
    });
    const routing = await engineeringModelRoutingFromEnv(
      {
        RA_ENGINEERING_MODEL_CONFIG_PATH: path,
        BEDROCK_MODEL_ID: "stale-bedrock-model",
        RA_MODEL_ID: "stale-generic-model",
        RA_MODEL_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "must-not-be-read",
        AWS_REGION: "must-not-be-read",
      },
      {
        codexPreflight: authenticatedPreflight([]),
        claudePreflight: authenticatedPreflight([]),
      },
    );
    expect(routing?.forRole("IMPLEMENTER").invocation).toMatchObject({
      provider: "claude_code",
      profile_name: "claude-local",
      model: "claude-opus-4-8",
    });
    expect(JSON.stringify(routing?.roles)).not.toContain("stale-bedrock-model");
    expect(JSON.stringify(routing?.roles)).not.toContain("must-not-be-read");
  });

  it("rejects an OpenCode profile at the Engineering deployment schema", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ra-engineering-opencode-")));
    roots.push(root);
    const path = join(root, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 2,
        profiles: [
          {
            schema_version: 1,
            profile_name: "opencode-local",
            provider: "opencode",
            executable: process.execPath,
            model: "foreign-model",
            timeout_ms: 10_000,
            kill_grace_ms: 100,
            max_stdin_bytes: 65_536,
            max_stdout_bytes: 65_536,
            max_stderr_bytes: 4096,
          },
        ],
        routes: {
          DESIGNER: "opencode-local",
          IMPLEMENTER: "opencode-local",
          REVIEWER: "opencode-local",
          VERIFIER: "opencode-local",
        },
      }),
    );
    await expect(loadSubscriptionModelDeploymentConfig(path)).rejects.toThrow(/provider/u);
  });
});
