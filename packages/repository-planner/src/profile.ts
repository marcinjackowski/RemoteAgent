import {
  discoveredCommand,
  gitSha,
  idString,
  instructionFact,
  isoTimestamp,
  repositoryFact,
  repositoryProfile,
  sha256Digest,
  type DiscoveredCommand,
  type InstructionFact,
  type RepositoryFact,
  type RepositoryProfile,
} from "@remoteagent/contracts";
import type { WorkspaceIdentity, WorkspaceSnapshotResult } from "@remoteagent/workspace-runner";
import { canonicalJson, canonicalSha256 } from "./digest.js";

export type BuildRepositoryProfileInput = Readonly<{
  repositoryId: string;
  baseSha: string;
  contractVersion: string;
  generatedAt: string;
  expectedWorkspaceIdentity: WorkspaceIdentity;
  snapshot: WorkspaceSnapshotResult;
  instructions: readonly InstructionFact[];
  discoveredCommands: readonly DiscoveredCommand[];
  facts: readonly RepositoryFact[];
}>;

export type RepositoryProfileBuildResult = Readonly<{
  profile: RepositoryProfile;
  profileDigest: string;
  snapshotBinding: Readonly<{ identity: WorkspaceIdentity; treeDigest: string }>;
  bindingDigest: string;
}>;

export class RepositoryProfileBuildError extends Error {
  public constructor(
    public readonly code:
      "INVALID_INPUT" | "SNAPSHOT_NOT_CLEAN" | "UNSAFE_DATA" | "INCOMPLETE_PROFILE",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryProfileBuildError";
  }
}

function fail(code: RepositoryProfileBuildError["code"], message: string): never {
  throw new RepositoryProfileBuildError(code, message);
}

function byteSort<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) =>
    Buffer.from(key(a), "utf8").compare(Buffer.from(key(b), "utf8")),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function unsafeString(value: string): boolean {
  return (
    /(?:^|[\s"'=])(?:\/Users\/|\/home\/|\/tmp\/|\/private\/|[A-Za-z]:[\\/]|file:\/\/)/iu.test(
      value,
    ) ||
    /-----BEGIN [^-]*PRIVATE KEY-----/u.test(value) ||
    /(?:password|secret|token|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s]/iu.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~-]{8,}/u.test(value) ||
    /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value) ||
    /\b(?:glpat-|gh[pousr]_|AKIA)[A-Za-z0-9_-]{8,}/u.test(value)
  );
}

function assertSafeValues(value: unknown): void {
  if (typeof value === "string") {
    if (unsafeString(value))
      fail("UNSAFE_DATA", "Profile contains a host path or credential value");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeValues(item);
    return;
  }
  if (value && typeof value === "object")
    for (const item of Object.values(value as Record<string, unknown>)) assertSafeValues(item);
}

function validateSnapshot(input: BuildRepositoryProfileInput): void {
  const snapshot = input.snapshot;
  if (snapshot.lifecycle !== "SNAPSHOTTED")
    fail("SNAPSHOT_NOT_CLEAN", "Snapshot lifecycle is not SNAPSHOTTED");
  if (snapshot.dirtyState !== "CLEAN")
    fail("SNAPSHOT_NOT_CLEAN", "Workspace snapshot is not clean");
  if (
    snapshot.identity.caseId !== input.expectedWorkspaceIdentity.caseId ||
    snapshot.identity.workspaceId !== input.expectedWorkspaceIdentity.workspaceId
  )
    fail("INVALID_INPUT", "Workspace identity does not match the expected identity");
  try {
    sha256Digest.parse(snapshot.treeDigest);
  } catch {
    fail("INVALID_INPUT", "Invalid workspace tree digest");
  }
}

export function buildRepositoryProfile(
  input: BuildRepositoryProfileInput,
): RepositoryProfileBuildResult {
  validateSnapshot(input);
  try {
    idString.parse(input.repositoryId);
    gitSha.parse(input.baseSha);
    idString.parse(input.contractVersion);
    idString.parse(input.expectedWorkspaceIdentity.caseId);
    idString.parse(input.expectedWorkspaceIdentity.workspaceId);
    isoTimestamp.parse(input.generatedAt);
  } catch {
    fail("INVALID_INPUT", "Invalid server-owned profile identity");
  }
  assertSafeValues({
    repositoryId: input.repositoryId,
    contractVersion: input.contractVersion,
    identity: input.expectedWorkspaceIdentity,
  });
  if (input.instructions.length === 0)
    fail("INCOMPLETE_PROFILE", "Effective instruction set is incomplete");
  let instructions: InstructionFact[];
  let discoveredCommands: DiscoveredCommand[];
  let facts: RepositoryFact[];
  try {
    instructions = input.instructions.map((value) => instructionFact.parse(value));
    discoveredCommands = input.discoveredCommands.map((value) => discoveredCommand.parse(value));
    facts = input.facts.map((value) => repositoryFact.parse(value));
  } catch {
    fail("INVALID_INPUT", "Invalid profile fact or provenance");
  }
  assertSafeValues({ instructions, discoveredCommands, facts });
  instructions = byteSort(instructions, (value) => canonicalJson(value));
  discoveredCommands = byteSort(discoveredCommands, (value) => canonicalJson(value));
  facts = byteSort(facts, (value) => canonicalJson(value));
  const instructionDigest = canonicalSha256(instructions);
  const projection = {
    schema_version: 1,
    repository_id: input.repositoryId,
    base_sha: input.baseSha,
    instruction_digest: instructionDigest,
    contract_version: input.contractVersion,
    instructions,
    discovered_commands: discoveredCommands,
    facts,
  };
  const profileDigest = canonicalSha256(projection);
  const profile = repositoryProfile.parse({
    ...projection,
    profile_id: `profile_${profileDigest.slice("sha256:".length)}`,
    generated_at: input.generatedAt,
  });
  const snapshotBinding = {
    identity: {
      caseId: input.expectedWorkspaceIdentity.caseId,
      workspaceId: input.expectedWorkspaceIdentity.workspaceId,
    },
    treeDigest: input.snapshot.treeDigest,
  };
  const bindingDigest = canonicalSha256({
    profileDigest,
    identity: snapshotBinding.identity,
    treeDigest: snapshotBinding.treeDigest,
  });
  return deepFreeze({ profile, profileDigest, snapshotBinding, bindingDigest });
}
