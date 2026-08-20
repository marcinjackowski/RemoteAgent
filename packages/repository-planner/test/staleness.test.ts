import { describe, expect, it } from "vitest";
import {
  buildRepositoryProfile,
  checkPlanStaleness,
  compileImplementationPlan,
  PlanStalenessError,
} from "../src/index.js";
import { canonicalJson } from "../src/digest.js";

const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = "sha256:" + "a".repeat(64);
const identity = { caseId: "case-1", workspaceId: "workspace-1" } as const;
const manifest = {
  authority: "SERVER_OWNED" as const,
  version: "planner-tools-v1",
  tools: [
    "workspace.read" as const,
    "workspace.search" as const,
    "workspace.tree" as const,
    "workspace.symbols" as const,
    "workspace.config" as const,
  ],
  can_write_workspace: false as const,
  can_execute_commands: false as const,
};

function profile(
  overrides: Partial<{
    repositoryId: string;
    baseSha: string;
    generatedAt: string;
    instructionValue: string;
    facts: number;
  }> = {},
): ReturnType<typeof buildRepositoryProfile> {
  const facts = Array.from({ length: overrides.facts ?? 0 }, (_, index) => ({
    kind: `fact-${index}`,
    provenance: { relative_path: `facts/${index}.json`, digest, trust: "UNTRUSTED_DATA" as const },
    value: { trust: "UNTRUSTED_DATA" as const, value: `fact ${index}` },
  }));
  return buildRepositoryProfile({
    repositoryId: overrides.repositoryId ?? "repo-1",
    baseSha: overrides.baseSha ?? sha,
    contractVersion: "contracts-v1",
    generatedAt: overrides.generatedAt ?? "2026-08-20T10:00:00.000Z",
    expectedWorkspaceIdentity: identity,
    snapshot: {
      operationId: "snapshot-case-1-workspace-1",
      identity,
      lifecycle: "SNAPSHOTTED",
      treeDigest: digest,
      dirtyState: "CLEAN",
    },
    instructions: [
      {
        provenance: { relative_path: "AGENTS.md", digest, trust: "UNTRUSTED_DATA" },
        scope: "ROOT",
        precedence: 0,
        content: {
          trust: "UNTRUSTED_DATA",
          value: overrides.instructionValue ?? "Repository instructions are data.",
        },
      },
      {
        provenance: { relative_path: "project/AGENTS.md", digest, trust: "UNTRUSTED_DATA" },
        scope: "NESTED",
        precedence: 1,
        content: { trust: "UNTRUSTED_DATA", value: "Nested instructions are data." },
      },
    ],
    discoveredCommands: [
      {
        kind: "TEST",
        name: "test",
        argv: ["test"],
        provenance: { relative_path: "package.json", digest, trust: "UNTRUSTED_DATA" },
      },
      {
        kind: "LINT",
        name: "lint",
        argv: ["lint"],
        provenance: { relative_path: "package.json", digest, trust: "UNTRUSTED_DATA" },
      },
    ],
    facts,
  });
}

function planFor(result: ReturnType<typeof profile>, twoSteps = false) {
  const requirements = twoSteps
    ? [
        { requirementId: "req-a", summary: "Inspect repository metadata." },
        { requirementId: "req-b", summary: "Record bounded evidence." },
      ]
    : [{ requirementId: "req-a", summary: "Inspect repository metadata." }];
  const steps = twoSteps
    ? [
        {
          step_id: "step-a",
          requirement_ids: ["req-a"],
          objective: "Inspect repository metadata.",
          file_areas: ["packages/contracts"],
          depends_on: [],
          evidence: [{ kind: "test", reference: "evidence-a" }],
          risks: ["Metadata may be incomplete."],
          definition_of_done: ["Metadata is recorded."],
        },
        {
          step_id: "step-b",
          requirement_ids: ["req-b"],
          objective: "Record bounded evidence.",
          file_areas: ["packages/repository-planner"],
          depends_on: ["step-a"],
          evidence: [{ kind: "test", reference: "evidence-b" }],
          risks: ["Evidence may be stale."],
          definition_of_done: ["Evidence is bounded."],
        },
      ]
    : [
        {
          step_id: "step-a",
          requirement_ids: ["req-a"],
          objective: "Inspect repository metadata.",
          file_areas: ["packages/contracts"],
          depends_on: [],
          evidence: [{ kind: "test", reference: "evidence-a" }],
          risks: ["Metadata may be incomplete."],
          definition_of_done: ["Metadata is recorded."],
        },
      ];
  return compileImplementationPlan({
    taskId: "task-1",
    profile: result.profile,
    profileDigest: result.profileDigest,
    contractVersion: "implementation-plan-v1",
    createdAt: "2026-08-20T10:00:00.000Z",
    requirements,
    toolManifest: manifest,
    draft: { steps, decisions: [] },
  }).plan;
}

function validInput() {
  const baseline = profile({ facts: 1 });
  return {
    plan: planFor(baseline),
    baselineProfile: baseline.profile,
    currentProfile: baseline.profile,
    currentContractVersion: "implementation-plan-v1",
  };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe("plan staleness", () => {
  it("returns a frozen valid result and ignores timestamps and canonical ordering", () => {
    const input = validInput();
    const before = canonicalJson(input);
    const first = checkPlanStaleness(input);
    const second = checkPlanStaleness(input);
    expect(first).toEqual(second);
    expect(first.status).toBe("VALID");
    expect(Object.isFrozen(first)).toBe(true);
    expect(canonicalJson(input)).toBe(before);

    const newer = profile({ facts: 1, generatedAt: "2026-08-21T10:00:00.000Z" });
    expect(checkPlanStaleness({ ...input, currentProfile: newer.profile }).status).toBe("VALID");

    const baseline = profile({ facts: 2 });
    const plan = planFor(baseline, true);
    const permutedPlan = {
      ...plan,
      created_at: "2026-08-22T10:00:00.000Z",
      requirements: [...plan.requirements].reverse(),
      steps: [...plan.steps].reverse().map((step) => ({
        ...step,
        requirement_ids: [...step.requirement_ids].reverse(),
        depends_on: [...step.depends_on].reverse(),
        file_areas: [...step.file_areas].reverse(),
        evidence: [...step.evidence].reverse(),
        risks: [...step.risks].reverse(),
        definition_of_done: [...step.definition_of_done].reverse(),
      })),
      decisions: [...plan.decisions].reverse(),
    };
    const permutedProfile = {
      ...baseline.profile,
      generated_at: "2026-08-22T10:00:00.000Z",
      facts: [...baseline.profile.facts].reverse(),
      instructions: [...baseline.profile.instructions].reverse(),
      discovered_commands: [...baseline.profile.discovered_commands].reverse(),
    };
    expect(
      checkPlanStaleness({
        plan: permutedPlan,
        baselineProfile: baseline.profile,
        currentProfile: permutedProfile,
        currentContractVersion: "implementation-plan-v1",
      }).status,
    ).toBe("VALID");
  });

  it("uses deterministic precedence for each authoritative change", () => {
    const input = validInput();
    expect(
      checkPlanStaleness({
        ...input,
        currentProfile: profile({ facts: 1, baseSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" })
          .profile,
      }),
    ).toMatchObject({ status: "STALE", reason: "BASE_SHA_CHANGED" });
    expect(
      checkPlanStaleness({
        ...input,
        currentProfile: profile({ facts: 1, instructionValue: "Changed instructions." }).profile,
      }),
    ).toMatchObject({ status: "STALE", reason: "INSTRUCTION_DIGEST_CHANGED" });
    expect(
      checkPlanStaleness({ ...input, currentContractVersion: "implementation-plan-v2" }),
    ).toMatchObject({ status: "STALE", reason: "CONTRACT_VERSION_CHANGED" });
    expect(
      checkPlanStaleness({ ...input, currentProfile: profile({ facts: 2 }).profile }),
    ).toMatchObject({ status: "STALE", reason: "PROFILE_DIGEST_CHANGED" });
  });

  it("fails closed for forged, foreign, malformed, and unbound authority", () => {
    const input = validInput();
    const forgedPlan = { ...input.plan, plan_id: "plan_" + "f".repeat(64) };
    expect(code(() => checkPlanStaleness({ ...input, plan: forgedPlan }))).toBe(
      "PROFILE_BINDING_MISMATCH",
    );
    const forgedDigest = { ...input.plan, profile_digest: "sha256:" + "b".repeat(64) };
    expect(code(() => checkPlanStaleness({ ...input, plan: forgedDigest }))).toBe(
      "PROFILE_BINDING_MISMATCH",
    );
    const foreign = profile({ repositoryId: "repo-foreign", facts: 1 });
    expect(code(() => checkPlanStaleness({ ...input, currentProfile: foreign.profile }))).toBe(
      "PROFILE_BINDING_MISMATCH",
    );
    const forgedProfile = { ...input.baselineProfile, profile_id: "profile_" + "c".repeat(64) };
    expect(code(() => checkPlanStaleness({ ...input, baselineProfile: forgedProfile }))).toBe(
      "PROFILE_BINDING_MISMATCH",
    );
    expect(code(() => checkPlanStaleness({ ...input, extra: true }))).toBe("INVALID_INPUT");
    expect(
      code(() =>
        checkPlanStaleness({
          ...input,
          baselineProfile: { ...input.baselineProfile, unexpected: true },
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(code(() => checkPlanStaleness({ ...input, currentContractVersion: "" }))).toBe(
      "INVALID_INPUT",
    );
    expect(canonicalJson(input)).toBe(canonicalJson(validInput()));
    expect(PlanStalenessError).toBeDefined();
  });
});
