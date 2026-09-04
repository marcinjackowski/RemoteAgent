import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import type { SubscriptionModelRole } from "@remoteagent/model-runtime";
import { afterEach, expect, it } from "vitest";

import { EngineeringDebugJournal } from "../src/engineering-debug-journal.js";
import {
  assertEngineeringLiveQualificationAuthority,
  ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
  ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS,
  engineeringLiveQualificationSelectionFromEnv,
} from "../src/engineering-live-qualification.js";
import type { EngineeringExecutionConfig } from "../src/engineering-execution.js";
import type { ProductionEngineeringModelRouting } from "../src/engineering-model-routing.js";

const roots: string[] = [];
const digest = (value: string) => canonicalDigest(value);

function invocation(role: SubscriptionModelRole, profile: "codex-live" | "claude-live") {
  return {
    schema_version: 1 as const,
    role,
    provider: profile === "codex-live" ? ("codex_cli" as const) : ("claude_code" as const),
    profile_name: profile,
    client_version: "qualified-client-1",
    model: profile === "codex-live" ? "gpt-5.6-codex" : "claude-opus-4-8",
    executable_digest: digest(`${profile}:executable`),
    deployment_config_digest: digest("deployment"),
    profile_config_digest: digest(`${profile}:config`),
  };
}

function routing(): ProductionEngineeringModelRouting {
  const invocations = {
    DESIGNER: invocation("DESIGNER", "codex-live"),
    IMPLEMENTER: invocation("IMPLEMENTER", "codex-live"),
    REVIEWER: invocation("REVIEWER", "claude-live"),
    VERIFIER: invocation("VERIFIER", "claude-live"),
  };
  return {
    authority: "OFFICIAL_SUBSCRIPTION_CLI",
    deployment: {} as never,
    deploymentConfigDigest: digest("deployment"),
    roles: {} as never,
    forRole: (role) => ({ invocation: invocations[role] }) as never,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("scales the outer live timeout with the diagnostic budget multiplier", () => {
  expect(ENGINEERING_LIVE_EXECUTION_BUDGET_MS).toBe(6 * 60 * 60_000);
  expect(ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS).toBe(6 * 60 * 60_000 + 15 * 60_000);
  expect(ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS).toBeGreaterThan(
    ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
  );
});

it("keeps live qualification disabled unless the complete explicit selection is present", () => {
  expect(engineeringLiveQualificationSelectionFromEnv({})).toBeNull();
  expect(() =>
    engineeringLiveQualificationSelectionFromEnv({
      RA_RUN_LIVE_IOS_ENGINEERING: "1",
      RA_LIVE_ENGINEERING_INVOCATION_ID: "live-1",
      RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE: "codex-live",
    }),
  ).toThrow(/RA_LIVE_ENGINEERING_REVIEWER_PROFILE/u);
});

it("binds the explicit implementer and reviewer profiles without fallback", () => {
  const selected = engineeringLiveQualificationSelectionFromEnv({
    RA_RUN_LIVE_IOS_ENGINEERING: "1",
    RA_LIVE_ENGINEERING_INVOCATION_ID: "live-1",
    RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE: "codex-live",
    RA_LIVE_ENGINEERING_REVIEWER_PROFILE: "claude-live",
  });
  expect(selected).not.toBeNull();
  const authority = assertEngineeringLiveQualificationAuthority({
    selection: selected!,
    routing: routing(),
    executionConfig: { configDigest: digest("execution") } as EngineeringExecutionConfig,
  });
  expect(authority).toEqual({
    authority: "EXPLICIT_SUBSCRIPTION_ROUTE",
    invocation_id: "live-1",
    implementer_invocation_digest: digest(invocation("IMPLEMENTER", "codex-live")),
    reviewer_invocation_digest: digest(invocation("REVIEWER", "claude-live")),
    execution_config_digest: digest("execution"),
    external_writes: "FORBIDDEN",
  });
  expect(() =>
    assertEngineeringLiveQualificationAuthority({
      selection: { ...selected!, reviewer_profile: "codex-live" },
      routing: routing(),
      executionConfig: { configDigest: digest("execution") } as EngineeringExecutionConfig,
    }),
  ).toThrow(/REVIEWER profile/u);
});

it("refuses to reuse a journal identity from an earlier live run", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra053-live-journal-")));
  roots.push(root);
  const first = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "live-1",
  });
  await first.close();
  await expect(
    EngineeringDebugJournal.create({ artifactRoot: root, invocationId: "live-1" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  const second = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "live-2",
  });
  expect(second.filePath).not.toBe(first.filePath);
  await second.close();
});
