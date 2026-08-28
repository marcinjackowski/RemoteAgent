import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSubscriptionModelInvocationDescriptor,
  loadSubscriptionModelDeploymentConfig,
  normalizedSubscriptionModelEvent,
  normalizeSubscriptionModelDeploymentConfig,
} from "../src/index.js";

async function profile(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    profile_name: "codex-local",
    provider: "codex_cli",
    executable: await realpath(process.execPath),
    model: "gpt-5.6-codex",
    timeout_ms: 10_000,
    kill_grace_ms: 100,
    max_stdin_bytes: 1024,
    max_stdout_bytes: 4096,
    max_stderr_bytes: 1024,
    ...overrides,
  };
}

describe("subscription model deployment config", () => {
  it("keeps provider runtime refusal outcomes content-free and closed", () => {
    for (const outcome of ["AUTH_FAILED", "QUOTA_OR_PROVIDER_FAILED", "PROVIDER_FAILED"] as const) {
      expect(
        normalizedSubscriptionModelEvent.parse({
          event: "MODEL_TURN_FINISHED",
          sequence: 1,
          provider: "claude_code",
          session_id: "session-1",
          outcome,
          usage: null,
        }),
      ).toMatchObject({ outcome });
    }
    expect(() =>
      normalizedSubscriptionModelEvent.parse({
        event: "MODEL_TURN_FINISHED",
        sequence: 1,
        provider: "claude_code",
        session_id: "session-1",
        outcome: "RATE_LIMIT_WITH_PROSE",
        usage: null,
      }),
    ).toThrow();
  });

  it("normalizes only sorted official subscription CLI profiles and binds their digest", async () => {
    const loaded = normalizeSubscriptionModelDeploymentConfig({
      schema_version: 1,
      profiles: [await profile()],
    });
    expect(loaded.config.profiles[0]?.provider).toBe("codex_cli");
    expect(loaded.profiles.get("codex-local")?.model).toBe("gpt-5.6-codex");
    expect(loaded.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(loaded.config)).toBe(true);
    expect(Object.isFrozen(loaded.config.profiles)).toBe(true);
    expect(Object.isFrozen(loaded.profiles)).toBe(true);
    expect(() =>
      (loaded.profiles as Map<string, unknown>).set("foreign", { provider: "bedrock" }),
    ).toThrow(TypeError);
    expect(loaded.profiles.has("foreign")).toBe(false);
  });

  it("accepts both official CLI providers from one canonical deployment file", async () => {
    const createdRoot = await mkdtemp(join(tmpdir(), "ra-subscription-config-"));
    const root = await realpath(createdRoot);
    try {
      const path = join(root, "models.json");
      const link = join(root, "models-link.json");
      await writeFile(
        path,
        JSON.stringify({
          schema_version: 1,
          profiles: [
            await profile({
              profile_name: "claude-local",
              provider: "claude_code",
              model: "claude-opus",
            }),
            await profile({ profile_name: "codex-local" }),
          ],
        }),
      );
      await symlink(path, link);
      const loaded = await loadSubscriptionModelDeploymentConfig(path);
      expect([...loaded.profiles.keys()]).toEqual(["claude-local", "codex-local"]);
      await expect(loadSubscriptionModelDeploymentConfig(link)).rejects.toThrow(/canonical/u);
    } finally {
      await rm(createdRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { provider: "bedrock" },
    { provider: "opencode" },
    { api_key: "forbidden" },
    { api_endpoint: "https://example.invalid" },
  ])("rejects unsupported or API-backed profile fields %#", async (override) => {
    const candidate = await profile(override);
    expect(() =>
      normalizeSubscriptionModelDeploymentConfig({
        schema_version: 1,
        profiles: [candidate],
      }),
    ).toThrow();
  });

  it("rejects duplicate or unsorted profile names", async () => {
    const first = await profile({ profile_name: "z-profile" });
    const second = await profile({ profile_name: "a-profile", provider: "claude_code" });
    expect(() =>
      normalizeSubscriptionModelDeploymentConfig({ schema_version: 1, profiles: [first, second] }),
    ).toThrow(/sorted/u);
    expect(() =>
      normalizeSubscriptionModelDeploymentConfig({ schema_version: 1, profiles: [first, first] }),
    ).toThrow(/unique/u);
  });

  it("creates a content-free exact provider/profile/client/model/config descriptor", async () => {
    const loaded = normalizeSubscriptionModelDeploymentConfig({
      schema_version: 1,
      profiles: [await profile()],
    });
    const exact = createSubscriptionModelInvocationDescriptor({
      role: "IMPLEMENTER",
      profile: loaded.config.profiles[0]!,
      clientVersion: "1.2.3",
      deploymentConfigDigest: loaded.configDigest,
    });
    expect(exact).toMatchObject({
      role: "IMPLEMENTER",
      provider: "codex_cli",
      profile_name: "codex-local",
      client_version: "1.2.3",
      model: "gpt-5.6-codex",
      deployment_config_digest: loaded.configDigest,
    });
    expect(JSON.stringify(exact)).not.toContain(process.execPath);
  });
});
