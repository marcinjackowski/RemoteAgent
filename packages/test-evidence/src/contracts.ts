/**
 * Evidence contracts: `TestRun`, `ArtifactReference` and the verdict.
 *
 * This module is contracts only — no filesystem, database or process access. It
 * is the boundary RA-015 (reviewer), RA-017 (merge requests) and RA-021 (tool
 * broker) will consume, so it is deliberately self-contained.
 *
 * Names are prefixed `evidence*` / `Evidence*`, or are otherwise unique, because
 * `@remoteagent/contracts` and `@remoteagent/implementation-tools` already own
 * generic names. Two `export *` barrels supplying one name do not collide loudly:
 * ESM silently omits the ambiguous name, so a schema would resolve to `undefined`
 * at the import site and "validation" would validate nothing.
 * `test/contracts.test.ts` asserts the intersection stays empty.
 *
 * The load-bearing property is **acceptance criterion 1: a model cannot record a
 * `PASS`.** That is enforced by making the unsafe shape *unrepresentable* rather
 * than by checking it:
 *
 * - a verdict is not a field a caller sets. {@link deriveVerdict} computes it from
 *   the recorded runs, and it is the only way to obtain an
 *   {@link EvidenceVerdict}, whose `derived_from` lists the run digests it was
 *   computed over;
 * - `PASSED` requires every constituent `TestRun` to be `PASSED`. There is no
 *   optional field, no override and no "force" flag anywhere in the surface;
 * - a `TestRun` carries an `outcome` that is itself derived from a real process
 *   result (exit code, signal, timeout) in `./runner.ts`, not chosen;
 * - every run is bound to a workspace and a tree digest, so a receipt cannot be
 *   detached from the state it describes (criterion 2).
 *
 * The second load-bearing property is that **infrastructure failure is not a test
 * regression** (criterion 4). {@link TestOutcome} keeps `FAILED` (the suite ran
 * and asserted false) apart from `TIMED_OUT`, `CANCELED` and `INFRASTRUCTURE`, and
 * `deriveVerdict` maps the latter to `INCONCLUSIVE` rather than to a failure —
 * reporting "the tests failed" when the runner was killed would be a false
 * statement about the code.
 */
import {
  TrustLevel,
  idString,
  relativeRepositoryPath,
  sha256Digest,
  text,
  valueObject,
  versionedContract,
} from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on an excerpt carried inline, in UTF-8 bytes. */
export const MAX_EXCERPT_BYTES = 32_768;

/** Upper bound on the number of runs one verdict may be derived from. */
export const MAX_VERDICT_RUNS = 128;

/**
 * What kind of verification a command performs. Closed set: a manifest cannot
 * invent a phase, because downstream policy (RA-017's merge gate) decides on it.
 */
export const TestPhase = {
  LINT: "LINT",
  TYPECHECK: "TYPECHECK",
  UNIT: "UNIT",
  INTEGRATION: "INTEGRATION",
  BUILD: "BUILD",
  CUSTOM: "CUSTOM",
} as const;

export type TestPhase = (typeof TestPhase)[keyof typeof TestPhase];

export const testPhase = z.enum([
  TestPhase.LINT,
  TestPhase.TYPECHECK,
  TestPhase.UNIT,
  TestPhase.INTEGRATION,
  TestPhase.BUILD,
  TestPhase.CUSTOM,
]);

/**
 * How one verification command ended.
 *
 * The distinction between `FAILED` and the three non-assertion outcomes is
 * criterion 4 and is not cosmetic. `FAILED` is a claim about the code: the suite
 * ran and something asserted false. `TIMED_OUT`, `CANCELED` and `INFRASTRUCTURE`
 * are claims about the *run*, and collapsing them into `FAILED` would attribute a
 * harness problem to the change under test.
 */
export const TestOutcome = {
  /** Exit code 0. The command ran to completion and reported success. */
  PASSED: "PASSED",
  /** Non-zero exit with the process in control of its own exit. A real result. */
  FAILED: "FAILED",
  /** Killed by our own timeout. Says nothing about the assertions. */
  TIMED_OUT: "TIMED_OUT",
  /** Abandoned before or during the run at the caller's request. */
  CANCELED: "CANCELED",
  /**
   * The run could not be performed or was killed by something other than our
   * timeout — a missing executable, a spawn failure, or an external SIGKILL
   * (which is how an out-of-memory kill presents; see `./runner.ts`).
   */
  INFRASTRUCTURE: "INFRASTRUCTURE",
} as const;

export type TestOutcome = (typeof TestOutcome)[keyof typeof TestOutcome];

export const testOutcome = z.enum([
  TestOutcome.PASSED,
  TestOutcome.FAILED,
  TestOutcome.TIMED_OUT,
  TestOutcome.CANCELED,
  TestOutcome.INFRASTRUCTURE,
]);

/** Outcomes that describe the run rather than the code under test. */
const NON_ASSERTION_OUTCOMES: readonly TestOutcome[] = Object.freeze([
  TestOutcome.TIMED_OUT,
  TestOutcome.CANCELED,
  TestOutcome.INFRASTRUCTURE,
]);

/** True when the outcome says nothing about whether the code is correct. */
export function isNonAssertionOutcome(outcome: TestOutcome): boolean {
  return NON_ASSERTION_OUTCOMES.includes(outcome);
}

/**
 * Server-owned identity of the run's subject. Nested so it travels as one unit
 * between manifest, run, artifact and verdict.
 */
export const evidenceScope = valueObject({
  case_id: idString,
  workspace_id: idString,
});

export type EvidenceScope = z.infer<typeof evidenceScope>;

/**
 * A pointer to a stored artifact, plus its integrity digest.
 *
 * `byte_length` is the size of what was STORED and `digest` covers those same
 * bytes, so a consumer can verify integrity without trusting the store. When the
 * stored bytes are a truncated view of a larger stream, `complete` is false and
 * `original_byte_length` records the pre-truncation size — this is what makes
 * criterion 6 checkable: a size limit may shrink the payload but the metadata
 * describing what was dropped survives.
 */
export const artifactReference = valueObject({
  artifact_id: idString,
  scope: evidenceScope,
  /** Store-relative location; never an absolute host path. */
  relative_path: relativeRepositoryPath,
  digest: sha256Digest,
  byte_length: z.int().nonnegative(),
  complete: z.boolean(),
  original_byte_length: z.int().nonnegative(),
}).superRefine((reference, ctx) => {
  if (reference.byte_length > reference.original_byte_length) {
    ctx.addIssue({
      code: "custom",
      message: "stored bytes cannot exceed the original byte length",
      path: ["byte_length"],
    });
  }
  if (reference.complete && reference.byte_length !== reference.original_byte_length) {
    ctx.addIssue({
      code: "custom",
      message: "an artifact with dropped bytes must not be marked complete",
      path: ["complete"],
    });
  }
});

export type ArtifactReference = z.infer<typeof artifactReference>;

/**
 * A bounded, redacted excerpt of a run's output.
 *
 * Pinned to `UNTRUSTED_DATA` by a literal: test output is attacker-influenced
 * (it echoes repository content), and no payload may relabel its own trust. The
 * full stream lives in the artifact, so `artifact` is the reference a reader
 * follows instead of growing this field.
 */
export const evidenceExcerpt = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: text,
  truncated: z.boolean(),
  original_byte_length: z.int().nonnegative(),
}).superRefine((excerpt, ctx) => {
  const carried = new TextEncoder().encode(excerpt.value).length;
  if (carried > MAX_EXCERPT_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `excerpt must not exceed ${String(MAX_EXCERPT_BYTES)} bytes`,
      path: ["value"],
    });
  }
  if (carried > excerpt.original_byte_length) {
    ctx.addIssue({
      code: "custom",
      message: "carried excerpt cannot be larger than the original output",
      path: ["original_byte_length"],
    });
  }
  if (!excerpt.truncated && carried !== excerpt.original_byte_length) {
    ctx.addIssue({
      code: "custom",
      message: "excerpt must be marked truncated when bytes were dropped",
      path: ["truncated"],
    });
  }
});

export type EvidenceExcerpt = z.infer<typeof evidenceExcerpt>;

/**
 * The environment a command observed, as a digest rather than a map.
 *
 * A fingerprint, not the values: the environment can carry credentials, and this
 * record is model-visible and stored. Two runs with the same fingerprint saw the
 * same environment, which is all a reader needs to compare them; the values
 * themselves are never evidence worth leaking.
 */
export const environmentFingerprint = valueObject({
  digest: sha256Digest,
  /** Names only, sorted. Values are deliberately absent. */
  variable_names: z.array(idString).max(64),
});

export type EnvironmentFingerprint = z.infer<typeof environmentFingerprint>;

/**
 * One entry of the versioned command manifest.
 *
 * The manifest is server-owned and derives from the repository profile/plan, so a
 * model names an entry rather than supplying a command line. `argv` is an array,
 * never a shell string, so there is no shell to inject into.
 */
export const testCommandEntry = valueObject({
  name: idString,
  phase: testPhase,
  executable: z.string().min(1),
  argv: z.array(z.string()).max(64),
  /** Workspace-relative working directory. */
  relative_cwd: z.string().max(1024),
  timeout_ms: z.int().positive(),
  /** Whether a non-zero exit blocks the derived verdict. */
  required: z.boolean(),
});

export type TestCommandEntry = z.infer<typeof testCommandEntry>;

export const testCommandManifest = versionedContract({
  manifest_id: idString,
  /** Digest over the manifest's own content, so a run pins the manifest it used. */
  digest: sha256Digest,
  entries: z.array(testCommandEntry).min(1).max(64),
});

export type TestCommandManifest = z.infer<typeof testCommandManifest>;

/**
 * The receipt for one executed verification command.
 *
 * This is the unit of evidence. Everything a reader needs to decide whether to
 * believe it is here and is *observed*, not asserted: which command ran, in which
 * workspace, against which tree digest, what the process did (exit code, signal,
 * duration), and where the full output is stored.
 *
 * `outcome` is derived in `./runner.ts` from the process result. It is in the
 * schema because a receipt must be readable back from storage, but no code path
 * outside the runner constructs one — and `deriveVerdict` re-derives the verdict
 * from these runs rather than trusting any summary.
 */
export const testRun = versionedContract({
  run_id: idString,
  scope: evidenceScope,
  command_name: idString,
  phase: testPhase,
  /** The manifest this command came from, so the run is not free-floating. */
  manifest_digest: sha256Digest,
  outcome: testOutcome,
  /** `null` when the process never ran or was killed by a signal. */
  exit_code: z.int().nullable(),
  /** POSIX signal name, when the process was killed. */
  signal: z.string().max(32).nullable(),
  duration_ms: z.int().nonnegative(),
  /** Criterion 2: the run is bound to the state it describes. */
  tree_digest_before: sha256Digest,
  tree_digest_after: sha256Digest.nullable(),
  environment: environmentFingerprint,
  /** Redacted excerpt for reading inline; the artifact holds the full stream. */
  excerpt: evidenceExcerpt,
  artifact: artifactReference.nullable(),
  /** Digest over the receipt's own identifying fields. Ties a verdict to a run. */
  receipt_digest: sha256Digest,
}).superRefine((run, ctx) => {
  if (run.outcome === TestOutcome.PASSED && run.exit_code !== 0) {
    ctx.addIssue({
      code: "custom",
      message: "a PASSED run must have exit code 0",
      path: ["exit_code"],
    });
  }
  if (run.outcome === TestOutcome.PASSED && run.tree_digest_after === null) {
    ctx.addIssue({
      code: "custom",
      message: "a PASSED run must have an observed post-state",
      path: ["tree_digest_after"],
    });
  }
  if (run.outcome === TestOutcome.FAILED && run.exit_code === 0) {
    ctx.addIssue({
      code: "custom",
      message: "a FAILED run cannot have exit code 0",
      path: ["exit_code"],
    });
  }
});

export type TestRun = z.infer<typeof testRun>;

/**
 * Whether the evidence supports the change.
 *
 * `INCONCLUSIVE` is a first-class peer of `PASSED`/`FAILED` for the same reason
 * `AMBIGUOUS` is in the toolset contracts: when a run timed out or the harness
 * died, neither "the code is fine" nor "the code is broken" is a statement the
 * evidence supports, and forcing a binary answer would manufacture one.
 */
export const EvidenceVerdict = {
  PASSED: "PASSED",
  FAILED: "FAILED",
  INCONCLUSIVE: "INCONCLUSIVE",
} as const;

export type EvidenceVerdict = (typeof EvidenceVerdict)[keyof typeof EvidenceVerdict];

export const evidenceVerdictValue = z.enum([
  EvidenceVerdict.PASSED,
  EvidenceVerdict.FAILED,
  EvidenceVerdict.INCONCLUSIVE,
]);

/**
 * A derived verdict over a set of runs.
 *
 * Deliberately NOT constructible by a caller: {@link deriveVerdict} is the only
 * producer, and `derived_from` records the `receipt_digest` of every run the
 * decision was computed over. A reader can therefore re-derive the verdict from
 * the same receipts and get the same answer — which is what makes the verdict
 * evidence rather than an assertion.
 */
export const evidenceVerdict = versionedContract({
  scope: evidenceScope,
  verdict: evidenceVerdictValue,
  /** `receipt_digest` of each contributing run, sorted. */
  derived_from: z.array(sha256Digest).min(1).max(MAX_VERDICT_RUNS),
  /** Command names whose outcome was not `PASSED`, for a legible summary. */
  blocking: z.array(idString).max(MAX_VERDICT_RUNS),
  tree_digest: sha256Digest,
});

export type EvidenceVerdictRecord = z.infer<typeof evidenceVerdict>;

/**
 * Compute the verdict from recorded runs. The ONLY way to obtain a verdict.
 *
 * Rules, in order, and each fail-closed:
 *
 * 1. no runs -> throws. An empty evidence set is not a `PASSED`; this is the
 *    degenerate case criterion 1 is really about, because "nothing ran" must
 *    never render as "everything is fine";
 * 2. runs must share one scope and one tree digest -> otherwise throws. Mixing
 *    workspaces or states would let a `PASSED` run from one tree vouch for
 *    another;
 * 3. any required run with a non-assertion outcome -> `INCONCLUSIVE`. Checked
 *    BEFORE failure, so a timeout is never reported as a regression;
 * 4. any required run `FAILED` -> `FAILED`;
 * 5. every required run `PASSED` -> `PASSED`.
 *
 * Optional (`required: false`) entries are reported in `blocking` for visibility
 * but do not change the verdict, which is why `required` lives in the
 * server-owned manifest and not in a model-supplied argument.
 */
export function deriveVerdict(
  runs: readonly TestRun[],
  requiredCommands: ReadonlySet<string>,
): EvidenceVerdictRecord {
  if (runs.length === 0) {
    throw new EvidenceContractError("a verdict cannot be derived from zero runs");
  }
  const [first] = runs;
  if (first === undefined) {
    throw new EvidenceContractError("a verdict cannot be derived from zero runs");
  }
  for (const run of runs) {
    if (
      run.scope.case_id !== first.scope.case_id ||
      run.scope.workspace_id !== first.scope.workspace_id
    ) {
      throw new EvidenceContractError("runs in one verdict must share a single scope");
    }
    if (run.tree_digest_before !== first.tree_digest_before) {
      throw new EvidenceContractError("runs in one verdict must share a single tree digest");
    }
  }

  const required = runs.filter((run) => requiredCommands.has(run.command_name));
  if (required.length === 0) {
    throw new EvidenceContractError("a verdict requires at least one required run");
  }

  const blocking = runs
    .filter((run) => run.outcome !== TestOutcome.PASSED)
    .map((run) => run.command_name)
    .sort();

  // Order matters: a non-assertion outcome must win over FAILED, so a killed run
  // is never reported as a regression in the code under test.
  const verdict = required.some((run) => isNonAssertionOutcome(run.outcome))
    ? EvidenceVerdict.INCONCLUSIVE
    : required.some((run) => run.outcome === TestOutcome.FAILED)
      ? EvidenceVerdict.FAILED
      : EvidenceVerdict.PASSED;

  return evidenceVerdict.parse({
    schema_version: 1,
    scope: first.scope,
    verdict,
    derived_from: runs.map((run) => run.receipt_digest).sort(),
    blocking,
    tree_digest: first.tree_digest_before,
  });
}

/** Raised when evidence cannot be interpreted deterministically. */
export class EvidenceContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EvidenceContractError";
  }
}
