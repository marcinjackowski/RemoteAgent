import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  canonicalDigest,
  engineeringEvidenceBundle,
  idString,
  relativeRepositoryPath,
  sha256Digest,
  TrustLevel,
  versionedContract,
} from "@remoteagent/contracts";
import type { EngineeringEvidenceBundle } from "@remoteagent/contracts";
import {
  EngineeringControlPlaneRepository,
  JobStore,
  WorkspaceRepository,
  type EngineeringControlOperationCompletion,
  type JobLease,
  type Queryable,
  type TxDb,
} from "@remoteagent/database";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import type { NetworkMode } from "@remoteagent/workspace-runner";
import * as z from "zod";

import type { ArtifactStore } from "./artifact-store.js";
import {
  artifactReference,
  TestOutcome,
  TestPhase,
  testCommandManifest,
  testRun,
} from "./contracts.js";
import type { TestRun } from "./contracts.js";
import { runInDisposableWorkspace } from "./disposable-workspace.js";
import { createTestRunner } from "./runner.js";

/** The closed, policy-significant classes understood by the verification layer. */
export const VerificationGateClass = {
  TEST: "TEST",
  LINT: "LINT",
  TYPECHECK: "TYPECHECK",
  BUILD: "BUILD",
  ARCHITECTURE_POLICY: "ARCHITECTURE_POLICY",
  MUTATION_SAFETY: "MUTATION_SAFETY",
} as const;

const verificationGateClass = z.enum(VerificationGateClass);

export const VerificationGateTarget = {
  BASELINE: "BASELINE",
  CURRENT: "CURRENT",
} as const;

const verificationGateTarget = z.enum(VerificationGateTarget);

export const VerificationGateOutcome = {
  PASSED: "PASSED",
  FAILED: "FAILED",
  TIMED_OUT: "TIMED_OUT",
  CANCELLED: "CANCELLED",
  INFRASTRUCTURE: "INFRASTRUCTURE",
  AMBIGUOUS: "AMBIGUOUS",
} as const;

const verificationGateOutcome = z.enum(VerificationGateOutcome);
const verificationProcessSignal = z.enum([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGSYS",
]);

export const VerificationGateStatus = {
  PASSED: "PASSED",
  FAILED: "FAILED",
  INCONCLUSIVE: "INCONCLUSIVE",
} as const;

const verificationGateStatus = z.enum(VerificationGateStatus);

const absoluteExecutable = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), "executable must be an absolute path");

const verificationGateDefinitionSchema = versionedContract({
  gate_id: idString,
  gate_class: verificationGateClass,
  executable: absoluteExecutable,
  argv: z.array(z.string().max(4096)).max(128),
  relative_cwd: relativeRepositoryPath,
  required: z.boolean(),
  baseline: z.boolean(),
  test_first: z.boolean(),
  timeout_ms: z.int().positive().max(3_600_000),
  environment_profile: z.enum(["HERMETIC", "BUILD_TOOLCHAIN"]),
  network_profile: z.enum(["DENY", "LOOPBACK", "PLATFORM_MANAGED"]),
  mutable_outputs: z.array(relativeRepositoryPath).max(128),
}).superRefine((definition, ctx) => {
  if (definition.test_first && (!definition.required || !definition.baseline)) {
    ctx.addIssue({
      code: "custom",
      path: ["test_first"],
      message: "a test-first gate must be required and run against the baseline",
    });
  }
  if (new Set(definition.mutable_outputs).size !== definition.mutable_outputs.length) {
    ctx.addIssue({
      code: "custom",
      path: ["mutable_outputs"],
      message: "mutable output paths must be unique",
    });
  }
});

/** Strict, versioned, code-owned definition of one executable gate. */
export const VerificationGateDefinition = verificationGateDefinitionSchema;
export type VerificationGateDefinition = z.infer<typeof VerificationGateDefinition>;

const verificationGateReceiptSchema = versionedContract({
  receipt_id: idString,
  case_id: idString,
  workspace_id: idString,
  run_id: idString,
  operation_id: idString,
  gate_id: idString,
  target: verificationGateTarget,
  tree_digest: sha256Digest,
  config_digest: sha256Digest,
  command_digest: sha256Digest,
  outcome: verificationGateOutcome,
  exit_code: z.int().nullable(),
  signal: verificationProcessSignal.nullable(),
  duration_ms: z.int().nonnegative(),
  log_artifact: artifactReference.nullable(),
  log_digest: sha256Digest.nullable(),
}).superRefine((receipt, ctx) => {
  if (receipt.outcome === VerificationGateOutcome.PASSED && receipt.exit_code !== 0) {
    ctx.addIssue({ code: "custom", path: ["exit_code"], message: "PASSED requires exit code 0" });
  }
  if (
    (receipt.outcome === VerificationGateOutcome.PASSED ||
      receipt.outcome === VerificationGateOutcome.FAILED) &&
    receipt.signal !== null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["signal"],
      message: "an assertion outcome cannot also claim signal termination",
    });
  }
  if (
    receipt.outcome === VerificationGateOutcome.FAILED &&
    (receipt.exit_code === null || receipt.exit_code === 0)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["exit_code"],
      message: "FAILED requires a non-zero exit code",
    });
  }
  if (
    (receipt.outcome === VerificationGateOutcome.TIMED_OUT ||
      receipt.outcome === VerificationGateOutcome.CANCELLED ||
      receipt.outcome === VerificationGateOutcome.AMBIGUOUS) &&
    receipt.exit_code !== null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["exit_code"],
      message: "an unobserved or interrupted outcome cannot claim an exit code",
    });
  }
  if ((receipt.log_artifact === null) !== (receipt.log_digest === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["log_artifact"],
      message: "log artifact and digest must either both be present or both be absent",
    });
  }
  if (receipt.log_artifact !== null) {
    if (receipt.log_artifact.digest !== receipt.log_digest) {
      ctx.addIssue({
        code: "custom",
        path: ["log_digest"],
        message: "log digest must match the durable artifact reference",
      });
    }
    if (
      receipt.log_artifact.scope.case_id !== receipt.case_id ||
      receipt.log_artifact.scope.workspace_id !== receipt.workspace_id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["log_artifact", "scope"],
        message: "log artifact belongs to a foreign case or workspace",
      });
    }
  }
  if (receipt.outcome === VerificationGateOutcome.PASSED && receipt.log_artifact === null) {
    ctx.addIssue({
      code: "custom",
      path: ["log_artifact"],
      message: "PASSED requires a durable log artifact",
    });
  }
  if (receipt.log_artifact === null && receipt.outcome !== VerificationGateOutcome.INFRASTRUCTURE) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message: "a missing durable log must be classified as INFRASTRUCTURE",
    });
  }
});

/** Durable facts for exactly one gate, target tree and operation. */
export const VerificationGateReceipt = verificationGateReceiptSchema;
export type VerificationGateReceipt = z.infer<typeof VerificationGateReceipt>;

export const VerificationGateAggregate = versionedContract({
  case_id: idString,
  workspace_id: idString,
  run_id: idString,
  current_tree_digest: sha256Digest,
  baseline_tree_digest: sha256Digest.nullable(),
  config_digest: sha256Digest,
  status: verificationGateStatus,
  receipt_ids: z.array(idString).min(1).max(256),
  blocking_gate_ids: z.array(idString).max(128),
});
export type VerificationGateAggregate = z.infer<typeof VerificationGateAggregate>;

export class VerificationGateContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerificationGateContractError";
  }
}

export interface VerificationGateCatalogInput {
  readonly definitions: readonly VerificationGateDefinition[];
  readonly executable_allowlist: readonly string[];
}

export const VerificationGateOperationBinding = z.strictObject({
  gate_id: idString,
  target: verificationGateTarget,
  operation_id: idString,
});
export type VerificationGateOperationBinding = z.infer<typeof VerificationGateOperationBinding>;

function verificationGateFreezeDefinition(
  definition: VerificationGateDefinition,
): VerificationGateDefinition {
  const snapshot = {
    ...definition,
    argv: [...definition.argv],
    mutable_outputs: [...definition.mutable_outputs],
  };
  Object.freeze(snapshot.argv);
  Object.freeze(snapshot.mutable_outputs);
  return Object.freeze(snapshot);
}

function verificationGateCommandDigest(definition: VerificationGateDefinition): string {
  return canonicalDigest({
    executable: definition.executable,
    argv: definition.argv,
    relative_cwd: definition.relative_cwd,
    timeout_ms: definition.timeout_ms,
    environment_profile: definition.environment_profile,
    network_profile: definition.network_profile,
    mutable_outputs: definition.mutable_outputs,
  });
}

/**
 * Immutable server-owned catalog. Construction resolves every executable and
 * rejects aliases: a path is accepted only if it is already absolute/canonical
 * and appears verbatim in the canonical allowlist.
 */
export class VerificationGateCatalog {
  readonly definitions: readonly VerificationGateDefinition[];
  readonly executable_allowlist: readonly string[];
  readonly config_digest: string;
  readonly #byId: ReadonlyMap<string, VerificationGateDefinition>;
  readonly #commandDigests: ReadonlyMap<string, string>;

  private constructor(
    definitions: readonly VerificationGateDefinition[],
    executableAllowlist: readonly string[],
  ) {
    this.definitions = Object.freeze(definitions.map(verificationGateFreezeDefinition));
    this.executable_allowlist = Object.freeze([...executableAllowlist]);
    this.config_digest = canonicalDigest({
      definitions: this.definitions,
      executable_allowlist: this.executable_allowlist,
    });
    this.#byId = new Map(this.definitions.map((definition) => [definition.gate_id, definition]));
    this.#commandDigests = new Map(
      this.definitions.map((definition) => [
        definition.gate_id,
        verificationGateCommandDigest(definition),
      ]),
    );
    Object.freeze(this);
  }

  public static async create(
    input: VerificationGateCatalogInput,
  ): Promise<VerificationGateCatalog> {
    if (input.definitions.length === 0) {
      throw new VerificationGateContractError("a verification catalog cannot be empty");
    }
    if (input.definitions.length > 128) {
      throw new VerificationGateContractError("a verification catalog is limited to 128 gates");
    }
    if (input.executable_allowlist.length === 0) {
      throw new VerificationGateContractError("the executable allowlist cannot be empty");
    }

    const definitions = input.definitions.map((definition) =>
      VerificationGateDefinition.parse(definition),
    );
    const ids = definitions.map((definition) => definition.gate_id);
    if (new Set(ids).size !== ids.length) {
      throw new VerificationGateContractError("gate_id values must be unique");
    }

    const canonicalAllowlist: string[] = [];
    for (const executable of input.executable_allowlist) {
      if (!path.isAbsolute(executable)) {
        throw new VerificationGateContractError("allowlisted executables must be absolute paths");
      }
      const canonical = await realpath(executable);
      if (canonical !== executable) {
        throw new VerificationGateContractError("allowlisted executables must use canonical paths");
      }
      canonicalAllowlist.push(canonical);
    }
    canonicalAllowlist.sort();
    if (new Set(canonicalAllowlist).size !== canonicalAllowlist.length) {
      throw new VerificationGateContractError(
        "the executable allowlist must not contain duplicates",
      );
    }

    const allowed = new Set(canonicalAllowlist);
    for (const definition of definitions) {
      const canonical = await realpath(definition.executable);
      if (canonical !== definition.executable || !allowed.has(canonical)) {
        throw new VerificationGateContractError(
          `gate ${definition.gate_id} executable is not a canonical allowlisted path`,
        );
      }
    }

    definitions.sort((left, right) =>
      left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0,
    );
    return new VerificationGateCatalog(definitions, canonicalAllowlist);
  }

  public get(gateId: string): VerificationGateDefinition | undefined {
    return this.#byId.get(gateId);
  }

  public commandDigest(gateId: string): string {
    const digest = this.#commandDigests.get(gateId);
    if (digest === undefined) {
      throw new VerificationGateContractError(`unknown gate_id: ${gateId}`);
    }
    return digest;
  }
}

export interface VerificationGateAggregateInput {
  readonly catalog: VerificationGateCatalog;
  readonly receipts: readonly VerificationGateReceipt[];
  readonly case_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly current_tree_digest: string;
  readonly baseline_tree_digest?: string;
  readonly operation_bindings: readonly VerificationGateOperationBinding[];
}

function verificationGateIsInconclusive(outcome: z.infer<typeof verificationGateOutcome>): boolean {
  return (
    outcome === VerificationGateOutcome.TIMED_OUT ||
    outcome === VerificationGateOutcome.CANCELLED ||
    outcome === VerificationGateOutcome.INFRASTRUCTURE ||
    outcome === VerificationGateOutcome.AMBIGUOUS
  );
}

/** Pure, fail-closed derivation. No caller-supplied verdict is accepted. */
export function VerificationGateDeriveAggregate(
  input: VerificationGateAggregateInput,
): VerificationGateAggregate {
  if (input.receipts.length === 0) {
    throw new VerificationGateContractError("an aggregate cannot be derived from zero receipts");
  }
  const receipts = input.receipts.map((receipt) => VerificationGateReceipt.parse(receipt));
  const keys = receipts.map((receipt) => `${receipt.gate_id}:${receipt.target}`);
  if (new Set(keys).size !== keys.length) {
    throw new VerificationGateContractError("duplicate gate/target receipts are not allowed");
  }
  if (new Set(receipts.map((receipt) => receipt.receipt_id)).size !== receipts.length) {
    throw new VerificationGateContractError("receipt_id values must be unique");
  }

  const operationBindings = input.operation_bindings.map((binding) =>
    VerificationGateOperationBinding.parse(binding),
  );
  const operationKeys = operationBindings.map((binding) => `${binding.gate_id}:${binding.target}`);
  if (new Set(operationKeys).size !== operationKeys.length) {
    throw new VerificationGateContractError(
      "duplicate gate/target operation bindings are not allowed",
    );
  }
  if (
    new Set(operationBindings.map((binding) => binding.operation_id)).size !==
    operationBindings.length
  ) {
    throw new VerificationGateContractError("each gate/target must have a distinct operation_id");
  }
  for (const binding of operationBindings) {
    const definition = input.catalog.get(binding.gate_id);
    if (
      definition === undefined ||
      (binding.target === VerificationGateTarget.BASELINE && !definition.baseline)
    ) {
      throw new VerificationGateContractError("operation binding references a foreign gate/target");
    }
  }
  const expectedBindingKeys = new Set(
    input.catalog.definitions
      .filter((definition) => definition.required)
      .flatMap((definition) => [
        `${definition.gate_id}:${VerificationGateTarget.CURRENT}`,
        ...(definition.baseline
          ? [`${definition.gate_id}:${VerificationGateTarget.BASELINE}`]
          : []),
      ]),
  );
  if (
    operationKeys.length !== expectedBindingKeys.size ||
    operationKeys.some((key) => !expectedBindingKeys.has(key))
  ) {
    throw new VerificationGateContractError(
      "operation bindings must exactly match catalog gate/targets",
    );
  }
  const operationByKey = new Map(
    operationBindings.map((binding) => [
      `${binding.gate_id}:${binding.target}`,
      binding.operation_id,
    ]),
  );

  for (const receipt of receipts) {
    const definition = input.catalog.get(receipt.gate_id);
    if (definition === undefined) {
      throw new VerificationGateContractError(
        `receipt references foreign gate: ${receipt.gate_id}`,
      );
    }
    if (!definition.required) {
      throw new VerificationGateContractError(
        `receipt references non-required gate: ${receipt.gate_id}`,
      );
    }
    if (receipt.target === VerificationGateTarget.BASELINE && !definition.baseline) {
      throw new VerificationGateContractError(
        `gate ${receipt.gate_id} does not permit a baseline receipt`,
      );
    }
    const expectedTree =
      receipt.target === VerificationGateTarget.CURRENT
        ? input.current_tree_digest
        : input.baseline_tree_digest;
    const expectedOperation = operationByKey.get(`${receipt.gate_id}:${receipt.target}`);
    if (expectedTree === undefined) {
      throw new VerificationGateContractError(`unexpected ${receipt.target.toLowerCase()} receipt`);
    }
    if (expectedOperation === undefined) {
      throw new VerificationGateContractError("receipt has no expected operation binding");
    }
    if (
      receipt.case_id !== input.case_id ||
      receipt.workspace_id !== input.workspace_id ||
      receipt.run_id !== input.run_id
    ) {
      throw new VerificationGateContractError(
        "receipt belongs to a foreign case, workspace or run",
      );
    }
    if (receipt.tree_digest !== expectedTree) {
      throw new VerificationGateContractError("receipt is bound to a foreign tree");
    }
    if (receipt.operation_id !== expectedOperation) {
      throw new VerificationGateContractError("receipt is bound to a foreign operation");
    }
    if (receipt.config_digest !== input.catalog.config_digest) {
      throw new VerificationGateContractError("receipt is bound to a stale or foreign config");
    }
    if (receipt.command_digest !== input.catalog.commandDigest(receipt.gate_id)) {
      throw new VerificationGateContractError("receipt is bound to a stale or foreign command");
    }
  }

  const byKey = new Map(
    receipts.map((receipt) => [`${receipt.gate_id}:${receipt.target}`, receipt]),
  );
  const requiredReceipts: VerificationGateReceipt[] = [];
  for (const definition of input.catalog.definitions) {
    if (!definition.required) continue;
    const current = byKey.get(`${definition.gate_id}:${VerificationGateTarget.CURRENT}`);
    if (current === undefined) {
      throw new VerificationGateContractError(
        `missing required current receipt: ${definition.gate_id}`,
      );
    }
    requiredReceipts.push(current);
    if (definition.baseline) {
      const baseline = byKey.get(`${definition.gate_id}:${VerificationGateTarget.BASELINE}`);
      if (baseline === undefined) {
        throw new VerificationGateContractError(
          `missing required baseline receipt: ${definition.gate_id}`,
        );
      }
      requiredReceipts.push(baseline);
    }
  }
  if (requiredReceipts.length === 0) {
    throw new VerificationGateContractError(
      "an aggregate requires at least one required gate receipt",
    );
  }

  const blocking = new Set<string>();
  let inconclusive = false;
  let failed = false;
  for (const definition of input.catalog.definitions) {
    if (!definition.required) continue;
    const current = byKey.get(`${definition.gate_id}:${VerificationGateTarget.CURRENT}`)!;
    const baseline = byKey.get(`${definition.gate_id}:${VerificationGateTarget.BASELINE}`);
    if (verificationGateIsInconclusive(current.outcome)) {
      inconclusive = true;
      blocking.add(definition.gate_id);
    } else if (current.outcome !== VerificationGateOutcome.PASSED) {
      failed = true;
      blocking.add(definition.gate_id);
    }
    if (definition.test_first) {
      if (baseline === undefined || verificationGateIsInconclusive(baseline.outcome)) {
        inconclusive = true;
        blocking.add(definition.gate_id);
      } else if (
        baseline.outcome !== VerificationGateOutcome.FAILED ||
        current.outcome !== VerificationGateOutcome.PASSED
      ) {
        failed = true;
        blocking.add(definition.gate_id);
      }
    } else if (baseline !== undefined && verificationGateIsInconclusive(baseline.outcome)) {
      inconclusive = true;
      blocking.add(definition.gate_id);
    }
  }

  return VerificationGateAggregate.parse({
    schema_version: 1,
    case_id: input.case_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    current_tree_digest: input.current_tree_digest,
    baseline_tree_digest: input.baseline_tree_digest ?? null,
    config_digest: input.catalog.config_digest,
    status: inconclusive
      ? VerificationGateStatus.INCONCLUSIVE
      : failed
        ? VerificationGateStatus.FAILED
        : VerificationGateStatus.PASSED,
    receipt_ids: receipts.map((receipt) => receipt.receipt_id).sort(),
    blocking_gate_ids: [...blocking].sort(),
  });
}

const VERIFICATION_GATE_SCHEMA_DIGEST = canonicalDigest({
  contract: "VerificationGateReceipt",
  schema_version: 1,
});

const verificationGateDescriptor = z
  .object({
    kind: z.literal("verification.gate.v1"),
    case_id: idString,
    workspace_id: idString,
    run_id: idString,
    stage_attempt: z.int().positive(),
    gate_id: idString,
    target: verificationGateTarget,
    tree_digest: sha256Digest,
    config_digest: sha256Digest,
    command_digest: sha256Digest,
  })
  .strict();

export type VerificationGatePlatformRunInput = Readonly<{
  definition: VerificationGateDefinition;
  disposable_root: string;
  scope: Readonly<{ case_id: string; workspace_id: string }>;
  store: ArtifactStore;
  signal?: AbortSignal;
}>;

/**
 * Explicit port for profiles the generic macOS sandbox adapter cannot enforce.
 * Implementations are server-owned platform configuration, never model input.
 */
export interface VerificationGatePlatformAdapter {
  run(input: VerificationGatePlatformRunInput): Promise<TestRun>;
}

export type VerificationGateDatabase = Queryable & TxDb;

export type VerificationGateExecutionInput = Readonly<{
  db: VerificationGateDatabase;
  jobs: JobStore;
  lease: JobLease;
  catalog: VerificationGateCatalog;
  gate_id: string;
  target: z.infer<typeof verificationGateTarget>;
  case_id: string;
  workspace_id: string;
  run_id: string;
  stage_attempt: number;
  deadline_at: string;
  authoritative_root: string;
  store: ArtifactStore;
  signal?: AbortSignal;
  control_plane?: EngineeringControlPlaneRepository;
  platform_adapter?: VerificationGatePlatformAdapter;
  now?: () => number;
}>;

export type VerificationGateExecutionResult =
  | Readonly<{
      status: "RECORDED";
      operation_id: string;
      completion_id: string;
      receipt: VerificationGateReceipt;
    }>
  | Readonly<{
      status: "AMBIGUOUS";
      operation_id: string;
      receipt: null;
    }>;

function verificationGateOperationId(input: z.infer<typeof verificationGateDescriptor>): string {
  return `verification-gate-${canonicalDigest(input).slice("sha256:".length)}`;
}

function verificationGateReceiptId(
  receipt: Omit<VerificationGateReceipt, "schema_version" | "receipt_id">,
): string {
  return `verification-receipt-${canonicalDigest(receipt).slice("sha256:".length)}`;
}

function verificationGateOperationStore(store: ArtifactStore, operationId: string): ArtifactStore {
  const artifactId = `verification-log-${canonicalDigest({ operation_id: operationId }).slice(
    "sha256:".length,
  )}`;
  return {
    put: (request) => store.put({ ...request, artifact_id: artifactId }),
    get: (reference) => store.get(reference),
    has: (reference) => store.has(reference),
  };
}

function testPhaseFor(definition: VerificationGateDefinition): TestPhase {
  switch (definition.gate_class) {
    case VerificationGateClass.LINT:
      return TestPhase.LINT;
    case VerificationGateClass.TYPECHECK:
      return TestPhase.TYPECHECK;
    case VerificationGateClass.BUILD:
      return TestPhase.BUILD;
    case VerificationGateClass.TEST:
      return TestPhase.UNIT;
    case VerificationGateClass.ARCHITECTURE_POLICY:
    case VerificationGateClass.MUTATION_SAFETY:
      return TestPhase.CUSTOM;
  }
}

function verificationGateManifestDigest(definition: VerificationGateDefinition): string {
  return canonicalDigest({ definition });
}

export function VerificationGateValidateTestRun(
  rawRun: unknown,
  definition: VerificationGateDefinition,
  expected: { case_id: string; workspace_id: string; tree_digest: string },
): TestRun {
  const run = testRun.parse(rawRun);
  if (
    run.scope.case_id !== expected.case_id ||
    run.scope.workspace_id !== expected.workspace_id ||
    run.command_name !== definition.gate_id ||
    run.phase !== testPhaseFor(definition) ||
    run.manifest_digest !== verificationGateManifestDigest(definition) ||
    run.tree_digest_before !== expected.tree_digest
  ) {
    throw new VerificationGateContractError("platform run binding mismatch");
  }
  const expectedReceiptDigest = canonicalDigest({
    run_id: run.run_id,
    scope: run.scope,
    command_name: run.command_name,
    phase: run.phase,
    manifest_digest: run.manifest_digest,
    outcome: run.outcome,
    exit_code: run.exit_code,
    signal: run.signal,
    tree_digest_before: run.tree_digest_before,
    tree_digest_after: run.tree_digest_after,
    artifact_digest: run.artifact?.digest ?? null,
  });
  if (run.receipt_digest !== expectedReceiptDigest) {
    throw new VerificationGateContractError("platform run receipt digest mismatch");
  }
  return run;
}

function gateOutcomeFor(run: TestRun): z.infer<typeof verificationGateOutcome> {
  if (run.artifact === null) return VerificationGateOutcome.INFRASTRUCTURE;
  switch (run.outcome) {
    case TestOutcome.PASSED:
      return VerificationGateOutcome.PASSED;
    case TestOutcome.FAILED:
      return VerificationGateOutcome.FAILED;
    case TestOutcome.TIMED_OUT:
      return VerificationGateOutcome.TIMED_OUT;
    case TestOutcome.CANCELED:
      return VerificationGateOutcome.CANCELLED;
    case TestOutcome.INFRASTRUCTURE:
      return VerificationGateOutcome.INFRASTRUCTURE;
  }
}

async function runPortableGate(
  input: VerificationGatePlatformRunInput,
  network: NetworkMode,
): Promise<TestRun> {
  const manifest = testCommandManifest.parse({
    schema_version: 1,
    manifest_id: `verification-${input.definition.gate_id}`,
    digest: verificationGateManifestDigest(input.definition),
    entries: [
      {
        name: input.definition.gate_id,
        phase: testPhaseFor(input.definition),
        executable: input.definition.executable,
        argv: input.definition.argv,
        relative_cwd: input.definition.relative_cwd,
        timeout_ms: input.definition.timeout_ms,
        required: true,
      },
    ],
  });
  const runner = await createTestRunner({
    root: input.disposable_root,
    scope: input.scope,
    manifest,
    store: input.store,
    network,
  });
  return runner.run({
    command_name: input.definition.gate_id,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function assertRecoveredGateBinding(
  recovered: EngineeringControlOperationCompletion,
  expected: {
    descriptor: z.infer<typeof verificationGateDescriptor>;
    operation_id: string;
    job_id: string;
    case_id: string;
    run_id: string;
    stage_attempt: number;
    config_digest: string;
  },
): void {
  const descriptor = verificationGateDescriptor.parse(recovered.descriptor);
  const operation = recovered.operation;
  if (
    canonicalDigest(descriptor) !== operation.input_digest ||
    canonicalDigest(descriptor) !== canonicalDigest(expected.descriptor) ||
    operation.operation_id !== expected.operation_id ||
    operation.job_id !== expected.job_id ||
    operation.case_id !== expected.case_id ||
    operation.run_id !== expected.run_id ||
    operation.stage !== "GATE_EXECUTION" ||
    operation.stage_attempt !== expected.stage_attempt ||
    operation.operation_kind !== "engineering.verification.gate" ||
    operation.effect_class !== "COMMAND" ||
    operation.config_digest !== expected.config_digest ||
    operation.schema_digest !== VERIFICATION_GATE_SCHEMA_DIGEST
  ) {
    throw new VerificationGateContractError("recovered gate operation binding mismatch");
  }
}

function assertDurableGateReceipt(
  receipt: VerificationGateReceipt,
  expected: z.infer<typeof verificationGateDescriptor> & { operation_id: string },
): void {
  if (
    receipt.case_id !== expected.case_id ||
    receipt.workspace_id !== expected.workspace_id ||
    receipt.run_id !== expected.run_id ||
    receipt.operation_id !== expected.operation_id ||
    receipt.gate_id !== expected.gate_id ||
    receipt.target !== expected.target ||
    receipt.tree_digest !== expected.tree_digest ||
    receipt.config_digest !== expected.config_digest ||
    receipt.command_digest !== expected.command_digest
  ) {
    throw new VerificationGateContractError("durable gate receipt binding mismatch");
  }
  const receiptId = receipt.receipt_id;
  const receiptFields: Omit<VerificationGateReceipt, "schema_version" | "receipt_id"> = {
    case_id: receipt.case_id,
    workspace_id: receipt.workspace_id,
    run_id: receipt.run_id,
    operation_id: receipt.operation_id,
    gate_id: receipt.gate_id,
    target: receipt.target,
    tree_digest: receipt.tree_digest,
    config_digest: receipt.config_digest,
    command_digest: receipt.command_digest,
    outcome: receipt.outcome,
    exit_code: receipt.exit_code,
    signal: receipt.signal,
    duration_ms: receipt.duration_ms,
    log_artifact: receipt.log_artifact,
    log_digest: receipt.log_digest,
  };
  if (receiptId !== verificationGateReceiptId(receiptFields)) {
    throw new VerificationGateContractError("durable gate receipt identity mismatch");
  }
}

async function recoverDurableGateReceipt(
  input: VerificationGateExecutionInput,
  control: EngineeringControlPlaneRepository,
  operationId: string,
  expected: z.infer<typeof verificationGateDescriptor> & { operation_id: string },
): Promise<VerificationGateExecutionResult | null> {
  let recovered = await control.readOperationCompletion(input.db, { operationId });
  if (recovered === null) return null;
  const descriptor = verificationGateDescriptor.parse({
    kind: expected.kind,
    case_id: expected.case_id,
    workspace_id: expected.workspace_id,
    run_id: expected.run_id,
    stage_attempt: expected.stage_attempt,
    gate_id: expected.gate_id,
    target: expected.target,
    tree_digest: expected.tree_digest,
    config_digest: expected.config_digest,
    command_digest: expected.command_digest,
  });
  assertRecoveredGateBinding(recovered, {
    descriptor,
    operation_id: operationId,
    job_id: input.lease.jobId,
    case_id: input.case_id,
    run_id: input.run_id,
    stage_attempt: input.stage_attempt,
    config_digest: input.catalog.config_digest,
  });
  if (recovered.completion === null) {
    return recovered.started
      ? { status: "AMBIGUOUS", operation_id: operationId, receipt: null }
      : null;
  }
  if (recovered.completion.outcome !== "SUCCEEDED") {
    throw new VerificationGateContractError("gate observation completion is not SUCCEEDED");
  }
  if (!recovered.completion_observed) {
    await control.observeOperationCompletion(input.db, {
      operationId,
      completionId: recovered.completion.completion_id,
    });
    recovered = await control.readOperationCompletion(input.db, { operationId });
  }
  if (
    recovered === null ||
    recovered.completion === null ||
    recovered.completion.outcome !== "SUCCEEDED" ||
    !recovered.completion_observed
  ) {
    throw new VerificationGateContractError("gate completion observation is not durable");
  }
  const receipt = VerificationGateReceipt.parse(recovered.completion.receipt);
  assertDurableGateReceipt(receipt, expected);
  return {
    status: "RECORDED",
    operation_id: operationId,
    completion_id: recovered.completion.completion_id,
    receipt,
  };
}

/**
 * Execute one catalog gate through the existing process runner and RA-038 ledger.
 * A STARTED operation without a completion is never replayed.
 */
export async function executeVerificationGate(
  input: VerificationGateExecutionInput,
): Promise<VerificationGateExecutionResult> {
  const definition = input.catalog.get(input.gate_id);
  if (
    definition === undefined ||
    (input.target === VerificationGateTarget.BASELINE && !definition.baseline)
  ) {
    throw new VerificationGateContractError("gate/target is outside the server-owned catalog");
  }
  if (!Number.isSafeInteger(input.stage_attempt) || input.stage_attempt <= 0) {
    throw new VerificationGateContractError("stage_attempt must be a positive safe integer");
  }
  const treeDigest = await computeTreeDigest(input.authoritative_root);
  const workspace = await new WorkspaceRepository().find(input.db, input.workspace_id);
  if (workspace === null || workspace.case_id !== input.case_id || workspace.status !== "ACTIVE") {
    throw new VerificationGateContractError("workspace is not an active server-owned case binding");
  }
  if (input.lease.caseId !== input.case_id) {
    throw new VerificationGateContractError("lease belongs to a foreign case");
  }

  const descriptor = verificationGateDescriptor.parse({
    kind: "verification.gate.v1",
    case_id: input.case_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    stage_attempt: input.stage_attempt,
    gate_id: input.gate_id,
    target: input.target,
    tree_digest: treeDigest,
    config_digest: input.catalog.config_digest,
    command_digest: input.catalog.commandDigest(input.gate_id),
  });
  const operationId = verificationGateOperationId(descriptor);
  const expected = { ...descriptor, operation_id: operationId };
  const operationStore = verificationGateOperationStore(input.store, operationId);
  const control =
    input.control_plane ??
    new EngineeringControlPlaneRepository(
      {
        clock: { now: input.now ?? (() => Date.now()) },
        ids: { next: (prefix = "id") => `${prefix}-${randomUUID()}` },
        leaseTime: "db",
      },
      input.jobs,
    );

  const prior = await recoverDurableGateReceipt(input, control, operationId, expected);
  if (prior !== null) return prior;

  const operation = await control.bindOperationIntent(input.db, input.lease, {
    operationId,
    runId: input.run_id,
    stage: "GATE_EXECUTION",
    stageAttempt: input.stage_attempt,
    operationKind: "engineering.verification.gate",
    effectClass: "COMMAND",
    descriptor,
    configDigest: input.catalog.config_digest,
    schemaDigest: VERIFICATION_GATE_SCHEMA_DIGEST,
    deadlineAt: input.deadline_at,
  });

  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  let run: TestRun | null = null;
  let boundaryFailed = false;
  let commitError: unknown;
  const portable =
    definition.environment_profile === "HERMETIC" && definition.network_profile === "DENY";

  if (portable || input.platform_adapter !== undefined) {
    try {
      const disposable = await runInDisposableWorkspace(
        {
          authoritativeRoot: input.authoritative_root,
          mutableOutputs: definition.mutable_outputs,
        },
        async (disposableRoot) => {
          try {
            await control.commitOperationStarted(input.db, input.lease, { operationId });
          } catch (error) {
            commitError = error;
            throw error;
          }
          const candidate = input.platform_adapter
            ? await input.platform_adapter.run({
                definition,
                disposable_root: disposableRoot,
                scope: { case_id: input.case_id, workspace_id: input.workspace_id },
                store: operationStore,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              })
            : await runPortableGate(
                {
                  definition,
                  disposable_root: disposableRoot,
                  scope: { case_id: input.case_id, workspace_id: input.workspace_id },
                  store: operationStore,
                  ...(input.signal === undefined ? {} : { signal: input.signal }),
                },
                "DENY",
              );
          const parsed = VerificationGateValidateTestRun(candidate, definition, {
            case_id: input.case_id,
            workspace_id: input.workspace_id,
            tree_digest: treeDigest,
          });
          run = parsed;
          return run;
        },
      );
      run = disposable.value;
      if (
        disposable.evidence.authoritativeTreeDigestBefore !== treeDigest ||
        disposable.evidence.authoritativeTreeDigestAfter !== treeDigest ||
        disposable.evidence.disposableTreeDigestBefore !== treeDigest
      ) {
        boundaryFailed = true;
      }
    } catch {
      if (commitError !== undefined) throw commitError;
      boundaryFailed = true;
    }
  }

  const logArtifact = run?.artifact ?? null;
  let outcome =
    run === null || boundaryFailed ? VerificationGateOutcome.INFRASTRUCTURE : gateOutcomeFor(run);
  if (outcome === VerificationGateOutcome.PASSED && logArtifact === null) {
    outcome = VerificationGateOutcome.INFRASTRUCTURE;
  }
  const receiptFields: Omit<VerificationGateReceipt, "schema_version" | "receipt_id"> = {
    case_id: input.case_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    operation_id: operationId,
    gate_id: input.gate_id,
    target: input.target,
    tree_digest: treeDigest,
    config_digest: input.catalog.config_digest,
    command_digest: input.catalog.commandDigest(input.gate_id),
    outcome,
    exit_code: run?.exit_code ?? null,
    signal: run?.signal == null ? null : verificationProcessSignal.parse(run.signal),
    duration_ms: run?.duration_ms ?? Math.max(0, now() - startedAt),
    log_artifact: logArtifact,
    log_digest: logArtifact?.digest ?? null,
  };
  const receipt = VerificationGateReceipt.parse({
    schema_version: 1,
    receipt_id: verificationGateReceiptId(receiptFields),
    ...receiptFields,
  });

  try {
    const completionId = await input.jobs.recordCompletion(input.db, {
      intentId: operation.intent_id,
      jobId: operation.job_id,
      outcome: "SUCCEEDED",
      receipt,
      lease: input.lease,
    });
    await control.observeOperationCompletion(input.db, { operationId, completionId });
  } catch {
    const recovered = await recoverDurableGateReceipt(input, control, operationId, expected);
    if (recovered !== null) return recovered;
    return { status: "AMBIGUOUS", operation_id: operationId, receipt: null };
  }

  const durable = await recoverDurableGateReceipt(input, control, operationId, expected);
  if (durable === null) {
    throw new VerificationGateContractError("durable gate completion disappeared");
  }
  return durable;
}

const boundedMetadataText = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, "must not be blank");

/** Strict server-owned metadata accepted by the batch boundary. */
export const VerificationGateBatchMetadata = z
  .object({
    case_id: idString,
    workspace_id: idString,
    run_id: idString,
    revision: z.int().nonnegative(),
    current_tree_digest: sha256Digest,
    diff_digest: sha256Digest,
    context_digest: sha256Digest,
    review_findings: z.array(boundedMetadataText).max(256),
    decisions: z.array(idString).max(256),
  })
  .strict()
  .superRefine((metadata, ctx) => {
    if (new Set(metadata.decisions).size !== metadata.decisions.length) {
      ctx.addIssue({ code: "custom", path: ["decisions"], message: "decision IDs must be unique" });
    }
  });
export type VerificationGateBatchMetadata = z.infer<typeof VerificationGateBatchMetadata>;

export type VerificationGateBatchExecutionInput = Readonly<{
  db: VerificationGateDatabase;
  jobs: JobStore;
  lease: JobLease;
  catalog: VerificationGateCatalog;
  metadata: unknown;
  current_root: string;
  baseline_root?: string;
  stage_attempt: number;
  deadline_at: string;
  store: ArtifactStore;
  signal?: AbortSignal;
  control_plane?: EngineeringControlPlaneRepository;
  platform_adapter?: VerificationGatePlatformAdapter;
  now?: () => number;
}>;

export type VerificationGateBatchExecutionResult =
  | Readonly<{
      status: "COMPLETE";
      aggregate: VerificationGateAggregate;
      bundle: EngineeringEvidenceBundle | null;
    }>
  | Readonly<{
      status: "INCOMPLETE";
      aggregate: null;
      bundle: null;
      reason: "NO_REQUIRED_GATES" | "AMBIGUOUS" | "CANCELLED";
      blocking_gate_ids: readonly string[];
    }>;

type DurableGateExecution = Extract<VerificationGateExecutionResult, { status: "RECORDED" }>;

function verificationGateResultKey(result: DurableGateExecution): string {
  return `${result.receipt.gate_id}:${result.receipt.target}`;
}

function verificationGateBundleItems(
  results: readonly DurableGateExecution[],
): EngineeringEvidenceBundle["items"] {
  return results.flatMap((result) => {
    const receipt = result.receipt;
    const target = receipt.target.toLowerCase();
    const items: EngineeringEvidenceBundle["items"] = [
      {
        kind: "verification-receipt",
        digest: canonicalDigest(receipt),
        summary: `Gate ${receipt.gate_id} ${target} completed as ${receipt.outcome}.`,
        trust: TrustLevel.UNTRUSTED_DATA,
      },
    ];
    if (receipt.log_digest !== null) {
      items.push({
        kind: "verification-log",
        digest: receipt.log_digest,
        summary: `Gate ${receipt.gate_id} ${target} produced a durable redacted log.`,
        trust: TrustLevel.UNTRUSTED_DATA,
      });
    }
    return items;
  });
}

/**
 * Deterministic required-gate policy: catalog order, BASELINE then CURRENT.
 * Durable assertion/infrastructure outcomes continue so the batch is complete;
 * cancellation and an unreceipted AMBIGUOUS operation stop immediately and
 * never dispatch the remaining commands.
 */
export async function executeVerificationGateBatch(
  input: VerificationGateBatchExecutionInput,
): Promise<VerificationGateBatchExecutionResult> {
  const metadata = VerificationGateBatchMetadata.parse(input.metadata);
  if (input.lease.caseId !== metadata.case_id) {
    throw new VerificationGateContractError("batch lease belongs to a foreign case");
  }
  const required = input.catalog.definitions.filter((definition) => definition.required);
  if (required.length === 0) {
    return {
      status: "INCOMPLETE",
      aggregate: null,
      bundle: null,
      reason: "NO_REQUIRED_GATES",
      blocking_gate_ids: [],
    };
  }

  const currentTreeDigest = await computeTreeDigest(input.current_root);
  if (currentTreeDigest !== metadata.current_tree_digest) {
    throw new VerificationGateContractError("batch current tree does not match server metadata");
  }
  const requiresBaseline = required.some((definition) => definition.baseline);
  if (requiresBaseline && input.baseline_root === undefined) {
    throw new VerificationGateContractError("required baseline gates need a baseline root");
  }
  if (!requiresBaseline && input.baseline_root !== undefined) {
    throw new VerificationGateContractError("batch received an unused baseline root");
  }
  let baselineTreeDigest: string | undefined;
  if (input.baseline_root !== undefined) {
    const [currentRoot, baselineRoot] = await Promise.all([
      realpath(input.current_root),
      realpath(input.baseline_root),
    ]);
    if (currentRoot === baselineRoot) {
      throw new VerificationGateContractError("baseline and current roots must be separate");
    }
    baselineTreeDigest = await computeTreeDigest(input.baseline_root);
  }

  const results: DurableGateExecution[] = [];
  for (const definition of required) {
    const targets = [
      ...(definition.baseline
        ? [
            {
              target: VerificationGateTarget.BASELINE,
              root: input.baseline_root!,
            },
          ]
        : []),
      {
        target: VerificationGateTarget.CURRENT,
        root: input.current_root,
      },
    ] as const;
    for (const target of targets) {
      const execution = await executeVerificationGate({
        db: input.db,
        jobs: input.jobs,
        lease: input.lease,
        catalog: input.catalog,
        gate_id: definition.gate_id,
        target: target.target,
        case_id: metadata.case_id,
        workspace_id: metadata.workspace_id,
        run_id: metadata.run_id,
        stage_attempt: input.stage_attempt,
        deadline_at: input.deadline_at,
        authoritative_root: target.root,
        store: input.store,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.control_plane === undefined ? {} : { control_plane: input.control_plane }),
        ...(input.platform_adapter === undefined
          ? {}
          : { platform_adapter: input.platform_adapter }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (execution.status === "AMBIGUOUS") {
        return {
          status: "INCOMPLETE",
          aggregate: null,
          bundle: null,
          reason: "AMBIGUOUS",
          blocking_gate_ids: [definition.gate_id],
        };
      }
      results.push(execution);
      if (execution.receipt.outcome === VerificationGateOutcome.CANCELLED) {
        return {
          status: "INCOMPLETE",
          aggregate: null,
          bundle: null,
          reason: "CANCELLED",
          blocking_gate_ids: [definition.gate_id],
        };
      }
    }
  }

  const completionIds = results.map((result) => result.completion_id);
  if (new Set(completionIds).size !== completionIds.length) {
    throw new VerificationGateContractError("durable completion IDs must be unique");
  }
  const aggregate = VerificationGateDeriveAggregate({
    catalog: input.catalog,
    receipts: results.map((result) => result.receipt),
    case_id: metadata.case_id,
    workspace_id: metadata.workspace_id,
    run_id: metadata.run_id,
    current_tree_digest: currentTreeDigest,
    ...(baselineTreeDigest === undefined ? {} : { baseline_tree_digest: baselineTreeDigest }),
    operation_bindings: results.map((result) => ({
      gate_id: result.receipt.gate_id,
      target: result.receipt.target,
      operation_id: result.operation_id,
    })),
  });
  if (aggregate.status !== VerificationGateStatus.PASSED) {
    return { status: "COMPLETE", aggregate, bundle: null };
  }

  const byKey = new Map(results.map((result) => [verificationGateResultKey(result), result]));
  const testFirstEvidence = required
    .filter((definition) => definition.test_first)
    .map((definition) => {
      const baseline = byKey.get(`${definition.gate_id}:${VerificationGateTarget.BASELINE}`)!;
      const current = byKey.get(`${definition.gate_id}:${VerificationGateTarget.CURRENT}`)!;
      if (
        baseline.receipt.outcome !== VerificationGateOutcome.FAILED ||
        current.receipt.outcome !== VerificationGateOutcome.PASSED
      ) {
        throw new VerificationGateContractError("vacuous test-first evidence cannot enter bundle");
      }
      return {
        gate_id: definition.gate_id,
        baseline_tree_digest: baseline.receipt.tree_digest,
        current_tree_digest: current.receipt.tree_digest,
        baseline_outcome: "FAILED" as const,
        current_outcome: "PASSED" as const,
        receipt_ids: [baseline.completion_id, current.completion_id],
      };
    });
  const bundle = engineeringEvidenceBundle.parse({
    schema_version: 1,
    artifact_kind: "EvidenceBundle",
    case_id: metadata.case_id,
    run_id: metadata.run_id,
    revision: metadata.revision,
    authority: "SERVER_OWNED",
    tree_digest: currentTreeDigest,
    config_digests: [input.catalog.config_digest],
    command_receipts: [...completionIds].sort(),
    diff_digest: metadata.diff_digest,
    review_findings: metadata.review_findings,
    decisions: metadata.decisions,
    items: verificationGateBundleItems(results),
    context_digest: metadata.context_digest,
    test_first_evidence: testFirstEvidence,
  });
  return { status: "COMPLETE", aggregate, bundle };
}
