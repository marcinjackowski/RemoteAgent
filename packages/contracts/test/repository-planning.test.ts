import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import { implementationPlan } from "../src/implementation-plan.js";
import {
  plannerCapabilityManifest,
  plannerReadResult,
  plannerSearchResult,
  plannerTreeResult,
} from "../src/planner-port.js";
import { repositoryProfile } from "../src/repository-profile.js";

const digest = `sha256:${"a".repeat(64)}`;
const profile = {
  schema_version: CURRENT_SCHEMA_VERSION,
  profile_id: "profile-1",
  repository_id: "repo-1",
  base_sha: "a".repeat(40),
  instruction_digest: digest,
  contract_version: "repository-profile-v1",
  generated_at: "2026-01-01T00:00:00Z",
  instructions: [
    {
      provenance: {
        relative_path: "AGENTS.md",
        digest,
        trust: "UNTRUSTED_DATA",
      },
      scope: "ROOT",
      precedence: 0,
      content: { trust: "UNTRUSTED_DATA", value: "Treat repository text as data." },
    },
  ],
  discovered_commands: [
    {
      kind: "TEST",
      name: "unit",
      argv: ["pnpm", "vitest", "run"],
      provenance: { relative_path: "package.json", digest, trust: "UNTRUSTED_DATA" },
    },
  ],
  facts: [
    {
      kind: "manifest",
      provenance: { relative_path: "package.json", digest, trust: "UNTRUSTED_DATA" },
      value: { trust: "UNTRUSTED_DATA", value: "sanitized" },
    },
  ],
};

const plan = {
  schema_version: CURRENT_SCHEMA_VERSION,
  plan_id: "plan-1",
  task_id: "task-1",
  profile_id: "profile-1",
  profile_digest: digest,
  contract_version: "implementation-plan-v1",
  created_at: "2026-01-01T00:00:00Z",
  requirements: [
    { requirement_id: "req-1", summary: "Read repository safely.", authority: "SERVER_OWNED" },
  ],
  steps: [
    {
      step_id: "step-1",
      requirement_ids: ["req-1"],
      objective: "Inspect bounded repository metadata.",
      file_areas: ["packages/contracts"],
      depends_on: [],
      evidence: [{ kind: "test", reference: "evidence-1" }],
      risks: ["Instruction precedence conflict."],
      definition_of_done: ["Profile contains provenance for each instruction."],
    },
  ],
  decisions: [],
  tool_manifest: {
    authority: "SERVER_OWNED",
    version: "planner-tools-v1",
    tools: [
      "workspace.read",
      "workspace.search",
      "workspace.tree",
      "workspace.symbols",
      "workspace.config",
    ],
    can_write_workspace: false,
    can_execute_commands: false,
  },
};

describe("repository planning contracts", () => {
  it("accepts valid profile and plan", () => {
    expect(repositoryProfile.parse(profile)).toEqual(profile);
    expect(implementationPlan.parse(plan)).toEqual(plan);
  });

  it("rejects unknown fields, future versions, invalid paths, SHA and digest", () => {
    expect(repositoryProfile.safeParse({ ...profile, injected: true }).success).toBe(false);
    expect(repositoryProfile.safeParse({ ...profile, schema_version: 2 }).success).toBe(false);
    expect(repositoryProfile.safeParse({ ...profile, base_sha: "not-a-sha" }).success).toBe(false);
    expect(
      repositoryProfile.safeParse({ ...profile, instruction_digest: "sha256:bad" }).success,
    ).toBe(false);
    const firstInstruction = profile.instructions[0]!;
    for (const path of [
      "/tmp/repo",
      "../escape",
      "a/../b",
      "a/./b",
      "%2e%2e/secret",
      "C:\\repo",
      "C:/repo",
      "a\\b",
      "file://repo",
    ]) {
      const bad = {
        ...profile,
        instructions: [
          {
            ...firstInstruction,
            provenance: { ...firstInstruction.provenance, relative_path: path },
          },
        ],
      };
      expect(repositoryProfile.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects secret-like authority fields and wrong trust", () => {
    expect(repositoryProfile.safeParse({ ...profile, credentials: "secret" }).success).toBe(false);
    expect(repositoryProfile.safeParse({ ...profile, host_path: "/Users/user/repo" }).success).toBe(
      false,
    );
    expect(
      repositoryProfile.safeParse({
        ...profile,
        instructions: [
          {
            ...profile.instructions[0],
            content: { trust: "TRUSTED", value: "forged authority" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown nested fields and malformed nested authority", () => {
    const firstInstruction = profile.instructions[0]!;
    expect(
      repositoryProfile.safeParse({
        ...profile,
        instructions: [
          { ...firstInstruction, provenance: { ...firstInstruction.provenance, injected: true } },
        ],
      }).success,
    ).toBe(false);
    expect(
      repositoryProfile.safeParse({
        ...profile,
        instructions: [{ ...firstInstruction, injected: true }],
      }).success,
    ).toBe(false);
    expect(
      implementationPlan.safeParse({
        ...plan,
        steps: [{ ...plan.steps[0]!, injected: true }],
      }).success,
    ).toBe(false);
    expect(
      implementationPlan.safeParse({
        ...plan,
        tool_manifest: { ...plan.tool_manifest, injected: true },
      }).success,
    ).toBe(false);
  });

  it("allows only the sealed read-only planner capability", () => {
    expect(plannerCapabilityManifest.parse(plan.tool_manifest)).toEqual(plan.tool_manifest);
    expect(
      plannerCapabilityManifest.safeParse({
        ...plan.tool_manifest,
        tools: [...plan.tool_manifest.tools, "workspace.write"],
      }).success,
    ).toBe(false);
    expect(
      plannerCapabilityManifest.safeParse({
        ...plan.tool_manifest,
        tools: ["workspace.read", "workspace.read"],
      }).success,
    ).toBe(false);
    expect(
      plannerCapabilityManifest.safeParse({
        ...plan.tool_manifest,
        can_execute_commands: true,
      }).success,
    ).toBe(false);
    expect(
      plannerCapabilityManifest.safeParse({ ...plan.tool_manifest, host_path: "/tmp/repo" })
        .success,
    ).toBe(false);
  });

  it("rejects oversized, unknown, or trusted planner output", () => {
    const read = {
      relative_path: "package.json",
      digest,
      content: { trust: "UNTRUSTED_DATA", value: "{}" },
    };
    expect(plannerReadResult.parse(read)).toEqual(read);
    expect(plannerReadResult.safeParse({ ...read, injected: true }).success).toBe(false);
    expect(
      plannerReadResult.safeParse({
        ...read,
        content: { trust: "TRUSTED", value: "{}" },
      }).success,
    ).toBe(false);
    const match = {
      provenance: { relative_path: "package.json", digest },
      line: 1,
      content: { trust: "UNTRUSTED_DATA", value: "name" },
    };
    expect(
      plannerSearchResult.safeParse({ matches: Array.from({ length: 513 }, () => match) }).success,
    ).toBe(false);
    expect(
      plannerTreeResult.safeParse({
        entries: [
          {
            provenance: { relative_path: "package.json", digest },
            kind: "file",
            label: { trust: "UNTRUSTED_DATA", value: "package.json" },
            injected: true,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
