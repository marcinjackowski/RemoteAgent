import {
  implementationPlan,
  plannerCapabilityManifest,
  repositoryProfile,
  type DecisionReference,
  type ImplementationPlan,
  type PlanRequirement,
  type PlanStep,
  type PlannerCapabilityManifest,
  type RepositoryProfile,
  idString,
  isoTimestamp,
  relativeRepositoryPath,
  sha256Digest,
  text,
} from "@remoteagent/contracts";
import { canonicalJson, canonicalSha256 } from "./digest.js";
import { validatePlanCoverage } from "./coverage.js";
import { planFail } from "./plan-errors.js";

export type ServerRequirement = Readonly<{ requirementId: string; summary: string }>;

export type CompilePlanInput = Readonly<{
  taskId: string;
  profile: RepositoryProfile;
  profileDigest: string;
  contractVersion: string;
  createdAt: string;
  requirements: readonly ServerRequirement[];
  toolManifest: PlannerCapabilityManifest;
  draft: unknown;
}>;

export type CompilePlanResult = Readonly<{ plan: ImplementationPlan; planDigest: string }>;

const stepKeys = [
  "step_id",
  "requirement_ids",
  "objective",
  "file_areas",
  "depends_on",
  "evidence",
  "risks",
  "definition_of_done",
] as const;
const decisionKeys = ["decision_id", "requirement_id"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    planFail("UNAUTHORIZED_FIELD", `${label} contains an unknown or unauthorized field`);
}

function byteSort<T>(values: readonly T[]): T[] {
  return [...values].sort((a, b) =>
    Buffer.from(canonicalJson(a), "utf8").compare(Buffer.from(canonicalJson(b), "utf8")),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function parseDraft(draft: unknown): { steps: PlanStep[]; decisions: DecisionReference[] } {
  if (!isRecord(draft)) planFail("INVALID_INPUT", "Draft must be an object");
  hasOnlyKeys(draft, ["steps", "decisions"], "Draft");
  if (!Array.isArray(draft.steps) || draft.steps.length > 512)
    planFail("INVALID_INPUT", "Draft steps are invalid or oversized");
  const steps = draft.steps.map((value) => {
    if (!isRecord(value)) planFail("INVALID_INPUT", "Draft step must be an object");
    hasOnlyKeys(value, stepKeys, "Draft step");
    if (value.authority !== undefined || value.tool_manifest !== undefined)
      planFail("UNAUTHORIZED_FIELD", "Draft cannot provide authority or tools");
    try {
      return implementationPlan.shape.steps.element.parse(value);
    } catch {
      planFail("INVALID_INPUT", "Invalid draft step");
    }
  });
  const rawDecisions = draft.decisions ?? [];
  if (!Array.isArray(rawDecisions) || rawDecisions.length > 256)
    planFail("INVALID_INPUT", "Draft decisions are invalid or oversized");
  const decisions = rawDecisions.map((value) => {
    if (!isRecord(value)) planFail("INVALID_INPUT", "Draft decision must be an object");
    hasOnlyKeys(value, decisionKeys, "Draft decision");
    try {
      return implementationPlan.shape.decisions.element.parse(value);
    } catch {
      planFail("INVALID_INPUT", "Invalid draft decision");
    }
  });
  return { steps, decisions };
}

function validateProfileDigest(profile: RepositoryProfile, expected: string): void {
  try {
    repositoryProfile.parse(profile);
    sha256Digest.parse(expected);
  } catch {
    planFail("PROFILE_MISMATCH", "Profile or profile digest is invalid");
  }
  const instructions = byteSort(profile.instructions);
  const discoveredCommands = byteSort(profile.discovered_commands);
  const facts = byteSort(profile.facts);
  const instructionDigest = canonicalSha256(instructions);
  const projection = {
    schema_version: 1,
    repository_id: profile.repository_id,
    base_sha: profile.base_sha,
    instruction_digest: instructionDigest,
    contract_version: profile.contract_version,
    instructions,
    discovered_commands: discoveredCommands,
    facts,
  };
  const actual = canonicalSha256(projection);
  if (actual !== expected || profile.instruction_digest !== instructionDigest)
    planFail("PROFILE_MISMATCH", "Profile digest does not match its canonical projection");
  if (profile.profile_id !== `profile_${actual.slice("sha256:".length)}`)
    planFail("PROFILE_MISMATCH", "Profile identity does not match its digest");
}

function validateServerRequirement(value: ServerRequirement): PlanRequirement {
  if (!isRecord(value)) planFail("INVALID_INPUT", "Server requirement must be an object");
  hasOnlyKeys(value, ["requirementId", "summary"], "Server requirement");
  try {
    idString.parse(value.requirementId);
    text.parse(value.summary);
  } catch {
    planFail("INVALID_INPUT", "Invalid server requirement");
  }
  return { requirement_id: value.requirementId, summary: value.summary, authority: "SERVER_OWNED" };
}

export function compileImplementationPlan(input: CompilePlanInput): CompilePlanResult {
  try {
    idString.parse(input.taskId);
    idString.parse(input.contractVersion);
    isoTimestamp.parse(input.createdAt);
  } catch {
    planFail("INVALID_INPUT", "Invalid plan identity");
  }
  validateProfileDigest(input.profile, input.profileDigest);
  let manifest: PlannerCapabilityManifest;
  try {
    manifest = plannerCapabilityManifest.parse(input.toolManifest);
  } catch {
    planFail("UNAUTHORIZED_FIELD", "Invalid or untrusted tool manifest");
  }
  if (!Array.isArray(input.requirements) || input.requirements.length > 512)
    planFail("INVALID_INPUT", "Server requirements are invalid or oversized");
  if (input.requirements.length === 0) planFail("INCOMPLETE_PLAN", "Plan has no requirements");
  const requirements = byteSort(input.requirements.map(validateServerRequirement));
  const draft = parseDraft(input.draft);
  if (draft.steps.length === 0) planFail("INCOMPLETE_PLAN", "Plan has no steps");
  const steps = byteSort(
    draft.steps.map((step) => ({
      ...step,
      requirement_ids: byteSort(step.requirement_ids),
      depends_on: byteSort(step.depends_on),
      file_areas: byteSort(step.file_areas),
      evidence: byteSort(step.evidence),
      risks: byteSort(step.risks),
      definition_of_done: byteSort(step.definition_of_done),
    })),
  );
  const decisions = byteSort(draft.decisions);
  for (const step of steps) {
    for (const area of step.file_areas) {
      try {
        relativeRepositoryPath.parse(area);
      } catch {
        planFail("INVALID_INPUT", "Plan contains an invalid file area");
      }
    }
  }
  validatePlanCoverage({ requirements, steps, decisions });
  const projection = {
    schema_version: 1,
    task_id: input.taskId,
    profile_id: input.profile.profile_id,
    profile_digest: input.profileDigest,
    contract_version: input.contractVersion,
    requirements,
    steps,
    decisions,
    tool_manifest: manifest,
  };
  const planDigest = canonicalSha256(projection);
  let plan: ImplementationPlan;
  try {
    plan = implementationPlan.parse({
      ...projection,
      plan_id: `plan_${planDigest.slice("sha256:".length)}`,
      created_at: input.createdAt,
    });
  } catch {
    planFail("INVALID_INPUT", "Compiled plan does not satisfy its contract");
  }
  return deepFreeze({ plan, planDigest });
}
