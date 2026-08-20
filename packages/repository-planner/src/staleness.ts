import {
  discoveredCommand,
  idString,
  implementationPlan,
  instructionFact,
  repositoryFact,
  repositoryProfile,
  sha256Digest,
  type ImplementationPlan,
  type RepositoryProfile,
} from "@remoteagent/contracts";
import { canonicalJson, canonicalSha256 } from "./digest.js";

export type PlanStaleReason =
  | "BASE_SHA_CHANGED"
  | "INSTRUCTION_DIGEST_CHANGED"
  | "CONTRACT_VERSION_CHANGED"
  | "PROFILE_DIGEST_CHANGED";

export type PlanStalenessInput = Readonly<{
  plan: ImplementationPlan;
  baselineProfile: RepositoryProfile;
  currentProfile: RepositoryProfile;
  currentContractVersion: string;
}>;

export type PlanStalenessResult = Readonly<
  | {
      status: "VALID";
      planId: string;
      profileId: string;
      profileDigest: string;
    }
  | {
      status: "STALE";
      planId: string;
      profileId: string;
      baselineProfileDigest: string;
      currentProfileDigest: string;
      reason: PlanStaleReason;
    }
>;

export class PlanStalenessError extends Error {
  public constructor(
    public readonly code: "INVALID_INPUT" | "PROFILE_BINDING_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "PlanStalenessError";
  }
}

function fail(code: PlanStalenessError["code"], message: string): never {
  throw new PlanStalenessError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    fail("INVALID_INPUT", "Staleness input contains an unauthorized field");
}

function byteSort<T>(values: readonly T[]): T[] {
  return [...values].sort((a, b) =>
    Buffer.from(canonicalJson(a), "utf8").compare(Buffer.from(canonicalJson(b), "utf8")),
  );
}

function normalizeProfile(profile: RepositoryProfile): RepositoryProfile {
  return {
    ...profile,
    instructions: byteSort(profile.instructions.map((value) => instructionFact.parse(value))),
    discovered_commands: byteSort(
      profile.discovered_commands.map((value) => discoveredCommand.parse(value)),
    ),
    facts: byteSort(profile.facts.map((value) => repositoryFact.parse(value))),
  };
}

function profileDigest(profile: RepositoryProfile): string {
  const normalized = normalizeProfile(profile);
  const instructionDigest = canonicalSha256(normalized.instructions);
  return canonicalSha256({
    schema_version: 1,
    repository_id: normalized.repository_id,
    base_sha: normalized.base_sha,
    instruction_digest: instructionDigest,
    contract_version: normalized.contract_version,
    instructions: normalized.instructions,
    discovered_commands: normalized.discovered_commands,
    facts: normalized.facts,
  });
}

function validateProfile(profile: unknown): RepositoryProfile {
  try {
    const parsed = repositoryProfile.parse(profile);
    const digest = profileDigest(parsed);
    const instructionDigest = canonicalSha256(normalizeProfile(parsed).instructions);
    if (parsed.instruction_digest !== instructionDigest)
      fail("PROFILE_BINDING_MISMATCH", "Profile instruction digest is invalid");
    if (parsed.profile_id !== `profile_${digest.slice("sha256:".length)}`)
      fail("PROFILE_BINDING_MISMATCH", "Profile identity does not match its digest");
    return parsed;
  } catch (error) {
    if (error instanceof PlanStalenessError) throw error;
    fail("INVALID_INPUT", "Invalid repository profile");
  }
}

function normalizePlan(plan: ImplementationPlan): ImplementationPlan {
  return {
    ...plan,
    requirements: byteSort(plan.requirements),
    steps: byteSort(
      plan.steps.map((step) => ({
        ...step,
        requirement_ids: byteSort(step.requirement_ids),
        depends_on: byteSort(step.depends_on),
        file_areas: byteSort(step.file_areas),
        evidence: byteSort(step.evidence),
        risks: byteSort(step.risks),
        definition_of_done: byteSort(step.definition_of_done),
      })),
    ),
    decisions: byteSort(plan.decisions),
    tool_manifest: plan.tool_manifest,
  };
}

function planId(plan: ImplementationPlan): string {
  const normalized = normalizePlan(plan);
  const projection = {
    schema_version: 1,
    task_id: normalized.task_id,
    profile_id: normalized.profile_id,
    profile_digest: normalized.profile_digest,
    contract_version: normalized.contract_version,
    requirements: normalized.requirements,
    steps: normalized.steps,
    decisions: normalized.decisions,
    tool_manifest: normalized.tool_manifest,
  };
  return `plan_${canonicalSha256(projection).slice("sha256:".length)}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function checkPlanStaleness(input: unknown): PlanStalenessResult {
  if (!isRecord(input)) fail("INVALID_INPUT", "Staleness input must be an object");
  exactKeys(input, ["plan", "baselineProfile", "currentProfile", "currentContractVersion"]);
  let plan: ImplementationPlan;
  try {
    plan = implementationPlan.parse(input.plan);
    sha256Digest.parse(plan.profile_digest);
    if (plan.plan_id !== planId(plan)) fail("PROFILE_BINDING_MISMATCH", "Plan identity is invalid");
  } catch (error) {
    if (error instanceof PlanStalenessError) throw error;
    fail("INVALID_INPUT", "Invalid implementation plan");
  }
  const baseline = validateProfile(input.baselineProfile);
  const current = validateProfile(input.currentProfile);
  if (plan.profile_id !== baseline.profile_id || plan.profile_digest !== profileDigest(baseline))
    fail("PROFILE_BINDING_MISMATCH", "Plan is not bound to the baseline profile");
  if (baseline.repository_id !== current.repository_id)
    fail("PROFILE_BINDING_MISMATCH", "Current profile belongs to another repository");
  try {
    idString.parse(input.currentContractVersion);
  } catch {
    fail("INVALID_INPUT", "Invalid current contract version");
  }

  const baselineDigest = profileDigest(baseline);
  const currentDigest = profileDigest(current);
  let reason: PlanStaleReason | undefined;
  if (baseline.base_sha !== current.base_sha) reason = "BASE_SHA_CHANGED";
  else if (baseline.instruction_digest !== current.instruction_digest)
    reason = "INSTRUCTION_DIGEST_CHANGED";
  else if (
    plan.contract_version !== input.currentContractVersion ||
    baseline.contract_version !== current.contract_version
  )
    reason = "CONTRACT_VERSION_CHANGED";
  else if (baselineDigest !== currentDigest) reason = "PROFILE_DIGEST_CHANGED";

  const result: PlanStalenessResult =
    reason === undefined
      ? {
          status: "VALID",
          planId: plan.plan_id,
          profileId: baseline.profile_id,
          profileDigest: baselineDigest,
        }
      : {
          status: "STALE",
          planId: plan.plan_id,
          profileId: baseline.profile_id,
          baselineProfileDigest: baselineDigest,
          currentProfileDigest: currentDigest,
          reason,
        };
  return deepFreeze(result);
}
