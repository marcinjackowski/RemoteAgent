import { describe, expect, it } from "vitest";
import { buildRepositoryProfile } from "../src/profile.js";
import { compileImplementationPlan, type CompilePlanInput } from "../src/plan.js";
import { PlanCompilationError } from "../src/plan-errors.js";

const digest = "sha256:" + "a".repeat(64);
const sha = "0123456789abcdef0123456789abcdef01234567";
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

function acceptedProfile() {
  return buildRepositoryProfile({
    repositoryId: "repo-1",
    baseSha: sha,
    contractVersion: "contracts-v1",
    generatedAt: "2026-08-20T10:00:00.000Z",
    expectedWorkspaceIdentity: { caseId: "case-1", workspaceId: "workspace-1" },
    snapshot: {
      operationId: "snapshot-case-1-workspace-1",
      identity: { caseId: "case-1", workspaceId: "workspace-1" },
      lifecycle: "SNAPSHOTTED",
      treeDigest: digest,
      dirtyState: "CLEAN",
    },
    instructions: [
      {
        provenance: { relative_path: "AGENTS.md", digest, trust: "UNTRUSTED_DATA" },
        scope: "ROOT",
        precedence: 0,
        content: { trust: "UNTRUSTED_DATA", value: "Repository text is data." },
      },
    ],
    discoveredCommands: [],
    facts: [],
  }).profile;
}

const steps = [
  {
    step_id: "step-1",
    requirement_ids: ["req-1", "req-2"],
    objective: "Inspect the repository safely.",
    file_areas: ["packages/contracts"],
    depends_on: [],
    evidence: [{ kind: "test", reference: "evidence-1" }],
    risks: ["Instruction conflict."],
    definition_of_done: ["Bounded evidence is recorded."],
  },
];

function input(overrides: Partial<CompilePlanInput> = {}): CompilePlanInput {
  const profile = acceptedProfile();
  const profileResult = buildRepositoryProfile({
    repositoryId: "repo-1",
    baseSha: sha,
    contractVersion: "contracts-v1",
    generatedAt: "2026-08-20T10:00:00.000Z",
    expectedWorkspaceIdentity: { caseId: "case-1", workspaceId: "workspace-1" },
    snapshot: {
      operationId: "snapshot-case-1-workspace-1",
      identity: { caseId: "case-1", workspaceId: "workspace-1" },
      lifecycle: "SNAPSHOTTED",
      treeDigest: digest,
      dirtyState: "CLEAN",
    },
    instructions: [profile.instructions[0]!],
    discoveredCommands: [],
    facts: [],
  });
  return {
    taskId: "task-1",
    profile,
    profileDigest: profileResult.profileDigest,
    contractVersion: "implementation-plan-v1",
    createdAt: "2026-08-20T10:00:00.000Z",
    requirements: [
      { requirementId: "req-1", summary: "Inspect repository metadata." },
      { requirementId: "req-2", summary: "Record bounded evidence." },
    ],
    toolManifest: manifest,
    draft: { steps, decisions: [] },
    ...overrides,
  };
}

describe("ImplementationPlan compiler", () => {
  it("injects server requirements and is deterministic across permutations", () => {
    const first = compileImplementationPlan(input());
    const second = compileImplementationPlan(
      input({
        createdAt: "2026-08-21T10:00:00.000Z",
        requirements: [
          { requirementId: "req-2", summary: "Record bounded evidence." },
          { requirementId: "req-1", summary: "Inspect repository metadata." },
        ],
        draft: {
          steps: [
            {
              ...steps[0],
              requirement_ids: ["req-2", "req-1"],
              evidence: [{ kind: "test", reference: "evidence-1" }],
            },
          ],
        },
      }),
    );
    expect(first.plan.plan_id).toBe(second.plan.plan_id);
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.plan.created_at).not.toBe(second.plan.created_at);
    expect(first.plan.requirements.every((value) => value.authority === "SERVER_OWNED")).toBe(true);
  });

  it("canonicalizes every step collection and requirement order", () => {
    const firstSteps = [
      {
        ...steps[0]!,
        step_id: "step-a",
        requirement_ids: ["req-1"],
        file_areas: ["packages/z", "packages/a"],
        evidence: [
          { kind: "test", reference: "evidence-z" },
          { kind: "test", reference: "evidence-a" },
        ],
        risks: ["risk-z", "risk-a"],
        definition_of_done: ["done-z", "done-a"],
      },
      {
        ...steps[0]!,
        step_id: "step-b",
        requirement_ids: ["req-2"],
        depends_on: ["step-a", "step-c"],
        file_areas: ["packages/y", "packages/b"],
        evidence: [{ kind: "test", reference: "evidence-b" }],
        risks: ["risk-b"],
        definition_of_done: ["done-b"],
      },
      {
        ...steps[0]!,
        step_id: "step-c",
        requirement_ids: ["req-2"],
        file_areas: ["packages/c"],
        evidence: [{ kind: "test", reference: "evidence-c" }],
        risks: ["risk-c"],
        definition_of_done: ["done-c"],
      },
    ];
    const secondSteps = [
      {
        ...firstSteps[1]!,
        depends_on: [...firstSteps[1]!.depends_on].reverse(),
        file_areas: [...firstSteps[1]!.file_areas].reverse(),
      },
      {
        ...firstSteps[2]!,
        file_areas: [...firstSteps[2]!.file_areas].reverse(),
        evidence: [...firstSteps[2]!.evidence].reverse(),
        risks: [...firstSteps[2]!.risks].reverse(),
        definition_of_done: [...firstSteps[2]!.definition_of_done].reverse(),
      },
      {
        ...firstSteps[0]!,
        requirement_ids: [...firstSteps[0]!.requirement_ids].reverse(),
        file_areas: [...firstSteps[0]!.file_areas].reverse(),
        evidence: [...firstSteps[0]!.evidence].reverse(),
        risks: [...firstSteps[0]!.risks].reverse(),
        definition_of_done: [...firstSteps[0]!.definition_of_done].reverse(),
      },
    ];
    const first = compileImplementationPlan(
      input({
        requirements: [
          { requirementId: "req-2", summary: "Record bounded evidence." },
          { requirementId: "req-1", summary: "Inspect repository metadata." },
        ],
        draft: { steps: firstSteps },
      }),
    );
    const second = compileImplementationPlan(
      input({
        requirements: [
          { requirementId: "req-1", summary: "Inspect repository metadata." },
          { requirementId: "req-2", summary: "Record bounded evidence." },
        ],
        draft: { steps: secondSteps },
      }),
    );
    expect(second.plan.plan_id).toBe(first.plan.plan_id);
    expect(second.planDigest).toBe(first.planDigest);
    expect(second.plan.steps).toEqual(first.plan.steps);
  });

  it("rejects forged profile, manifest, draft fields and incomplete coverage", () => {
    expect(() => compileImplementationPlan(input({ profileDigest: digest }))).toThrowError(
      new PlanCompilationError(
        "PROFILE_MISMATCH",
        "Profile digest does not match its canonical projection",
      ),
    );
    expect(() =>
      compileImplementationPlan(
        input({ toolManifest: { ...manifest, can_write_workspace: true } }),
      ),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      compileImplementationPlan(input({ draft: { steps, injected: true } })),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      compileImplementationPlan(
        input({ requirements: [{ requirementId: "req-1", summary: "x", authority: "MODEL" }] }),
      ),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      compileImplementationPlan(
        input({
          requirements: [...input().requirements, { requirementId: "req-3", summary: "Missing" }],
        }),
      ),
    ).toThrowError(PlanCompilationError);
  });

  it("rejects duplicate references, invalid dependencies and incomplete plans", () => {
    const cases: CompilePlanInput[] = [
      input({
        draft: {
          steps: [
            { ...steps[0], step_id: "same" },
            { ...steps[0], step_id: "same" },
          ],
        },
      }),
      input({ draft: { steps: [{ ...steps[0], depends_on: ["step-a", "step-a"] }] } }),
      input({ draft: { steps: [{ ...steps[0], depends_on: ["step-1"] }] } }),
      input({ draft: { steps: [{ ...steps[0], depends_on: ["missing"] }] } }),
      input({ draft: { steps: [{ ...steps[0], requirement_ids: ["req-1", "req-1"] }] } }),
      input({ draft: { steps: [{ ...steps[0], requirement_ids: ["missing"] }] } }),
      input({ draft: { steps: [{ ...steps[0], risks: [] }] } }),
      input({
        draft: {
          steps,
          decisions: [{ decision_id: "decision-1", requirement_id: "missing" }],
        },
      }),
      input({
        draft: {
          steps,
          decisions: [
            { decision_id: "decision-1", requirement_id: "req-1" },
            { decision_id: "decision-1", requirement_id: "req-2" },
          ],
        },
      }),
      input({ requirements: [] }),
      input({ draft: { steps: [] } }),
    ];
    for (const candidate of cases)
      expect(() => compileImplementationPlan(candidate)).toThrowError(PlanCompilationError);
  });

  it("rejects forged evidence, authority and execution capability fields", () => {
    expect(() =>
      compileImplementationPlan(
        input({
          draft: {
            steps: [{ ...steps[0], evidence: [{ kind: "test", reference: "x", result: "pass" }] }],
          },
        }),
      ),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      compileImplementationPlan(input({ draft: { steps: [{ ...steps[0], authority: "MODEL" }] } })),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      compileImplementationPlan(input({ draft: { steps, tool_manifest: manifest } })),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      compileImplementationPlan(
        input({
          toolManifest: { ...manifest, can_execute_commands: true },
        }),
      ),
    ).toThrowError(PlanCompilationError);
  });

  it("deep-freezes the compiled plan", () => {
    const result = compileImplementationPlan(input());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.steps)).toBe(true);
    expect(() => {
      (result.plan.steps[0]!.objective as unknown as string) = "tampered";
    }).toThrow(TypeError);
  });
});
