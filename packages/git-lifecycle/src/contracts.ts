/**
 * Git lifecycle contracts: branch intent, commit receipt and conflict state.
 *
 * Contracts only — no `child_process`, no filesystem. The consumers are RA-015
 * (reviewer) and RA-017 (merge requests), so this is a standalone boundary.
 *
 * Names are prefixed `git*` / `Git*` or are otherwise unique. Two `export *`
 * barrels supplying one name do not collide loudly: ESM silently omits the
 * ambiguous name, so a schema would resolve to `undefined` at the import site.
 * `test/lifecycle.integration.test.ts` asserts the intersection stays empty
 * against `@remoteagent/contracts` and `@remoteagent/test-evidence`.
 *
 * Two properties are structural rather than conventional.
 *
 * **Criterion 3: a commit is tied to test evidence, or explicitly marked
 * unverified.** {@link gitCommitReceipt} is a discriminated union on
 * `verification`. The verified variant REQUIRES the `receipt_digest` values of the
 * runs that vouch for it plus the derived verdict; the unverified variant REQUIRES
 * an explicit reason. There is no third shape and no optional evidence field, so
 * "committed without evidence" cannot be silently indistinguishable from
 * "committed with evidence" — it has to be stated.
 *
 * **Criterion 5: dirty user changes are never silently overwritten.**
 * {@link GitWorkingTreeState} keeps `DIRTY_FOREIGN` — modifications the agent did
 * not make — apart from `DIRTY_AGENT`. The distinction exists because the safe
 * response differs: the agent's own edits are what it is here to commit, whereas a
 * user's uncommitted work must stop the operation rather than be staged into it.
 */
import {
  canonicalDigest,
  idString,
  sha256Digest,
  valueObject,
  versionedContract,
} from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on paths one commit may stage. */
export const MAX_STAGED_PATHS = 512;

/**
 * A Git branch name the lifecycle layer may create.
 *
 * The pattern is deliberately the SAME as `addWorktree`'s in
 * `@remoteagent/workspace-runner`, not a looser one: two different notions of a
 * valid branch name across two layers is how a name accepted here but rejected
 * below (or worse, the reverse) turns into a half-created branch. `..` is refused
 * explicitly because `a..b` matches the character class yet is a revision range.
 */
export const gitBranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u, "branch name has invalid characters")
  .refine((value) => !value.includes(".."), { message: "branch name must not contain .." })
  .refine((value) => !value.endsWith(".lock") && !value.endsWith("/"), {
    message: "branch name must not end with .lock or /",
  });

export type GitBranchName = z.infer<typeof gitBranchName>;

/**
 * Exact 40-hex object name. Abbreviated SHAs are ambiguous, so they are refused.
 *
 * Named `gitCommitSha`, NOT `gitSha`: `@remoteagent/contracts` already exports a
 * `gitSha` that also accepts 64 hex characters (SHA-256 object format). Two
 * `export *` barrels supplying one name would make ESM drop it silently, and here
 * the two definitions genuinely differ — this layer must reject a 64-hex value
 * because `verifyCommit` in `workspace-runner` requires exactly 40. A collision
 * would therefore not just resolve to `undefined`, it would swap one validation
 * rule for a laxer one. Caught by the export-intersection test, which is why that
 * test exists.
 */
export const gitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/iu, "expected an exact 40-hex Git SHA");

/**
 * Branches that may never be committed to, rebased onto destructively, or
 * force-updated by the agent.
 *
 * Matched case-insensitively against the full branch name. Kept here rather than
 * in the executor so a single list governs every operation, and so a protected
 * name is refused at the contract boundary before any Git process starts.
 */
export const PROTECTED_BRANCHES: readonly string[] = Object.freeze([
  "main",
  "master",
  "develop",
  "development",
  "release",
  "production",
  "staging",
  "trunk",
  "head",
]);

/** True when the branch is protected from agent writes. */
export function isProtectedBranch(branchName: string): boolean {
  const normalized = branchName.trim().toLowerCase();
  return (
    PROTECTED_BRANCHES.includes(normalized) ||
    // `release/1.2` and `production/eu` are release lines too.
    PROTECTED_BRANCHES.some((protectedName) => normalized.startsWith(`${protectedName}/`))
  );
}

/** Server-owned identity of the workspace a Git operation acts on. */
export const gitScope = valueObject({
  case_id: idString,
  workspace_id: idString,
});

export type GitScope = z.infer<typeof gitScope>;

/**
 * State of the working tree, as observed.
 *
 * `DIRTY_FOREIGN` is the criterion-5 state and is deliberately not folded into
 * `DIRTY_AGENT`: the correct response differs. The agent's own modifications are
 * the work product; a change the agent did not make is someone else's uncommitted
 * work, and staging it would destroy authorship or commit something unreviewed.
 */
export const GitWorkingTreeState = {
  /** No modifications at all. */
  CLEAN: "CLEAN",
  /** Only paths the agent declared it would touch are modified. */
  DIRTY_AGENT: "DIRTY_AGENT",
  /** Modifications outside the agent's declared surface. Must stop the operation. */
  DIRTY_FOREIGN: "DIRTY_FOREIGN",
} as const;

export type GitWorkingTreeState = (typeof GitWorkingTreeState)[keyof typeof GitWorkingTreeState];

export const gitWorkingTreeState = z.enum([
  GitWorkingTreeState.CLEAN,
  GitWorkingTreeState.DIRTY_AGENT,
  GitWorkingTreeState.DIRTY_FOREIGN,
]);

/** How a branch came to be, so resume is distinguishable from creation. */
export const GitBranchDisposition = {
  /** The branch did not exist and this call created it. */
  CREATED: "CREATED",
  /** The branch already existed for this case and was resumed. */
  RESUMED: "RESUMED",
} as const;

export type GitBranchDisposition = (typeof GitBranchDisposition)[keyof typeof GitBranchDisposition];

export const gitBranchDisposition = z.enum([
  GitBranchDisposition.CREATED,
  GitBranchDisposition.RESUMED,
]);

/**
 * The recorded identity of a case's branch.
 *
 * `base_sha` is pinned at creation and never re-derived, which is what makes a
 * stale base detectable later: if the remote base moves, the recorded value still
 * says what this work was actually built on.
 */
export const gitBranchRecord = versionedContract({
  scope: gitScope,
  branch_name: gitBranchName,
  base_sha: gitCommitSha,
  head_sha: gitCommitSha,
  disposition: gitBranchDisposition,
  /** Repository identity, so a receipt cannot be read as belonging elsewhere. */
  repository_id: idString,
});

export type GitBranchRecord = z.infer<typeof gitBranchRecord>;

/**
 * Evidence backing a commit, or an explicit statement that there is none.
 *
 * A discriminated union, not an optional field. `VERIFIED` cannot omit its
 * receipts and `UNVERIFIED` cannot omit its reason, so a commit's evidential
 * status is always a positive claim that a reader can check rather than an absence
 * they must notice.
 */
export const gitCommitVerification = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("VERIFIED"),
    /** `receipt_digest` of each `TestRun` that vouches for this commit. */
    run_receipts: z.array(sha256Digest).min(1).max(128),
    /** The verdict those receipts derived. Must be `PASSED` to be VERIFIED. */
    verdict: z.literal("PASSED"),
    /** Tree digest the evidence was gathered against. */
    evidence_tree_digest: sha256Digest,
  }),
  z.strictObject({
    kind: z.literal("UNVERIFIED"),
    /** Why this commit carries no passing evidence. Never blank. */
    reason: z.string().min(8).max(512),
  }),
]);

export type GitCommitVerification = z.infer<typeof gitCommitVerification>;

/**
 * Receipt for one commit created by the agent.
 *
 * Carries what a reviewer needs without re-running Git: which paths were staged,
 * the resulting commit SHA, the parent it was built on, and the evidence (or the
 * declared absence of it).
 */
export const gitCommitReceipt = versionedContract({
  scope: gitScope,
  branch_name: gitBranchName,
  commit_sha: gitCommitSha,
  parent_sha: gitCommitSha,
  /** Workspace-relative paths, sorted. Never absolute host paths. */
  staged_paths: z.array(z.string().max(1024)).max(MAX_STAGED_PATHS),
  files_changed: z.int().nonnegative(),
  insertions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  verification: gitCommitVerification,
});

export type GitCommitReceipt = z.infer<typeof gitCommitReceipt>;

const exactCommitPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") && !path.includes("\\0") && !path.split(/[/\\\\]+/u).includes(".."),
    "path must be workspace-relative",
  );

/** One accepted slice pair, retained in durable execution order. */
export const gitAcceptedEvidenceReview = valueObject({
  slice_id: idString,
  attempt: z.int().positive(),
  evidence_digest: sha256Digest,
  review_digest: sha256Digest,
});

/**
 * Immutable, server-owned input for the one LOCAL_COMMIT side effect.
 *
 * This complete value is persisted in `job_intents.descriptor` before STARTED.
 * Recovery may therefore inspect Git against the same facts without rebuilding
 * intent from mutable process state.
 */
export const gitEvidenceBoundCommitDescriptor = versionedContract({
  operation_id: idString,
  case_id: idString,
  work_unit_id: idString,
  workspace_id: idString,
  repository_id: idString,
  run_id: idString,
  checkpoint_revision: z.int().nonnegative(),
  branch_name: gitBranchName,
  expected_parent_sha: gitCommitSha,
  exact_paths: z.array(exactCommitPath).min(1).max(MAX_STAGED_PATHS),
  message: z.string().min(1).max(4096),
  operation_marker: z.string().min(1).max(512),
  tree_digest: sha256Digest,
  actual_diff_digest: sha256Digest,
  raw_patch_digest: sha256Digest,
  accepted: z.array(gitAcceptedEvidenceReview).min(1).max(128),
  evidence_digest: sha256Digest,
  review_digest: sha256Digest,
  final_verification_digest: sha256Digest,
}).superRefine((descriptor, ctx) => {
  const sorted = [...descriptor.exact_paths].sort();
  if (
    new Set(descriptor.exact_paths).size !== descriptor.exact_paths.length ||
    descriptor.exact_paths.some((path, index) => path !== sorted[index])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["exact_paths"],
      message: "paths must be unique and sorted",
    });
  }
  if (!descriptor.message.includes(descriptor.operation_marker)) {
    ctx.addIssue({
      code: "custom",
      path: ["message"],
      message: "message must contain operation marker",
    });
  }
  const expectedMarker = `[remoteagent-operation:${descriptor.operation_id}]`;
  if (
    descriptor.operation_marker !== expectedMarker ||
    !descriptor.message.endsWith(`\n\n${expectedMarker}`) ||
    descriptor.message !== descriptor.message.trimEnd()
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["operation_marker"],
      message: "operation marker and canonical message trailer must match operation_id",
    });
  }
  if (
    new Set(descriptor.accepted.map((pair) => `${pair.slice_id}\0${String(pair.attempt)}`)).size !==
    descriptor.accepted.length
  ) {
    ctx.addIssue({ code: "custom", path: ["accepted"], message: "accepted pairs must be unique" });
  }
  if (
    descriptor.evidence_digest !==
      canonicalDigest(descriptor.accepted.map((pair) => pair.evidence_digest)) ||
    descriptor.review_digest !==
      canonicalDigest(descriptor.accepted.map((pair) => pair.review_digest))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["accepted"],
      message: "accepted evidence and review rollups must match their ordered pairs",
    });
  }
});

export type GitEvidenceBoundCommitDescriptor = z.infer<typeof gitEvidenceBoundCommitDescriptor>;

/**
 * Outcome of a controlled rebase.
 *
 * **Criterion 4: a conflict is never auto-resolved.** `CONFLICTED` carries the
 * conflicting paths and is terminal for this layer — there is no `resolved`
 * variant and no strategy option anywhere in the surface, so the only way past a
 * conflict is a new decision made outside it. The rebase is also aborted before
 * this is returned, so the working tree is left in a known state rather than
 * mid-rebase.
 */
export const GitRebaseOutcome = {
  /** Already up to date with the target; nothing was replayed. */
  UP_TO_DATE: "UP_TO_DATE",
  /** Replayed cleanly onto the new base. */
  REBASED: "REBASED",
  /** Conflicts found. Aborted, not resolved. Requires a durable decision. */
  CONFLICTED: "CONFLICTED",
  /** Refused before starting: dirty foreign changes, protected target, stale state. */
  REFUSED: "REFUSED",
} as const;

export type GitRebaseOutcome = (typeof GitRebaseOutcome)[keyof typeof GitRebaseOutcome];

export const gitRebaseOutcome = z.enum([
  GitRebaseOutcome.UP_TO_DATE,
  GitRebaseOutcome.REBASED,
  GitRebaseOutcome.CONFLICTED,
  GitRebaseOutcome.REFUSED,
]);

export const gitRebaseReport = versionedContract({
  scope: gitScope,
  branch_name: gitBranchName,
  outcome: gitRebaseOutcome,
  /** Base before the attempt. */
  previous_base_sha: gitCommitSha,
  /** Base after a successful replay; equals `previous_base_sha` when not rebased. */
  new_base_sha: gitCommitSha,
  head_sha: gitCommitSha.nullable(),
  /** Conflicting workspace-relative paths; empty unless `CONFLICTED`. */
  conflicting_paths: z.array(z.string().max(1024)).max(MAX_STAGED_PATHS),
  /** Stable code when `REFUSED`; `null` otherwise. */
  refusal_code: idString.nullable(),
}).superRefine((report, ctx) => {
  if (report.outcome === GitRebaseOutcome.CONFLICTED && report.conflicting_paths.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "a CONFLICTED rebase must name the conflicting paths",
      path: ["conflicting_paths"],
    });
  }
  if (report.outcome !== GitRebaseOutcome.CONFLICTED && report.conflicting_paths.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: "only a CONFLICTED rebase may carry conflicting paths",
      path: ["conflicting_paths"],
    });
  }
  if (report.outcome === GitRebaseOutcome.REFUSED && report.refusal_code === null) {
    ctx.addIssue({
      code: "custom",
      message: "a REFUSED rebase must carry a refusal code",
      path: ["refusal_code"],
    });
  }
});

export type GitRebaseReport = z.infer<typeof gitRebaseReport>;

/** Raised when a Git lifecycle request cannot be honoured safely. */
export class GitLifecycleError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "GitLifecycleError";
    this.code = code;
  }
}
