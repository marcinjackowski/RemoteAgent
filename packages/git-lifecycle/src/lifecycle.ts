/**
 * The Git lifecycle: branch, status, diff, stage, commit and controlled rebase.
 *
 * Every Git invocation goes through {@link git}, a single `execFile` call with an
 * argument ARRAY and no shell. That is not a style choice: with a shell, a branch
 * name or a path containing `;` or `$(...)` would be executable, and both come from
 * a model. There is no code path in this module that builds a command string.
 *
 * ## What is refused, and where
 *
 * Enforcement happens at the only place it can be honest — the argument vector.
 * {@link assertPermitted} inspects the actual argv of every call, so a forbidden
 * operation cannot be spawned even by a future method that forgets to check.
 * Putting the check on the public methods would leave every private helper as a
 * bypass. Criterion 6's negative tests target this function directly.
 *
 * It is an ALLOWLIST, and that reversal was forced by evidence: an audit probe
 * defeated the original denylist six ways, including `git -C /elsewhere push` and
 * `git -c core.hooksPath=... commit`. See {@link PERMITTED_SUBCOMMANDS}.
 *
 * ## Criterion 1: resume never creates a second branch
 *
 * `addWorktree` in `@remoteagent/workspace-runner` runs `worktree add -b`, which
 * FAILS when the branch already exists. So the resume path cannot be "call it
 * again": {@link GitLifecycle.ensureBranch} first asks the mirror whether the
 * branch exists, and returns `RESUMED` with the recorded base if it does. The
 * branch is looked up by its deterministic name, which is derived from the case, so
 * two calls for one case cannot produce two branches even under a race — the second
 * observes the first's branch.
 *
 * ## Criterion 5: dirty foreign changes stop the operation
 *
 * {@link GitLifecycle.status} classifies the tree against the paths the caller
 * declared it would touch. Anything modified outside that surface is
 * `DIRTY_FOREIGN`, and every mutating operation refuses in that state. The
 * alternative — staging whatever is present — is precisely the silent overwrite the
 * criterion forbids.
 *
 * ## Criterion 4: a conflict is aborted, never resolved
 *
 * {@link GitLifecycle.rebase} takes no strategy and has no resolution path. On
 * conflict it collects the conflicting paths, runs `rebase --abort` so the tree is
 * left in a known state rather than mid-rebase, and reports `CONFLICTED`. Deciding
 * what to do next is outside this layer by construction.
 *
 * ## Bounded output
 *
 * `runGit` in `workspace-runner` uses `maxBuffer: 1024 * 1024`, and exceeding it
 * throws `ENOBUFS` rather than returning a truncated result — so a large `git diff`
 * would crash instead of reporting. This module therefore sets its own, larger
 * buffer and converts an overflow into an explicit truncation flag. A diff that is
 * too large is a legible fact, not a stack trace.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { canonicalDigest } from "@remoteagent/contracts";

import {
  GitBranchDisposition,
  GitLifecycleError,
  GitRebaseOutcome,
  GitWorkingTreeState,
  gitBranchName,
  gitBranchRecord,
  gitCommitReceipt,
  gitCommitSha,
  gitRebaseReport,
  isProtectedBranch,
} from "./contracts.js";
import type {
  GitBranchRecord,
  GitCommitReceipt,
  GitCommitVerification,
  GitRebaseReport,
  GitScope,
  GitWorkingTreeState as WorkingTreeState,
} from "./contracts.js";

const execFileAsync = promisify(execFile);

/** Output ceiling for one Git invocation. Overflow becomes an explicit flag. */
export const MAX_GIT_OUTPUT_BYTES = 8_388_608;

/** A forbidden Git operation was requested. */
export const GIT_OPERATION_FORBIDDEN = "OPERATION_FORBIDDEN";

/** The working tree carries changes the agent did not make. */
export const GIT_DIRTY_FOREIGN = "DIRTY_FOREIGN_CHANGES";

/** The branch is protected from agent writes. */
export const GIT_BRANCH_PROTECTED = "BRANCH_PROTECTED";

/** A path left the workspace or the declared staging surface. */
export const GIT_PATH_OUT_OF_SCOPE = "PATH_OUT_OF_SCOPE";

/** Nothing was staged, so there is nothing to commit. */
export const GIT_NOTHING_STAGED = "NOTHING_STAGED";

/** The underlying Git process failed. Only the code travels, never the message. */
export const GIT_COMMAND_FAILED = "GIT_COMMAND_FAILED";

/**
 * The ONLY subcommands this module may run.
 *
 * An allowlist, not a denylist — and that reversal is the whole point. An
 * adversarial audit probe defeated the original denylist six different ways:
 * `git -C /elsewhere push` (a global option carrying a value, so the subcommand
 * scanner picked up the wrong token), `git -c alias.p=push p` (an alias defined on
 * the command line), `git -c core.hooksPath=... commit` (arbitrary code via a hook
 * path), and `stash drop`, `update-ref -d` and `branch -D`, none of which were on
 * the list at all. A denylist has to anticipate every destructive verb Git will
 * ever have; an allowlist only has to name the nine this module actually uses.
 */
const PERMITTED_SUBCOMMANDS: readonly string[] = Object.freeze([
  "status",
  "diff",
  "add",
  "commit",
  "rebase",
  "checkout",
  "rev-parse",
  "merge-base",
  "branch",
]);

/**
 * Global options accepted before the subcommand.
 *
 * Deliberately tiny and deliberately excluding every option that can redirect the
 * repository (`-C`, `--git-dir`, `--work-tree`) or inject configuration (`-c`,
 * `--config-env`, `--exec-path`). `--git-dir` used to be allowed here and was how
 * the branch-existence check addressed the mirror; that call now passes the mirror
 * as `cwd` instead, so no caller needs a repository-redirecting flag.
 */
const PERMITTED_GLOBAL_OPTIONS: readonly string[] = Object.freeze(["--literal-pathspecs"]);

/** Flags that are refused wherever they appear. */
const FORBIDDEN_FLAGS: readonly string[] = Object.freeze([
  "--force",
  "-f",
  "-D",
  "--force-with-lease",
  "--hard",
  "--keep",
  "--merge",
  "--force-if-includes",
  "--exec-path",
]);

/**
 * Refuse anything that is not explicitly permitted.
 *
 * Enforced on argv inside the single `execFile` choke point rather than on the
 * public API, so no helper — present or future — can bypass it.
 *
 * Fail-closed in three layers: the subcommand must be on the allowlist, every
 * token before it must be a permitted global option, and no forbidden flag may
 * appear anywhere. `-f` and `-D` are refused outright rather than per-subcommand:
 * an allowlist of "safe" uses would be a standing invitation to widen, and nothing
 * here needs either.
 */
export function assertPermitted(args: readonly string[]): void {
  if (args.length === 0) {
    throw new GitLifecycleError(GIT_OPERATION_FORBIDDEN, "empty git invocation");
  }

  // Walk the leading global options explicitly instead of filtering flags out.
  // Filtering was the original bug: it discarded `-C` but kept its VALUE, so the
  // value was mistaken for the subcommand and the real subcommand went unchecked.
  let index = 0;
  while (index < args.length && (args[index] ?? "").startsWith("-")) {
    const option = args[index] ?? "";
    if (!PERMITTED_GLOBAL_OPTIONS.includes(option)) {
      throw new GitLifecycleError(GIT_OPERATION_FORBIDDEN, `forbidden global option: ${option}`);
    }
    index += 1;
  }

  const subcommand = args[index] ?? "";
  if (!PERMITTED_SUBCOMMANDS.includes(subcommand)) {
    throw new GitLifecycleError(GIT_OPERATION_FORBIDDEN, `subcommand not permitted: ${subcommand}`);
  }
  for (const flag of args) {
    if (FORBIDDEN_FLAGS.includes(flag)) {
      throw new GitLifecycleError(GIT_OPERATION_FORBIDDEN, `forbidden flag: ${flag}`);
    }
  }

  // `branch` is permitted only to LIST or create, never to delete or move. `-D` is
  // already refused above; `-d`, `-m` and `-M` are refused here.
  if (
    subcommand === "branch" &&
    args.some((arg) => arg === "-d" || arg === "--delete" || arg === "-m" || arg === "-M")
  ) {
    throw new GitLifecycleError(GIT_OPERATION_FORBIDDEN, "branch deletion or rename is forbidden");
  }
  // A `checkout` that names no explicit pathspec rewrites the whole tree. `-b`
  // creates a branch and is the one exception, since it touches no existing file.
  if (subcommand === "checkout" && !args.includes("--") && !args.includes("-b")) {
    throw new GitLifecycleError(GIT_OPERATION_FORBIDDEN, "checkout requires an explicit pathspec");
  }
}

type GitResult = Readonly<{ stdout: string; truncated: boolean }>;

/**
 * Run one Git command. The single choke point for every invocation.
 *
 * Argument array, never a shell. Output is bounded and an overflow is reported as
 * `truncated` rather than thrown, because a huge diff is an expected condition.
 */
async function git(args: readonly string[], cwd?: string): Promise<GitResult> {
  assertPermitted(args);
  try {
    const result = await execFileAsync("git", [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      // A deterministic, minimal environment: no user config, no pager, no prompts.
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: cwd ?? "/nonexistent",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "RemoteAgent",
        GIT_AUTHOR_EMAIL: "agent@remoteagent.invalid",
        GIT_COMMITTER_NAME: "RemoteAgent",
        GIT_COMMITTER_EMAIL: "agent@remoteagent.invalid",
        LANG: "C",
        TZ: "UTC",
      },
    });
    return { stdout: result.stdout, truncated: false };
  } catch (error) {
    if (error instanceof GitLifecycleError) throw error;
    const code: unknown = Reflect.get(error as object, "code");
    if (code === "ENOBUFS") {
      // Expected for a large diff. Report the bound rather than crashing.
      return { stdout: "", truncated: true };
    }
    // Git messages embed absolute host paths, so only the stable code travels.
    throw new GitLifecycleError(GIT_COMMAND_FAILED);
  }
}

/** Parse `--porcelain=v1 -z` status output into (code, path) pairs. */
function parseStatus(stdout: string): readonly { code: string; path: string }[] {
  const entries: { code: string; path: string }[] = [];
  // NUL-delimited so a path containing a newline or a quote cannot split a record.
  const records = stdout.split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    entries.push({ code, path });
    // A rename record is followed by its origin path as a separate NUL field.
    if (code.startsWith("R") || code.startsWith("C")) index += 1;
  }
  return entries;
}

export type GitLifecycleOptions = Readonly<{
  /** Absolute worktree path for this case. */
  worktreePath: string;
  /** Absolute path of the bare mirror backing the worktree. */
  mirrorPath: string;
  scope: GitScope;
  repositoryId: string;
  /**
   * Workspace-relative paths the agent declared it would modify. Anything modified
   * outside this surface is `DIRTY_FOREIGN` and stops mutating operations.
   */
  declaredPaths?: readonly string[];
}>;

export type GitStatusReport = Readonly<{
  state: WorkingTreeState;
  /** Modified paths inside the declared surface. */
  agentPaths: readonly string[];
  /** Modified paths outside it. Non-empty means DIRTY_FOREIGN. */
  foreignPaths: readonly string[];
  headSha: string;
}>;

export type GitDiffReport = Readonly<{
  /** Unified diff text; empty when truncated. */
  patch: string;
  truncated: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
}>;

/**
 * Git lifecycle operations for one case workspace.
 *
 * Constructed with the workspace and the declared write surface, both server-owned.
 * No method takes a repository path, a branch to force, or a rebase strategy.
 */
export class GitLifecycle {
  readonly #worktree: string;
  readonly #mirror: string;
  readonly #scope: GitScope;
  readonly #repositoryId: string;
  readonly #declared: readonly string[];

  public constructor(options: GitLifecycleOptions) {
    this.#worktree = options.worktreePath;
    this.#mirror = options.mirrorPath;
    this.#scope = options.scope;
    this.#repositoryId = options.repositoryId;
    this.#declared = [...(options.declaredPaths ?? [])];
  }

  /**
   * The deterministic branch name for this case.
   *
   * Derived from the case id and a slug, so it is the same on every call — which is
   * what makes resume work by lookup rather than by bookkeeping. A short digest of
   * the case id disambiguates two cases whose slugs collide without making the name
   * unreadable.
   */
  public branchNameFor(slug: string): string {
    const safeSlug = slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48);
    const suffix = canonicalDigest(this.#scope.case_id).slice(7, 15);
    const candidate = `agent/${safeSlug.length > 0 ? safeSlug : "task"}-${suffix}`;
    // Validated against the SAME pattern the worktree layer uses, so a name that
    // passes here cannot be rejected one layer down.
    return gitBranchName.parse(candidate);
  }

  /** Whether the branch already exists in the mirror. */
  async #branchExists(branchName: string): Promise<boolean> {
    try {
      // The mirror is addressed as `cwd`, NOT with `--git-dir`. That flag can
      // redirect any command at another repository, so it is no longer a permitted
      // global option; passing the path as the working directory achieves the same
      // lookup without giving the guard an exception to carve out.
      await git(["rev-parse", "--verify", `refs/heads/${branchName}`], this.#mirror);
      return true;
    } catch {
      return false;
    }
  }

  async #revParse(rev: string): Promise<string> {
    const result = await git(["rev-parse", rev], this.#worktree);
    return gitCommitSha.parse(result.stdout.trim());
  }

  /**
   * Create the case branch, or resume the existing one.
   *
   * Criterion 1. The existence check comes first and short-circuits, so no second
   * branch is created for a case that already has one — including after a crash,
   * because the answer is read from Git rather than from remembered state.
   */
  public async ensureBranch(slug: string, baseSha: string): Promise<GitBranchRecord> {
    const branchName = this.branchNameFor(slug);
    if (isProtectedBranch(branchName)) {
      throw new GitLifecycleError(GIT_BRANCH_PROTECTED, "refusing to write a protected branch");
    }
    gitCommitSha.parse(baseSha);

    const exists = await this.#branchExists(branchName);
    if (exists) {
      // Resume. The recorded base is the branch's merge-base with its base commit,
      // NOT the current remote tip: re-deriving it would silently re-point the work
      // at a newer base and hide a stale-base condition.
      const head = await this.#revParse("HEAD");
      const mergeBase = await git(["merge-base", branchName, baseSha], this.#worktree).catch(
        () => ({ stdout: baseSha, truncated: false }),
      );
      return gitBranchRecord.parse({
        schema_version: 1,
        scope: this.#scope,
        branch_name: branchName,
        base_sha: gitCommitSha.parse(mergeBase.stdout.trim() || baseSha),
        head_sha: head,
        disposition: GitBranchDisposition.RESUMED,
        repository_id: this.#repositoryId,
      });
    }

    await git(["checkout", "-b", branchName, baseSha, "--"], this.#worktree);
    const head = await this.#revParse("HEAD");
    return gitBranchRecord.parse({
      schema_version: 1,
      scope: this.#scope,
      branch_name: branchName,
      base_sha: baseSha.toLowerCase(),
      head_sha: head,
      disposition: GitBranchDisposition.CREATED,
      repository_id: this.#repositoryId,
    });
  }

  /**
   * Classify the working tree against the declared write surface.
   *
   * Criterion 5. A modification outside the declared paths is foreign, and the
   * caller is told which paths they are so the condition is actionable rather than
   * a bare refusal.
   */
  public async status(): Promise<GitStatusReport> {
    const result = await git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      this.#worktree,
    );
    const entries = parseStatus(result.stdout);
    const declared = new Set(this.#declared);
    const agentPaths: string[] = [];
    const foreignPaths: string[] = [];
    for (const entry of entries) {
      if (declared.has(entry.path)) agentPaths.push(entry.path);
      else foreignPaths.push(entry.path);
    }
    return Object.freeze({
      state:
        entries.length === 0
          ? GitWorkingTreeState.CLEAN
          : foreignPaths.length > 0
            ? GitWorkingTreeState.DIRTY_FOREIGN
            : GitWorkingTreeState.DIRTY_AGENT,
      agentPaths: Object.freeze(agentPaths.sort()),
      foreignPaths: Object.freeze(foreignPaths.sort()),
      headSha: await this.#revParse("HEAD"),
    });
  }

  /** Bounded diff of the working tree, with an explicit truncation flag. */
  public async diff(): Promise<GitDiffReport> {
    const patch = await git(["diff", "--no-color", "HEAD"], this.#worktree);
    const stat = await git(["diff", "--numstat", "-z", "HEAD"], this.#worktree);

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const record of stat.stdout.split("\0")) {
      const parts = record.split("\t");
      if (parts.length < 3) continue;
      filesChanged += 1;
      insertions += Number.parseInt(parts[0] ?? "0", 10) || 0;
      deletions += Number.parseInt(parts[1] ?? "0", 10) || 0;
    }

    return Object.freeze({
      patch: patch.truncated ? "" : patch.stdout,
      truncated: patch.truncated,
      filesChanged,
      insertions,
      deletions,
    });
  }

  /**
   * Stage exactly the given workspace-relative paths.
   *
   * Criterion 2. Each path is refused if it is absolute, escapes the workspace, or
   * is not in the declared surface. `--` terminates option parsing so a path
   * beginning with `-` cannot become a flag, and pathspecs are passed literally so
   * a glob cannot widen the set.
   */
  public async stage(paths: readonly string[]): Promise<readonly string[]> {
    if (paths.length === 0) return [];
    const declared = new Set(this.#declared);
    const staged: string[] = [];
    for (const path of paths) {
      if (
        path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\0") ||
        path.split(/[/\\]+/u).includes("..")
      ) {
        throw new GitLifecycleError(GIT_PATH_OUT_OF_SCOPE, "path is not workspace-relative");
      }
      // Fail CLOSED on an empty surface. This read `declared.size > 0 && ...`,
      // which meant a lifecycle constructed without `declaredPaths` would stage
      // anything asked of it — found by an audit probe that staged `secret.env`.
      // An absent declaration is not permission to touch everything; it means
      // nothing was declared, so nothing may be staged.
      if (!declared.has(path)) {
        throw new GitLifecycleError(GIT_PATH_OUT_OF_SCOPE, "path is outside the declared surface");
      }
      staged.push(path);
    }
    // `--literal-pathspecs` so a magic pathspec (`:(glob)`, `:/`) cannot widen this.
    await git(["--literal-pathspecs", "add", "--", ...staged], this.#worktree);
    return Object.freeze([...staged].sort());
  }

  /**
   * Commit the staged paths with explicit evidence or an explicit lack of it.
   *
   * Criterion 3 is carried by the `verification` argument, whose type admits no
   * third shape. Criterion 5 is enforced here as well as in `status`: a foreign
   * modification refuses the commit rather than sweeping it in.
   */
  public async commit(input: {
    readonly message: string;
    readonly paths: readonly string[];
    readonly verification: GitCommitVerification;
  }): Promise<GitCommitReceipt> {
    const before = await this.status();
    if (before.state === GitWorkingTreeState.DIRTY_FOREIGN) {
      throw new GitLifecycleError(
        GIT_DIRTY_FOREIGN,
        "refusing to commit over changes the agent did not make",
      );
    }

    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], this.#worktree)).stdout.trim();
    if (isProtectedBranch(branch)) {
      throw new GitLifecycleError(GIT_BRANCH_PROTECTED, "refusing to commit to a protected branch");
    }

    const staged = await this.stage(input.paths);
    const cached = await git(["diff", "--cached", "--numstat", "-z"], this.#worktree);
    if (cached.stdout.trim().length === 0) {
      throw new GitLifecycleError(GIT_NOTHING_STAGED, "nothing was staged");
    }

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const record of cached.stdout.split("\0")) {
      const parts = record.split("\t");
      if (parts.length < 3) continue;
      filesChanged += 1;
      insertions += Number.parseInt(parts[0] ?? "0", 10) || 0;
      deletions += Number.parseInt(parts[1] ?? "0", 10) || 0;
    }

    const parent = await this.#revParse("HEAD");
    // The message is passed as an argument, never interpolated into a shell.
    await git(["commit", "--no-verify", "--no-gpg-sign", "-m", input.message], this.#worktree);
    const commitSha = await this.#revParse("HEAD");

    return gitCommitReceipt.parse({
      schema_version: 1,
      scope: this.#scope,
      branch_name: branch,
      commit_sha: commitSha,
      parent_sha: parent,
      staged_paths: staged,
      files_changed: filesChanged,
      insertions,
      deletions,
      verification: input.verification,
    });
  }

  /**
   * Rebase the case branch onto a new base, aborting on conflict.
   *
   * Criterion 4. No strategy argument exists, so there is no way to ask for
   * automatic resolution. On conflict the paths are collected and the rebase is
   * ABORTED, leaving a known tree instead of a half-applied one, and the caller is
   * handed a terminal `CONFLICTED` report to turn into a durable decision.
   */
  public async rebase(newBaseSha: string): Promise<GitRebaseReport> {
    gitCommitSha.parse(newBaseSha);
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], this.#worktree)).stdout.trim();
    const previousBase = await this.#revParse("HEAD");

    const status = await this.status();
    if (status.state === GitWorkingTreeState.DIRTY_FOREIGN) {
      // Rebasing over someone else's uncommitted work is the data-loss case.
      return gitRebaseReport.parse({
        schema_version: 1,
        scope: this.#scope,
        branch_name: branch,
        outcome: GitRebaseOutcome.REFUSED,
        previous_base_sha: previousBase,
        new_base_sha: previousBase,
        head_sha: status.headSha,
        conflicting_paths: [],
        refusal_code: GIT_DIRTY_FOREIGN,
      });
    }

    const isAncestor = await git(
      ["merge-base", "--is-ancestor", newBaseSha, "HEAD"],
      this.#worktree,
    )
      .then(() => true)
      .catch(() => false);
    if (isAncestor) {
      return gitRebaseReport.parse({
        schema_version: 1,
        scope: this.#scope,
        branch_name: branch,
        outcome: GitRebaseOutcome.UP_TO_DATE,
        previous_base_sha: previousBase,
        new_base_sha: previousBase,
        head_sha: status.headSha,
        conflicting_paths: [],
        refusal_code: null,
      });
    }

    try {
      await git(["rebase", newBaseSha], this.#worktree);
    } catch {
      // Collect the conflicts, then ABORT. No resolution is attempted here.
      const conflicts = await git(["diff", "--name-only", "--diff-filter=U", "-z"], this.#worktree)
        .then((result) => result.stdout.split("\0").filter((path) => path.length > 0))
        .catch(() => []);
      await git(["rebase", "--abort"], this.#worktree).catch(() => undefined);
      return gitRebaseReport.parse({
        schema_version: 1,
        scope: this.#scope,
        branch_name: branch,
        outcome: GitRebaseOutcome.CONFLICTED,
        previous_base_sha: previousBase,
        new_base_sha: previousBase,
        head_sha: await this.#revParse("HEAD").catch(() => null),
        // A conflict that named no paths would be unreportable; fall back to a
        // sentinel so the contract's own refinement cannot be defeated by an
        // empty list.
        conflicting_paths: conflicts.length > 0 ? conflicts.sort() : ["<unknown>"],
        refusal_code: null,
      });
    }

    return gitRebaseReport.parse({
      schema_version: 1,
      scope: this.#scope,
      branch_name: branch,
      outcome: GitRebaseOutcome.REBASED,
      previous_base_sha: previousBase,
      new_base_sha: newBaseSha.toLowerCase(),
      head_sha: await this.#revParse("HEAD"),
      conflicting_paths: [],
      refusal_code: null,
    });
  }
}
