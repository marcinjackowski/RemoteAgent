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
  testRunReceiptDigest,
  testEvidence,
} from "./contracts.js";
import type { TestRun } from "./contracts.js";
import { runInDisposableWorkspace } from "./disposable-workspace.js";
import { createTestRunner } from "./runner.js";
import {
  TRUSTED_EVALUATOR_UI_LAYOUT,
  validateTrustedEvaluatorInputs,
} from "./trusted-evaluator-inputs.js";

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

export const VerificationGateTier = {
  FAST: "FAST",
  FULL: "FULL",
} as const;

const verificationGateTier = z.enum(VerificationGateTier);

export const VerificationGateSchedule = {
  FIRST_SLICE: "FIRST_SLICE",
  EACH_SLICE: "EACH_SLICE",
  LAST_SLICE: "LAST_SLICE",
} as const;

const verificationGateSchedule = z.enum(VerificationGateSchedule);

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

const implementationContextEntry = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("READ"), relative_path: relativeRepositoryPath }),
  z.strictObject({
    kind: z.literal("SEARCH"),
    relative_path: relativeRepositoryPath,
    query: z.string().min(1).max(512),
  }),
]);
const trustedEvaluatorInputsSchema = z
  .object({
    files: z.array(
      z
        .object({ relative_path: z.string(), content: z.string(), content_digest: z.string() })
        .strict(),
    ),
    required_executed_test_ids: z.array(z.string()),
    layout: z.literal(TRUSTED_EVALUATOR_UI_LAYOUT).optional(),
  })
  .strict()
  .transform((value) => {
    const snapshot = validateTrustedEvaluatorInputs(value);
    return {
      files: snapshot.files.map(({ relative_path, content, content_digest }) => ({
        relative_path,
        content,
        content_digest,
      })),
      required_executed_test_ids: [...snapshot.required_executed_test_ids],
      ...(snapshot.layout === undefined ? {} : { layout: snapshot.layout }),
    };
  });

const verificationGateDefinitionSchema = versionedContract({
  gate_id: idString,
  gate_class: verificationGateClass,
  gate_tier: verificationGateTier.default(VerificationGateTier.FULL),
  gate_schedule: verificationGateSchedule.default(VerificationGateSchedule.EACH_SLICE),
  /** Lower values execute first within one tier; the id remains the deterministic tie-breaker. */
  execution_order: z.int().nonnegative().max(10_000).default(1_000),
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
  /** Exact test files that must be writable on every slice where this gate is scheduled. */
  required_test_paths: z.array(relativeRepositoryPath).max(16).default([]),
  /** Exact implementation files a matching gate diagnostic may require a correction to mutate. */
  required_mutation_paths: z.array(relativeRepositoryPath).max(16).default([]),
  implementation_guidance: z.string().min(1).max(4096).optional(),
  implementation_context: z.array(implementationContextEntry).min(1).max(24).optional(),
  trusted_evaluator_inputs: trustedEvaluatorInputsSchema.optional(),
}).superRefine((definition, ctx) => {
  if (definition.trusted_evaluator_inputs !== undefined) {
    try {
      validateTrustedEvaluatorInputs(definition.trusted_evaluator_inputs);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["trusted_evaluator_inputs"],
        message: error instanceof Error ? error.message : "invalid trusted evaluator inputs",
      });
    }
    if (
      definition.gate_class !== VerificationGateClass.TEST ||
      definition.environment_profile !== "BUILD_TOOLCHAIN" ||
      definition.network_profile !== "PLATFORM_MANAGED"
    )
      ctx.addIssue({
        code: "custom",
        path: ["trusted_evaluator_inputs"],
        message: "trusted evaluator inputs require a platform-managed Xcode TEST gate",
      });
    const selectors = definition.argv.filter((arg) => arg.startsWith("-only-testing:"));
    const required = new Set(definition.trusted_evaluator_inputs.required_executed_test_ids);
    const normalized = new Set(
      selectors.map((arg) => arg.slice("-only-testing:".length).replace(/\(\)$/u, "")),
    );
    for (const id of required)
      if (!normalized.has(id))
        ctx.addIssue({
          code: "custom",
          path: ["trusted_evaluator_inputs"],
          message: "every evaluator test ID must have an exact testing selector",
        });
    for (const file of definition.trusted_evaluator_inputs.files) {
      const conflicts = [
        ...definition.mutable_outputs,
        ...definition.required_mutation_paths,
        ...definition.required_test_paths,
      ].some(
        (candidate) =>
          candidate === file.relative_path ||
          candidate.startsWith(`${file.relative_path}/`) ||
          file.relative_path.startsWith(`${candidate}/`),
      );
      if (conflicts)
        ctx.addIssue({
          code: "custom",
          path: ["trusted_evaluator_inputs"],
          message: "evaluator inputs must not intersect mutable or required mutation/test paths",
        });
    }
    if (definition.trusted_evaluator_inputs.layout === TRUSTED_EVALUATOR_UI_LAYOUT) {
      const projectFile = definition.trusted_evaluator_inputs.files.find((file) =>
        file.relative_path.endsWith("RemoteAgentUIHarness.xcodeproj/project.pbxproj"),
      );
      const projectRoot = projectFile?.relative_path.slice(
        0,
        -"RemoteAgentUIHarness.xcodeproj/project.pbxproj".length,
      );
      const expectedProject =
        projectRoot === undefined
          ? undefined
          : path.posix.relative(
              definition.relative_cwd,
              `${projectRoot}RemoteAgentUIHarness.xcodeproj`,
            );
      const projectFlags = definition.argv.filter((arg) => arg === "-project");
      const schemeFlags = definition.argv.filter((arg) => arg === "-scheme");
      const workspaceFlags = definition.argv.filter(
        (arg) => arg === "-workspace" || arg.startsWith("-workspace="),
      );
      const projectIndex = definition.argv.indexOf("-project");
      const schemeIndex = definition.argv.indexOf("-scheme");
      const projectArgument = projectIndex >= 0 ? definition.argv[projectIndex + 1] : undefined;
      const schemeArgument = schemeIndex >= 0 ? definition.argv[schemeIndex + 1] : undefined;
      if (
        projectFlags.length !== 1 ||
        schemeFlags.length !== 1 ||
        workspaceFlags.length !== 0 ||
        definition.argv.some((arg) => arg.startsWith("-project=") || arg.startsWith("-scheme=")) ||
        projectArgument !== expectedProject ||
        projectArgument === undefined ||
        path.isAbsolute(projectArgument) ||
        projectArgument.split("/").includes("..") ||
        schemeArgument !== "RemoteAgentUIHarness"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["argv"],
          message:
            "XCODE_UI_HARNESS_V1 requires exact injected project and RemoteAgentUIHarness scheme binding",
        });
      }
    }
  }
  if (
    definition.environment_profile === "HERMETIC" &&
    definition.argv.some((argument) => {
      if (path.isAbsolute(argument)) return true;
      const assignment = argument.indexOf("=");
      return assignment >= 0 && path.isAbsolute(argument.slice(assignment + 1));
    })
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["argv"],
      message:
        "hermetic gate arguments cannot reference absolute host paths; use workspace-relative or digest-bound inline input",
    });
  }
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
  if (new Set(definition.required_test_paths).size !== definition.required_test_paths.length) {
    ctx.addIssue({
      code: "custom",
      path: ["required_test_paths"],
      message: "required test paths must be unique",
    });
  }
  if (
    new Set(definition.required_mutation_paths).size !== definition.required_mutation_paths.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["required_mutation_paths"],
      message: "required mutation paths must be unique",
    });
  }
  if (definition.implementation_context !== undefined) {
    const identities = definition.implementation_context.map((entry) =>
      entry.kind === "READ"
        ? `READ:${entry.relative_path}`
        : `SEARCH:${entry.relative_path}:${entry.query}`,
    );
    if (new Set(identities).size !== identities.length) {
      ctx.addIssue({
        code: "custom",
        path: ["implementation_context"],
        message: "implementation context entries must be unique",
      });
    }
  }
});

/** Strict, versioned, code-owned definition of one executable gate. */
export const VerificationGateDefinition = verificationGateDefinitionSchema;
export type VerificationGateDefinition = z.infer<typeof VerificationGateDefinition>;

export type EngineeringGateOwnershipTarget = Readonly<{
  target_id: string;
  kind: "SOURCE" | "TEST" | "GENERATOR";
  paths: readonly string[];
}>;
export type EngineeringGateOwnershipSlice = Readonly<{
  slice_id: string;
  mutation_target_ids: readonly string[];
  required_read_context: readonly { relative_path: string; must_exist: boolean }[];
}>;
export type EngineeringGateOwnershipCriterion = Readonly<{
  criterion_id: string;
  owning_slice_id: string;
  required_gate_ids: readonly string[];
  related_target_ids: readonly string[];
}>;
export const EngineeringGateOwnershipViolationCode = Object.freeze({
  DUPLICATE_TARGET: "DUPLICATE_TARGET",
  DUPLICATE_SLICE: "DUPLICATE_SLICE",
  DUPLICATE_CRITERION: "DUPLICATE_CRITERION",
  FOREIGN_TARGET: "FOREIGN_TARGET",
  FOREIGN_SLICE: "FOREIGN_SLICE",
  MISSING_GATE: "MISSING_GATE",
  CRITERION_TARGET_OUTSIDE_SLICE: "CRITERION_TARGET_OUTSIDE_SLICE",
  FOREIGN_MUTATION_PATH: "FOREIGN_MUTATION_PATH",
  FOREIGN_TEST_PATH: "FOREIGN_TEST_PATH",
  READ_CONTEXT_ABSENT: "READ_CONTEXT_ABSENT",
  READ_CONTEXT_NOT_REQUIRED: "READ_CONTEXT_NOT_REQUIRED",
  UNCOVERED_SLICE: "UNCOVERED_SLICE",
} as const);
export type EngineeringGateOwnershipViolationCode =
  (typeof EngineeringGateOwnershipViolationCode)[keyof typeof EngineeringGateOwnershipViolationCode];
export type EngineeringGateOwnershipViolation = Readonly<{
  code: EngineeringGateOwnershipViolationCode;
  id: string;
}>;
export class EngineeringGateOwnershipError extends Error {
  readonly violations: readonly EngineeringGateOwnershipViolation[];
  readonly truncated: boolean;
  constructor(violations: readonly EngineeringGateOwnershipViolation[], truncated = false) {
    super("engineering gate ownership validation failed");
    this.name = "EngineeringGateOwnershipError";
    this.violations = Object.freeze(violations.map((violation) => Object.freeze({ ...violation })));
    this.truncated = truncated;
  }
}
export type EngineeringGateOwnershipResult = Readonly<{
  criterion_ids: readonly string[];
  gate_ids: readonly string[];
  target_ids: readonly string[];
}>;
const covered = (allowed: readonly string[], candidate: string) =>
  allowed.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
export function validateEngineeringGateOwnership(input: {
  catalog: Pick<VerificationGateCatalog, "get">;
  targets: readonly EngineeringGateOwnershipTarget[];
  slices: readonly EngineeringGateOwnershipSlice[];
  criteria: readonly EngineeringGateOwnershipCriterion[];
}): EngineeringGateOwnershipResult {
  const violations: EngineeringGateOwnershipViolation[] = [];
  let truncated = false;
  const targetMap = new Map(input.targets.map((target) => [target.target_id, target]));
  const sliceMap = new Map(input.slices.map((slice) => [slice.slice_id, slice]));
  const add = (code: EngineeringGateOwnershipViolationCode, id: string) => {
    if (violations.length < 256) violations.push({ code, id });
    else truncated = true;
  };
  const targetCounts = new Map<string, number>();
  for (const target of input.targets)
    targetCounts.set(target.target_id, (targetCounts.get(target.target_id) ?? 0) + 1);
  for (const [id, count] of targetCounts) if (count > 1) add("DUPLICATE_TARGET", id);
  const sliceCounts = new Map<string, number>();
  for (const slice of input.slices)
    sliceCounts.set(slice.slice_id, (sliceCounts.get(slice.slice_id) ?? 0) + 1);
  for (const [id, count] of sliceCounts) if (count > 1) add("DUPLICATE_SLICE", id);
  const criterionCounts = new Map<string, number>();
  for (const criterion of input.criteria)
    criterionCounts.set(
      criterion.criterion_id,
      (criterionCounts.get(criterion.criterion_id) ?? 0) + 1,
    );
  for (const [id, count] of criterionCounts) if (count > 1) add("DUPLICATE_CRITERION", id);
  for (const slice of input.slices)
    for (const targetId of slice.mutation_target_ids)
      if (!targetMap.has(targetId)) add("FOREIGN_TARGET", targetId);
  for (const criterion of input.criteria) {
    const slice = sliceMap.get(criterion.owning_slice_id);
    for (const targetId of criterion.related_target_ids)
      if (!targetMap.has(targetId)) add("FOREIGN_TARGET", targetId);
    if (slice === undefined) {
      add("FOREIGN_SLICE", criterion.criterion_id);
      for (const gateId of criterion.required_gate_ids)
        if (input.catalog.get(gateId) === undefined)
          add("MISSING_GATE", `${criterion.criterion_id}:${gateId}`);
      continue;
    }
    for (const targetId of criterion.related_target_ids)
      if (!slice.mutation_target_ids.includes(targetId))
        add("CRITERION_TARGET_OUTSIDE_SLICE", `${criterion.criterion_id}:${targetId}`);
    for (const gateId of criterion.required_gate_ids) {
      const gate = input.catalog.get(gateId);
      if (gate === undefined) {
        add("MISSING_GATE", `${criterion.criterion_id}:${gateId}`);
        continue;
      }
      const source = slice.mutation_target_ids.flatMap((id) => {
        const t = targetMap.get(id);
        return t?.kind === "SOURCE" || t?.kind === "GENERATOR" ? t.paths : [];
      });
      const tests = slice.mutation_target_ids.flatMap((id) =>
        targetMap.get(id)?.kind === "TEST" ? targetMap.get(id)!.paths : [],
      );
      for (const evaluator of gate.trusted_evaluator_inputs?.files ?? []) {
        const overlaps = input.targets.some((target) =>
          target.paths.some(
            (candidate) =>
              candidate === evaluator.relative_path ||
              candidate.startsWith(`${evaluator.relative_path}/`) ||
              evaluator.relative_path.startsWith(`${candidate}/`),
          ),
        );
        if (overlaps) add("FOREIGN_MUTATION_PATH", `${gateId}:${evaluator.relative_path}`);
      }
      for (const path of gate.required_mutation_paths)
        if (!covered(source, path)) add("FOREIGN_MUTATION_PATH", `${gateId}:${path}`);
      for (const path of gate.required_test_paths)
        if (!covered(tests, path)) add("FOREIGN_TEST_PATH", `${gateId}:${path}`);
      for (const context of gate.implementation_context ?? []) {
        const declared = slice.required_read_context.find(
          (entry) => entry.relative_path === context.relative_path,
        );
        if (declared === undefined) {
          add("READ_CONTEXT_ABSENT", `${gateId}:${context.relative_path}`);
        } else if (!declared.must_exist) {
          const plannedOutput = slice.mutation_target_ids.some((targetId) => {
            const target = targetMap.get(targetId);
            return (
              target !== undefined &&
              (target.kind === "SOURCE" || target.kind === "TEST" || target.kind === "GENERATOR") &&
              covered(target.paths, context.relative_path)
            );
          });
          if (!plannedOutput)
            add("READ_CONTEXT_NOT_REQUIRED", `${gateId}:${context.relative_path}`);
        }
      }
    }
  }
  for (const slice of input.slices)
    if (!input.criteria.some((criterion) => criterion.owning_slice_id === slice.slice_id))
      add("UNCOVERED_SLICE", slice.slice_id);
  if (violations.length > 0)
    throw new EngineeringGateOwnershipError(
      violations.sort((a, b) => {
        const left = `${a.code}:${a.id}`;
        const right = `${b.code}:${b.id}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
      truncated,
    );
  return Object.freeze({
    criterion_ids: Object.freeze(
      [...new Set(input.criteria.map((criterion) => criterion.criterion_id))].sort(),
    ),
    gate_ids: Object.freeze(
      [...new Set(input.criteria.flatMap((criterion) => criterion.required_gate_ids))].sort(),
    ),
    target_ids: Object.freeze(
      [...new Set(input.criteria.flatMap((criterion) => criterion.related_target_ids))].sort(),
    ),
  });
}

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
  test_evidence: testEvidence.optional(),
  trusted_evaluator_binding: z
    .strictObject({ evaluator_inputs_digest: sha256Digest, evaluated_tree_digest: sha256Digest })
    .optional(),
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
  if (
    receipt.test_evidence !== undefined &&
    receipt.outcome === VerificationGateOutcome.PASSED &&
    receipt.test_evidence.failed_test_ids.length > 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["test_evidence", "failed_test_ids"],
      message: "PASSED cannot contain failed tests",
    });
  }
  if (
    receipt.test_evidence !== undefined &&
    receipt.outcome === VerificationGateOutcome.FAILED &&
    receipt.test_evidence.failed_test_ids.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["test_evidence", "failed_test_ids"],
      message: "FAILED must contain a failed test",
    });
  }
});

export function assertTrustedEvaluatorReceiptEvidence(
  definition: VerificationGateDefinition,
  receipt: Pick<VerificationGateReceipt, "outcome" | "test_evidence" | "trusted_evaluator_binding">,
): void {
  const inputs = definition.trusted_evaluator_inputs;
  if (inputs === undefined) {
    if (receipt.trusted_evaluator_binding !== undefined)
      throw new VerificationGateContractError("legacy gate cannot carry evaluator binding");
    return;
  }
  const snapshot = validateTrustedEvaluatorInputs(inputs);
  const binding = receipt.trusted_evaluator_binding;
  const assertionOutcome =
    receipt.outcome === VerificationGateOutcome.PASSED ||
    receipt.outcome === VerificationGateOutcome.FAILED;
  if (binding === undefined && !assertionOutcome) {
    if (receipt.test_evidence !== undefined)
      throw new VerificationGateContractError("unbound evaluator evidence cannot be retained");
    return;
  }
  if (
    binding === undefined ||
    binding.evaluator_inputs_digest !== snapshot.digest ||
    !sha256Digest.safeParse(binding.evaluated_tree_digest).success
  )
    throw new VerificationGateContractError("trusted evaluator binding mismatch");
  if (receipt.outcome !== VerificationGateOutcome.PASSED && receipt.test_evidence === undefined)
    return;
  if (receipt.test_evidence === undefined)
    throw new VerificationGateContractError("trusted evaluator evidence is missing");
  const suites = new Map<string, string>();
  for (const suite of receipt.test_evidence.expected_suite_ids) {
    const parts = suite.split("/");
    if (parts.length !== 2 || suites.has(parts[1]!))
      throw new VerificationGateContractError("trusted evaluator suite mapping is ambiguous");
    suites.set(parts[1]!, suite);
  }
  const observed = new Set<string>();
  for (const raw of receipt.test_evidence.executed_test_ids) {
    const parts = raw.replace(/\(\)$/u, "").split("/");
    if (parts.length !== 2 && parts.length !== 3)
      throw new VerificationGateContractError("trusted evaluator test identity is malformed");
    const suite = parts.length === 2 ? suites.get(parts[0]!) : suites.get(parts[1]!);
    if (suite === undefined || (parts.length === 3 && suite !== `${parts[0]}/${parts[1]}`))
      throw new VerificationGateContractError("trusted evaluator test target cannot map");
    observed.add(`${suite}/${parts.at(-1)!}`);
  }
  for (const required of snapshot.required_executed_test_ids)
    if (!observed.has(required))
      throw new VerificationGateContractError("trusted evaluator required test is missing");
}

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
    required_test_paths: [...definition.required_test_paths],
    required_mutation_paths: [...definition.required_mutation_paths],
    ...(definition.trusted_evaluator_inputs === undefined
      ? {}
      : {
          trusted_evaluator_inputs: {
            files: definition.trusted_evaluator_inputs.files.map((file) => ({ ...file })),
            required_executed_test_ids: [
              ...definition.trusted_evaluator_inputs.required_executed_test_ids,
            ],
            ...(definition.trusted_evaluator_inputs.layout === undefined
              ? {}
              : { layout: definition.trusted_evaluator_inputs.layout }),
          },
        }),
  };
  Object.freeze(snapshot.argv);
  Object.freeze(snapshot.mutable_outputs);
  Object.freeze(snapshot.required_test_paths);
  Object.freeze(snapshot.required_mutation_paths);
  if (snapshot.trusted_evaluator_inputs !== undefined) {
    snapshot.trusted_evaluator_inputs.files.forEach((file) => Object.freeze(file));
    Object.freeze(snapshot.trusted_evaluator_inputs.files);
    Object.freeze(snapshot.trusted_evaluator_inputs.required_executed_test_ids);
    Object.freeze(snapshot.trusted_evaluator_inputs);
  }
  return Object.freeze(snapshot);
}

function verificationGateCommandDigest(definition: VerificationGateDefinition): string {
  return canonicalDigest({
    gate_tier: definition.gate_tier,
    gate_schedule: definition.gate_schedule,
    executable: definition.executable,
    argv: definition.argv,
    relative_cwd: definition.relative_cwd,
    timeout_ms: definition.timeout_ms,
    environment_profile: definition.environment_profile,
    network_profile: definition.network_profile,
    mutable_outputs: definition.mutable_outputs,
    ...(definition.trusted_evaluator_inputs === undefined
      ? {}
      : {
          evaluator_inputs_digest: validateTrustedEvaluatorInputs(
            definition.trusted_evaluator_inputs,
          ).digest,
        }),
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

    definitions.sort((left, right) => {
      if (left.gate_tier !== right.gate_tier) {
        return left.gate_tier === VerificationGateTier.FAST ? -1 : 1;
      }
      if (left.execution_order !== right.execution_order) {
        return left.execution_order - right.execution_order;
      }
      return left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0;
    });
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
    assertTrustedEvaluatorReceiptEvidence(definition, receipt);
    if (definition.trusted_evaluator_inputs !== undefined) {
      const { schema_version: _version, receipt_id: identity, ...fields } = receipt;
      void _version;
      if (identity !== verificationGateReceiptId(fields))
        throw new VerificationGateContractError("evaluator aggregate receipt identity mismatch");
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

export const VERIFICATION_GATE_SCHEMA_DIGEST = canonicalDigest({
  contract: "VerificationGateReceipt",
  schema_version: 1,
});

export const verificationGateDescriptor = z
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

export type VerificationGateBoundaryError = Readonly<{
  gate_id: string;
  target: z.infer<typeof verificationGateTarget>;
  phase: "GATE_RUN" | "RECEIPT_VALIDATION" | "DISPOSABLE_WORKSPACE" | "DISPOSABLE_EVIDENCE";
  error: unknown;
}>;

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
  /** Dedicated cross-fence observation repair; it cannot create or dispatch a gate operation. */
  recovery_observe_completion?: (input: {
    operationId: string;
    completionId: string;
  }) => Promise<void>;
  /** Receipt-only mode: absence of a durable operation is AMBIGUOUS, never permission to execute. */
  recovery_only?: boolean;
  platform_adapter?: VerificationGatePlatformAdapter;
  boundary_error_observer?: (input: VerificationGateBoundaryError) => void;
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

export function verificationGateOperationId(
  input: z.infer<typeof verificationGateDescriptor>,
): string {
  return `verification-gate-${canonicalDigest(input).slice("sha256:".length)}`;
}

export function verificationGateReceiptId(
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

export function verificationGateTestPhase(definition: VerificationGateDefinition): TestPhase {
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

export function verificationGateManifestDigest(definition: VerificationGateDefinition): string {
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
    run.phase !== verificationGateTestPhase(definition) ||
    run.manifest_digest !== verificationGateManifestDigest(definition) ||
    run.tree_digest_before !== expected.tree_digest
  ) {
    throw new VerificationGateContractError("platform run binding mismatch");
  }
  const expectedReceiptDigest = testRunReceiptDigest(run);
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
        phase: verificationGateTestPhase(input.definition),
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
    test_evidence: receipt.test_evidence,
    ...(receipt.trusted_evaluator_binding === undefined
      ? {}
      : { trusted_evaluator_binding: receipt.trusted_evaluator_binding }),
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
    if (input.recovery_observe_completion !== undefined) {
      await input.recovery_observe_completion({
        operationId,
        completionId: recovered.completion.completion_id,
      });
    } else {
      await control.observeOperationCompletion(input.db, input.lease, {
        operationId,
        completionId: recovered.completion.completion_id,
      });
    }
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
  const definition = input.catalog.get(receipt.gate_id);
  if (definition === undefined)
    throw new VerificationGateContractError("recovered gate is foreign");
  assertTrustedEvaluatorReceiptEvidence(definition, receipt);
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
  if (input.recovery_only === true) {
    return { status: "AMBIGUOUS", operation_id: operationId, receipt: null };
  }
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
  let evaluatedTreeDigest: string | undefined;
  let evaluatorInputsDigest: string | undefined;
  let boundaryFailed = false;
  let boundaryErrorObserved = false;
  let commitError: unknown;
  const portable =
    definition.environment_profile === "HERMETIC" && definition.network_profile === "DENY";
  const observeBoundaryError = (
    phase: VerificationGateBoundaryError["phase"],
    error: unknown,
  ): void => {
    boundaryErrorObserved = true;
    try {
      input.boundary_error_observer?.({
        gate_id: definition.gate_id,
        target: input.target,
        phase,
        error,
      });
    } catch {
      // Diagnostics can never widen or change the gate result.
    }
  };

  if (portable || input.platform_adapter !== undefined) {
    try {
      const disposable = await runInDisposableWorkspace(
        {
          authoritativeRoot: input.authoritative_root,
          mutableOutputs: definition.mutable_outputs,
          ...(definition.trusted_evaluator_inputs === undefined
            ? {}
            : { trustedEvaluatorInputs: definition.trusted_evaluator_inputs }),
        },
        async (disposableRoot, context) => {
          if (context.authoritativeTreeDigest !== treeDigest)
            throw new VerificationGateContractError("disposable source context mismatch");
          evaluatedTreeDigest = context.disposableTreeDigest;
          evaluatorInputsDigest = context.evaluatorInputsDigest;
          try {
            await control.commitOperationStarted(input.db, input.lease, { operationId });
          } catch (error) {
            commitError = error;
            throw error;
          }
          let candidate: TestRun;
          try {
            candidate = portable
              ? await runPortableGate(
                  {
                    definition,
                    disposable_root: disposableRoot,
                    scope: { case_id: input.case_id, workspace_id: input.workspace_id },
                    store: operationStore,
                    ...(input.signal === undefined ? {} : { signal: input.signal }),
                  },
                  "DENY",
                )
              : await input.platform_adapter!.run({
                  definition,
                  disposable_root: disposableRoot,
                  scope: { case_id: input.case_id, workspace_id: input.workspace_id },
                  store: operationStore,
                  ...(input.signal === undefined ? {} : { signal: input.signal }),
                });
          } catch (error) {
            observeBoundaryError("GATE_RUN", error);
            throw error;
          }
          let parsed: TestRun;
          try {
            parsed = VerificationGateValidateTestRun(candidate, definition, {
              case_id: input.case_id,
              workspace_id: input.workspace_id,
              tree_digest: context.disposableTreeDigest,
            });
          } catch (error) {
            observeBoundaryError("RECEIPT_VALIDATION", error);
            throw error;
          }
          run = parsed;
          return run;
        },
      );
      run = disposable.value;
      if (definition.trusted_evaluator_inputs !== undefined) {
        const expectedInputDigest = validateTrustedEvaluatorInputs(
          definition.trusted_evaluator_inputs,
        ).digest;
        if (
          disposable.evidence.evaluatorInputsDigest !== expectedInputDigest ||
          evaluatorInputsDigest !== expectedInputDigest ||
          evaluatedTreeDigest !== disposable.evidence.disposableTreeDigestBefore
        ) {
          boundaryFailed = true;
          observeBoundaryError(
            "DISPOSABLE_EVIDENCE",
            new VerificationGateContractError(
              "trusted evaluator binding or selected tests mismatch",
            ),
          );
        }
        if (!boundaryFailed)
          assertTrustedEvaluatorReceiptEvidence(definition, {
            outcome: gateOutcomeFor(run),
            test_evidence: run.test_evidence,
            trusted_evaluator_binding: {
              evaluator_inputs_digest: expectedInputDigest,
              evaluated_tree_digest: disposable.evidence.disposableTreeDigestBefore,
            },
          });
      }
      if (
        disposable.evidence.authoritativeTreeDigestBefore !== treeDigest ||
        disposable.evidence.authoritativeTreeDigestAfter !== treeDigest ||
        (definition.trusted_evaluator_inputs === undefined
          ? disposable.evidence.disposableTreeDigestBefore !== treeDigest
          : disposable.evidence.evaluatorInputsDigest === undefined)
      ) {
        boundaryFailed = true;
        observeBoundaryError(
          "DISPOSABLE_EVIDENCE",
          new VerificationGateContractError("disposable workspace evidence mismatch"),
        );
      }
    } catch (error) {
      if (commitError !== undefined) throw commitError;
      if (!boundaryErrorObserved) observeBoundaryError("DISPOSABLE_WORKSPACE", error);
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
    test_evidence:
      definition.trusted_evaluator_inputs !== undefined && boundaryFailed
        ? undefined
        : run?.test_evidence,
    ...(boundaryFailed || definition.trusted_evaluator_inputs === undefined
      ? {}
      : evaluatorInputsDigest === undefined || evaluatedTreeDigest === undefined
        ? {}
        : {
            trusted_evaluator_binding: {
              evaluator_inputs_digest: evaluatorInputsDigest,
              evaluated_tree_digest: evaluatedTreeDigest,
            },
          }),
  };
  const receipt = VerificationGateReceipt.parse({
    schema_version: 1,
    receipt_id: verificationGateReceiptId(receiptFields),
    ...receiptFields,
  });
  assertTrustedEvaluatorReceiptEvidence(definition, receipt);

  try {
    const completionId = await input.jobs.recordCompletion(input.db, {
      intentId: operation.intent_id,
      jobId: operation.job_id,
      outcome: "SUCCEEDED",
      receipt,
      lease: input.lease,
    });
    await control.observeOperationCompletion(input.db, input.lease, {
      operationId,
      completionId,
    });
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
  boundary_error_observer?: VerificationGateExecutionInput["boundary_error_observer"];
  recovery_observe_completion?: VerificationGateExecutionInput["recovery_observe_completion"];
  recovery_only?: boolean;
  now?: () => number;
}>;

export type VerificationGateBatchExecutionResult =
  | Readonly<{
      status: "COMPLETE";
      aggregate: VerificationGateAggregate;
      bundle: EngineeringEvidenceBundle | null;
      receipts: readonly VerificationGateReceipt[];
    }>
  | Readonly<{
      status: "INCOMPLETE";
      aggregate: null;
      bundle: null;
      reason: "NO_REQUIRED_GATES" | "AMBIGUOUS" | "CANCELLED" | "FAST_GATE_BLOCKED_FULL";
      blocking_gate_ids: readonly string[];
      receipts: readonly VerificationGateReceipt[];
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

function fastGatePassed(
  definition: VerificationGateDefinition,
  results: readonly DurableGateExecution[],
): boolean {
  const current = results.find(
    (result) => result.receipt.target === VerificationGateTarget.CURRENT,
  );
  if (current?.receipt.outcome !== VerificationGateOutcome.PASSED) return false;
  const baseline = results.find(
    (result) => result.receipt.target === VerificationGateTarget.BASELINE,
  );
  if (definition.test_first) {
    return baseline?.receipt.outcome === VerificationGateOutcome.FAILED;
  }
  return baseline === undefined || baseline.receipt.outcome === VerificationGateOutcome.PASSED;
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
      receipts: [],
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
    const gateResults: DurableGateExecution[] = [];
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
        ...(input.boundary_error_observer === undefined
          ? {}
          : { boundary_error_observer: input.boundary_error_observer }),
        ...(input.recovery_observe_completion === undefined
          ? {}
          : { recovery_observe_completion: input.recovery_observe_completion }),
        ...(input.recovery_only === undefined ? {} : { recovery_only: input.recovery_only }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (execution.status === "AMBIGUOUS") {
        return {
          status: "INCOMPLETE",
          aggregate: null,
          bundle: null,
          reason: "AMBIGUOUS",
          blocking_gate_ids: [definition.gate_id],
          receipts: results.map((result) => result.receipt),
        };
      }
      results.push(execution);
      gateResults.push(execution);
      if (execution.receipt.outcome === VerificationGateOutcome.CANCELLED) {
        return {
          status: "INCOMPLETE",
          aggregate: null,
          bundle: null,
          reason:
            definition.gate_tier === VerificationGateTier.FAST
              ? "FAST_GATE_BLOCKED_FULL"
              : "CANCELLED",
          blocking_gate_ids: [definition.gate_id],
          receipts: results.map((result) => result.receipt),
        };
      }
    }
    if (
      definition.gate_tier === VerificationGateTier.FAST &&
      !fastGatePassed(definition, gateResults)
    ) {
      return {
        status: "INCOMPLETE",
        aggregate: null,
        bundle: null,
        reason: "FAST_GATE_BLOCKED_FULL",
        blocking_gate_ids: [definition.gate_id],
        receipts: results.map((result) => result.receipt),
      };
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
    return {
      status: "COMPLETE",
      aggregate,
      bundle: null,
      receipts: results.map((result) => result.receipt),
    };
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
  return {
    status: "COMPLETE",
    aggregate,
    bundle,
    receipts: results.map((result) => result.receipt),
  };
}
