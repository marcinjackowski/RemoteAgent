import {
  discoveredCommand,
  idString,
  instructionFact,
  repositoryFact,
  repositoryProfile,
  sha256Digest,
  text,
  type DiscoveredCommand,
  type RepositoryFact,
  type ImplementationPlan,
  type PlannerReadPort,
  type RepositoryProfile,
} from "@remoteagent/contracts";
import {
  computeTreeDigest,
  validateWorkspaceRoot,
  type VerifiedWorkspacePath,
  type WorkspaceSnapshotResult,
  type WorkspaceMapping,
  type WorkspaceMappingStore,
} from "@remoteagent/workspace-runner";
import {
  buildRepositoryProfile,
  type BuildRepositoryProfileInput,
  type RepositoryProfileBuildResult,
} from "./profile.js";
import { discoverInstructions } from "./instructions.js";
import { discoverAllowedConfig } from "./config-discovery.js";
import { createPlannerReadPort, createPlannerReadPortWithTestSeam } from "./read-tools.js";
import type { DiscoveryReadSeam } from "./discovery-policy.js";
import { checkPlanStaleness, PlanStalenessError, type PlanStalenessResult } from "./staleness.js";
import { canonicalJson, canonicalSha256 } from "./digest.js";
import {
  compileImplementationPlan,
  type CompilePlanInput,
  type CompilePlanResult,
  type ServerRequirement,
} from "./plan.js";
import {
  createPlanningDecision,
  type PlanningDecisionAuthority,
  type PlanningDecisionProposal,
  type PlanningDecisionResult,
} from "./ambiguity.js";

export type PlannerServerInput = Readonly<{
  context: PlannerWorkspaceContext;
  contractVersion: string;
  generatedAt: string;
  discoveredCommands: readonly DiscoveredCommand[];
  requirements: readonly ServerRequirement[];
  checkpointRevision: number;
  activeRequirementId: string;
}>;

export type PlannerWorkspaceContext = Readonly<{
  port: PlannerReadPort;
  identity: Readonly<{ caseId: string; workspaceId: string }>;
  snapshot: WorkspaceSnapshotResult;
  repositoryId: string;
  baseSha: string;
}>;

const sealedContexts = new WeakSet<object>();
const contextRoots = new WeakMap<object, VerifiedWorkspacePath>();
const contextMappings = new WeakMap<object, WorkspaceMapping>();
const contextStores = new WeakMap<object, WorkspaceMappingStore>();

export class PlannerContextError extends Error {
  public constructor(
    public readonly code: "CONTEXT_NOT_SEALED" | "SNAPSHOT_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "PlannerContextError";
  }
}

export async function createPlannerContext(
  store: WorkspaceMappingStore,
  workspaceId: string,
): Promise<PlannerWorkspaceContext> {
  return createPlannerContextFromMapping(store, workspaceId);
}

async function createContext(
  verified: VerifiedWorkspacePath,
  identity: PlannerWorkspaceContext["identity"],
  snapshot: WorkspaceSnapshotResult,
  repositoryId: string,
  baseSha: string,
  port: PlannerReadPort,
): Promise<PlannerWorkspaceContext> {
  if (
    snapshot.lifecycle !== "SNAPSHOTTED" ||
    snapshot.dirtyState !== "CLEAN" ||
    snapshot.identity.caseId !== identity.caseId ||
    snapshot.identity.workspaceId !== identity.workspaceId
  )
    throw new Error("Planner snapshot binding is invalid");
  if ((await computeTreeDigest(verified)) !== snapshot.treeDigest)
    throw new Error("Planner snapshot digest does not match workspace");
  const context = deepFreeze({
    port,
    identity: { ...identity },
    snapshot: { ...snapshot, identity: { ...snapshot.identity } },
    repositoryId,
    baseSha,
  });
  sealedContexts.add(context);
  contextRoots.set(context, verified);
  return context;
}

/** Resolve planner authority from the durable, server-owned workspace mapping. */
export async function createPlannerContextFromMapping(
  store: WorkspaceMappingStore,
  workspaceId: string,
): Promise<PlannerWorkspaceContext> {
  const mapping = await store.find(workspaceId);
  if (!mapping || mapping.workspaceId !== workspaceId || mapping.treeDigest === null)
    throw new PlannerContextError(
      "CONTEXT_NOT_SEALED",
      "A finalized workspace mapping is required",
    );
  const verified = await validateWorkspaceRoot(mapping.target);
  const actualDigest = await computeTreeDigest(verified);
  if (actualDigest !== mapping.treeDigest)
    throw new PlannerContextError("SNAPSHOT_CHANGED", "Workspace mapping snapshot is stale");
  const snapshot: WorkspaceSnapshotResult = {
    operationId: `planner:${mapping.caseId}:${mapping.workspaceId}`,
    identity: { caseId: mapping.caseId, workspaceId: mapping.workspaceId },
    lifecycle: "SNAPSHOTTED",
    treeDigest: mapping.treeDigest,
    dirtyState: "CLEAN",
  };
  const context = await createContext(
    verified,
    snapshot.identity,
    snapshot,
    mapping.repo,
    mapping.baseSha,
    await createPlannerReadPort(verified),
  );
  contextMappings.set(context, mapping);
  contextStores.set(context, store);
  return context;
}

/** Source-only race seam; intentionally absent from the package index. */
export async function createPlannerContextWithTestSeam(
  root: VerifiedWorkspacePath,
  identity: PlannerWorkspaceContext["identity"],
  snapshot: WorkspaceSnapshotResult,
  repositoryId: string,
  baseSha: string,
  seam: DiscoveryReadSeam,
): Promise<PlannerWorkspaceContext> {
  const verified = await validateWorkspaceRoot(root);
  return createContext(
    verified,
    identity,
    snapshot,
    repositoryId,
    baseSha,
    await createPlannerReadPortWithTestSeam(verified, seam),
  );
}

export type PlannerDraftPort = Readonly<{
  propose: (
    input: Readonly<{ profile: RepositoryProfile; requirements: readonly ServerRequirement[] }>,
  ) => Promise<unknown>;
}>;

export type PlannerResult = Readonly<{
  profile: RepositoryProfileBuildResult;
  plan: CompilePlanResult | null;
  decision: PlanningDecisionResult | null;
}>;

export type PlannerStalenessInput = Readonly<{
  plan: ImplementationPlan;
  baselineProfile: RepositoryProfileBuildResult;
  currentProfile: RepositoryProfileBuildResult;
  currentContractVersion: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function serverRequirements(input: PlannerServerInput): readonly ServerRequirement[] {
  if (!Number.isSafeInteger(input.checkpointRevision) || input.checkpointRevision < 0)
    throw new Error("Planner checkpoint revision is invalid");
  try {
    idString.parse(input.activeRequirementId);
  } catch {
    throw new Error("Planner active requirement is invalid");
  }
  if (
    !Array.isArray(input.requirements) ||
    input.requirements.length === 0 ||
    input.requirements.length > 512
  )
    throw new Error("Planner requirements are invalid or oversized");
  const seen = new Set<string>();
  const copy = input.requirements.map((requirement) => {
    if (
      !isRecord(requirement) ||
      Object.keys(requirement).some((key) => !["requirementId", "summary"].includes(key))
    )
      throw new Error("Planner requirement contains an unauthorized field");
    const requirementId = requirement.requirementId;
    const summary = requirement.summary;
    try {
      idString.parse(requirementId);
      text.parse(summary);
    } catch {
      throw new Error("Planner requirement is invalid");
    }
    if (typeof requirementId !== "string" || typeof summary !== "string")
      throw new Error("Planner requirement is invalid");
    if (seen.has(requirementId)) throw new Error("Planner requirements must be unique");
    seen.add(requirementId);
    return { requirementId, summary };
  });
  if (!copy.some((requirement) => requirement.requirementId === input.activeRequirementId))
    throw new Error("Planner active requirement is not in the server requirement set");
  return deepFreeze(copy);
}

function parseProposal(value: unknown): PlanningDecisionProposal {
  if (!isRecord(value)) throw new Error("Planner proposal must be an object");
  if (value.kind !== "DECISION" || !isRecord(value.proposal))
    throw new Error("Planner decision proposal is invalid");
  return value.proposal as PlanningDecisionProposal;
}

function parsePlanDraft(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== "PLAN") throw new Error("Planner plan draft is invalid");
  return value.draft;
}

function profileInput(
  input: PlannerServerInput & { configFacts: readonly RepositoryFact[] },
  instructions: Awaited<ReturnType<typeof discoverInstructions>>,
): BuildRepositoryProfileInput {
  return {
    repositoryId: input.context.repositoryId,
    baseSha: input.context.baseSha,
    contractVersion: input.contractVersion,
    generatedAt: input.generatedAt,
    expectedWorkspaceIdentity: input.context.identity,
    snapshot: input.context.snapshot,
    instructions: instructions.instructions,
    discoveredCommands: input.discoveredCommands,
    facts: input.configFacts,
  };
}

export async function buildPlannerProfile(
  input: PlannerServerInput,
): Promise<RepositoryProfileBuildResult> {
  if (!sealedContexts.has(input.context as object))
    throw new PlannerContextError("CONTEXT_NOT_SEALED", "Planner context is not sealed");
  const root = contextRoots.get(input.context as object);
  if (!root) throw new PlannerContextError("CONTEXT_NOT_SEALED", "Planner root is not sealed");
  await assertContextCurrent(input.context);
  const assertUnchanged = async (): Promise<void> => {
    let digest: string;
    try {
      digest = await computeTreeDigest(root);
    } catch {
      throw new PlannerContextError(
        "SNAPSHOT_CHANGED",
        "Planner workspace snapshot is unavailable",
      );
    }
    if (digest !== input.context.snapshot.treeDigest)
      throw new PlannerContextError(
        "SNAPSHOT_CHANGED",
        "Planner workspace changed during discovery",
      );
  };
  await assertUnchanged();
  const instructions = await discoverInstructions({ port: input.context.port });
  const config = await discoverAllowedConfig(input.context.port);
  await assertUnchanged();
  const configFacts: RepositoryFact[] = config.entries.map((entry) => ({
    kind: "CONFIG",
    provenance: { ...entry.provenance, trust: "UNTRUSTED_DATA" as const },
    value: entry.content,
  }));
  const result = buildRepositoryProfile(profileInput({ ...input, configFacts }, instructions));
  return result;
}

export async function runPlanner(
  input: PlannerServerInput,
  draftPort: PlannerDraftPort,
): Promise<PlannerResult> {
  const requirements = serverRequirements(input);
  const profile = await buildPlannerProfile(input);
  const proposal = await draftPort.propose({
    profile: profile.profile,
    requirements,
  });
  await assertContextCurrent(input.context);
  if (!isRecord(proposal)) throw new Error("Planner proposal envelope is invalid");
  if (proposal.kind === "DECISION") {
    const decisionAuthority: PlanningDecisionAuthority = {
      caseId: input.context.identity.caseId,
      checkpointRevision: input.checkpointRevision,
      profileId: profile.profile.profile_id,
      profileDigest: profile.profileDigest,
      requirementId: input.activeRequirementId,
    };
    const decision = createPlanningDecision(decisionAuthority, parseProposal(proposal));
    return { profile, plan: null, decision };
  }
  const planInput: CompilePlanInput = {
    taskId: `task_${profile.bindingDigest.slice("sha256:".length)}`,
    profile: profile.profile,
    profileDigest: profile.profileDigest,
    contractVersion: "implementation-plan-v1",
    createdAt: input.generatedAt,
    requirements,
    toolManifest: profileManifest(),
    draft: parsePlanDraft(proposal),
  };
  return { profile, plan: compileImplementationPlan(planInput), decision: null };
}

async function assertContextCurrent(context: PlannerWorkspaceContext): Promise<void> {
  const root = contextRoots.get(context as object);
  if (!root) throw new PlannerContextError("CONTEXT_NOT_SEALED", "Planner root is not sealed");
  let digest: string;
  try {
    digest = await computeTreeDigest(root);
  } catch {
    throw new PlannerContextError("SNAPSHOT_CHANGED", "Planner workspace snapshot is unavailable");
  }
  if (digest !== context.snapshot.treeDigest)
    throw new PlannerContextError("SNAPSHOT_CHANGED", "Planner workspace changed during drafting");
  const store = contextStores.get(context as object);
  const expected = contextMappings.get(context as object);
  if (store && expected) {
    const current = await store.find(expected.workspaceId);
    if (
      !current ||
      current.workspaceId !== expected.workspaceId ||
      current.caseId !== expected.caseId ||
      current.repo !== expected.repo ||
      current.baseSha !== expected.baseSha ||
      current.target !== expected.target ||
      current.treeDigest !== expected.treeDigest
    )
      throw new PlannerContextError(
        "SNAPSHOT_CHANGED",
        "Workspace mapping changed during drafting",
      );
  }
}

function stalenessFail(code: PlanStalenessError["code"], message: string): never {
  throw new PlanStalenessError(code, message);
}

function byteSortCanonical<T>(values: readonly T[]): T[] {
  return [...values].sort((a, b) =>
    Buffer.from(canonicalJson(a), "utf8").compare(Buffer.from(canonicalJson(b), "utf8")),
  );
}

/** Recompute the canonical profile digest from the profile alone. */
function recomputeProfileDigest(profile: RepositoryProfile): string {
  const instructions = byteSortCanonical(
    profile.instructions.map((value) => instructionFact.parse(value)),
  );
  const discovered = byteSortCanonical(
    profile.discovered_commands.map((value) => discoveredCommand.parse(value)),
  );
  const facts = byteSortCanonical(profile.facts.map((value) => repositoryFact.parse(value)));
  return canonicalSha256({
    schema_version: 1,
    repository_id: profile.repository_id,
    base_sha: profile.base_sha,
    instruction_digest: canonicalSha256(instructions),
    contract_version: profile.contract_version,
    instructions,
    discovered_commands: discovered,
    facts,
  });
}

function exactStalenessKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key)))
    stalenessFail("INVALID_INPUT", `${label} key set is invalid`);
}

/**
 * Re-derive every field of a serialized build result instead of trusting it.
 * A forged `bindingDigest`, a foreign `snapshotBinding` or an unauthorized field
 * fails closed with a typed error rather than reaching a `VALID` verdict.
 */
function verifiedBuildResult(value: unknown, label: string): RepositoryProfileBuildResult {
  if (!isRecord(value)) stalenessFail("INVALID_INPUT", `${label} must be an object`);
  exactStalenessKeys(
    value,
    ["profile", "profileDigest", "snapshotBinding", "bindingDigest"],
    label,
  );
  if (!isRecord(value.snapshotBinding))
    stalenessFail("INVALID_INPUT", `${label} snapshot binding must be an object`);
  exactStalenessKeys(
    value.snapshotBinding,
    ["identity", "treeDigest"],
    `${label} snapshot binding`,
  );
  const identityValue = value.snapshotBinding.identity;
  if (!isRecord(identityValue))
    stalenessFail("INVALID_INPUT", `${label} snapshot identity must be an object`);
  exactStalenessKeys(identityValue, ["caseId", "workspaceId"], `${label} snapshot identity`);
  let profile: RepositoryProfile;
  let treeDigest: string;
  let caseId: string;
  let workspaceId: string;
  let profileDigest: string;
  try {
    profile = repositoryProfile.parse(value.profile);
    treeDigest = sha256Digest.parse(value.snapshotBinding.treeDigest);
    caseId = idString.parse(identityValue.caseId);
    workspaceId = idString.parse(identityValue.workspaceId);
    sha256Digest.parse(value.profileDigest);
    sha256Digest.parse(value.bindingDigest);
    profileDigest = recomputeProfileDigest(profile);
  } catch {
    stalenessFail("INVALID_INPUT", `${label} is not a valid repository profile build result`);
  }
  const identity = { caseId, workspaceId };
  if (value.profileDigest !== profileDigest)
    stalenessFail("PROFILE_BINDING_MISMATCH", `${label} profile digest is forged`);
  const bindingDigest = canonicalSha256({ profileDigest, identity, treeDigest });
  if (value.bindingDigest !== bindingDigest)
    stalenessFail("PROFILE_BINDING_MISMATCH", `${label} snapshot binding digest is forged`);
  return deepFreeze({
    profile,
    profileDigest,
    snapshotBinding: { identity, treeDigest },
    bindingDigest,
  });
}

export function checkPlannerStaleness(input: PlannerStalenessInput): PlanStalenessResult {
  if (!isRecord(input)) stalenessFail("INVALID_INPUT", "Planner staleness input must be an object");
  exactStalenessKeys(
    input,
    ["plan", "baselineProfile", "currentProfile", "currentContractVersion"],
    "Planner staleness input",
  );
  const baseline = verifiedBuildResult(input.baselineProfile, "Baseline profile build result");
  const current = verifiedBuildResult(input.currentProfile, "Current profile build result");
  const result = checkPlanStaleness({
    plan: input.plan,
    baselineProfile: baseline.profile,
    currentProfile: current.profile,
    currentContractVersion: input.currentContractVersion,
  });
  if (result.status !== "VALID") return result;
  if (baseline.bindingDigest !== current.bindingDigest)
    return deepFreeze({
      status: "STALE" as const,
      planId: result.planId,
      profileId: baseline.profile.profile_id,
      baselineProfileDigest: baseline.bindingDigest,
      currentProfileDigest: current.bindingDigest,
      reason: "PROFILE_DIGEST_CHANGED" as const,
    });
  if (input.plan.task_id !== `task_${baseline.bindingDigest.slice("sha256:".length)}`)
    stalenessFail(
      "PROFILE_BINDING_MISMATCH",
      "Plan task identity is not bound to the baseline snapshot binding",
    );
  return result;
}

function profileManifest(): CompilePlanInput["toolManifest"] {
  return {
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
  };
}
