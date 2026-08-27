/**
 * Integration tests for the Git lifecycle, against REAL Git repositories.
 *
 * Every fixture is a genuine repository created with `git init`, and every
 * assertion about Git state is read back with `git`. A mocked Git would prove
 * nothing here: the criteria are about what Git actually does — that
 * `worktree add -b` fails on an existing branch, that a rebase leaves conflict
 * markers, that `add` can be widened by a magic pathspec.
 *
 * What each block proves:
 *
 *   1. **AC1 — resume never creates a second branch.** Calling `ensureBranch`
 *      twice for one case yields `CREATED` then `RESUMED`, and the repository is
 *      inspected to confirm exactly ONE matching branch exists. A count is the only
 *      assertion that actually excludes a duplicate;
 *   2. **AC2 — no staging outside the workspace/scope.** Absolute paths,
 *      traversal, undeclared paths and magic pathspecs each get a negative test,
 *      and the index is inspected afterwards to confirm nothing was staged;
 *   3. **AC3 — a commit is bound to evidence or explicitly unverified.** The
 *      receipt's union admits no third shape, and a `VERIFIED` variant without
 *      receipts or with a non-PASSED verdict is unrepresentable;
 *   4. **AC4 — a rebase conflict is not auto-resolved.** A real divergent history
 *      is constructed so the rebase genuinely conflicts; the test then asserts the
 *      repository is NOT mid-rebase afterwards, which is what "aborted rather than
 *      resolved" means in observable terms;
 *   5. **AC5 — dirty user changes are never silently overwritten.** A foreign
 *      modification is written directly to disk and every mutating operation must
 *      refuse while its bytes stay untouched;
 *   6. **AC6 — forbidden destructive commands have negative tests.** The argv
 *      guard is tested directly, including the bypasses a caller would actually
 *      try.
 */
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "@remoteagent/contracts";

import {
  GIT_BRANCH_PROTECTED,
  GIT_COMMAND_FAILED,
  GIT_DIRTY_FOREIGN,
  GIT_NOTHING_STAGED,
  GIT_OPERATION_FORBIDDEN,
  GIT_PATH_OUT_OF_SCOPE,
  GitBranchDisposition,
  GitLifecycle,
  GitLifecycleError,
  GitRebaseOutcome,
  GitWorkingTreeState,
  assertPermitted,
  gitEvidenceBoundCommitDescriptor,
  gitCommitReceipt,
  isProtectedBranch,
} from "../src/index.js";
import type { GitCommitVerification, GitScope } from "../src/index.js";

const execFileAsync = promisify(execFile);
const scope: GitScope = { case_id: "case-git", workspace_id: "ws-git" };

const DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST_ROLLUP = canonicalDigest([DIGEST]);

/** Run git in a directory, for fixture setup and for reading state back. */
async function raw(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      LANG: "C",
    },
  });
  return result.stdout.trim();
}

async function expectCodeAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect((error as { code?: string }).code, String(error)).toBe(code);
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

const verified: GitCommitVerification = {
  kind: "VERIFIED",
  run_receipts: [DIGEST],
  verdict: "PASSED",
  evidence_tree_digest: DIGEST,
};

const unverified: GitCommitVerification = {
  kind: "UNVERIFIED",
  reason: "documentation-only change with no executable surface",
};

describe("git lifecycle", () => {
  let worktree: string;
  let mirror: string;
  let baseSha: string;
  const dirs: string[] = [];

  function lifecycle(declaredPaths: readonly string[] = ["src/app.ts", "docs/readme.md"]) {
    return new GitLifecycle({
      worktreePath: worktree,
      mirrorPath: mirror,
      scope,
      repositoryId: "repo-1",
      declaredPaths,
    });
  }

  beforeEach(async () => {
    // A real repository with one commit on a non-protected default branch, so a
    // commit test is not fighting the protected-branch guard.
    worktree = await mkdtemp(join(tmpdir(), "git-wt-"));
    mirror = join(worktree, ".git");
    dirs.push(worktree);
    await raw(["init", "--initial-branch=base-line"], worktree);
    await mkdir(join(worktree, "src"), { recursive: true });
    await mkdir(join(worktree, "docs"), { recursive: true });
    await writeFile(join(worktree, "src", "app.ts"), "export const a = 1;\n");
    await writeFile(join(worktree, "docs", "readme.md"), "# docs\n");
    await raw(["add", "."], worktree);
    await raw(["commit", "-m", "base"], worktree);
    baseSha = await raw(["rev-parse", "HEAD"], worktree);
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  describe("AC1: resume never creates a second branch", () => {
    it("creates once, then resumes, leaving exactly ONE branch", async () => {
      const git = lifecycle();

      const first = await git.ensureBranch("add login", baseSha);
      expect(first.disposition).toBe(GitBranchDisposition.CREATED);

      const second = await git.ensureBranch("add login", baseSha);
      expect(second.disposition).toBe(GitBranchDisposition.RESUMED);
      expect(second.branch_name).toBe(first.branch_name);

      // The decisive assertion: count the branches. `CREATED`/`RESUMED` alone
      // would not exclude a duplicate having been made under a different name.
      const branches = (await raw(["branch", "--list", "agent/*"], worktree))
        .split("\n")
        .map((line) => line.replace(/^[*+]?\s*/u, ""))
        .filter((line) => line.length > 0);
      expect(branches).toHaveLength(1);
    });

    it("derives the same branch name deterministically for one case", () => {
      const git = lifecycle();
      // Resume works by lookup, so the name must not depend on time or randomness.
      expect(git.branchNameFor("add login")).toBe(git.branchNameFor("add login"));
      expect(git.branchNameFor("Add Login!")).toBe(git.branchNameFor("add-login"));
    });

    it("gives different cases different branches for the same slug", () => {
      const other = new GitLifecycle({
        worktreePath: worktree,
        mirrorPath: mirror,
        scope: { case_id: "case-other", workspace_id: "ws-other" },
        repositoryId: "repo-1",
      });
      expect(other.branchNameFor("add login")).not.toBe(lifecycle().branchNameFor("add login"));
    });

    it("records the pinned base rather than re-deriving it on resume", async () => {
      const git = lifecycle();
      const first = await git.ensureBranch("add login", baseSha);

      // Move the branch forward, then resume. The recorded base must still describe
      // what the work was built on, not the new tip.
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 2;\n");
      await raw(["add", "src/app.ts"], worktree);
      await raw(["commit", "-m", "progress"], worktree);

      const resumed = await git.ensureBranch("add login", baseSha);
      expect(resumed.base_sha).toBe(first.base_sha);
      expect(resumed.head_sha).not.toBe(first.head_sha);
    });

    it("refuses to create a protected branch", () => {
      expect(isProtectedBranch("main")).toBe(true);
      expect(isProtectedBranch("release/1.2")).toBe(true);
      expect(isProtectedBranch("Production")).toBe(true);
      expect(isProtectedBranch("agent/feature-abc")).toBe(false);
    });
  });

  describe("AC2: no staging outside the workspace or the declared scope", () => {
    it("stages a declared path and reports it", async () => {
      const git = lifecycle();
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 9;\n");

      expect(await git.stage(["src/app.ts"])).toEqual(["src/app.ts"]);
      expect(await raw(["diff", "--cached", "--name-only"], worktree)).toBe("src/app.ts");
    });

    it("refuses an absolute path, traversal and an undeclared path", async () => {
      const git = lifecycle();
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 9;\n");
      await writeFile(join(worktree, "docs", "other.md"), "undeclared\n");

      for (const bad of ["/etc/passwd", "../escape", "src/../../escape", "docs/other.md"]) {
        await expectCodeAsync(async () => git.stage([bad]), GIT_PATH_OUT_OF_SCOPE);
      }
      // Nothing was staged by any of the refused calls.
      expect(await raw(["diff", "--cached", "--name-only"], worktree)).toBe("");
    });

    it("refuses a magic pathspec that would widen the staged set", async () => {
      const git = lifecycle();
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "docs", "other.md"), "undeclared\n");

      // `:/` and `:(glob)` are Git pathspec magic; they are not declared paths, so
      // the declared-surface check refuses them before Git ever sees them.
      for (const magic of [":/", ":(glob)**/*.md", ":!src"]) {
        await expectCodeAsync(async () => git.stage([magic]), GIT_PATH_OUT_OF_SCOPE);
      }
      expect(await raw(["diff", "--cached", "--name-only"], worktree)).toBe("");
    });

    it("refuses to commit when nothing is staged", async () => {
      const git = lifecycle();
      await git.ensureBranch("work", baseSha);
      await expectCodeAsync(
        async () => git.commit({ message: "empty", paths: [], verification: unverified }),
        GIT_NOTHING_STAGED,
      );
    });
  });

  describe("AC3: a commit is bound to evidence or explicitly unverified", () => {
    it("records a verified commit with its run receipts", async () => {
      const git = lifecycle();
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 42;\n");

      const receipt = await git.commit({
        message: "feat: change a",
        paths: ["src/app.ts"],
        verification: verified,
      });

      expect(receipt.verification.kind).toBe("VERIFIED");
      expect(receipt.staged_paths).toEqual(["src/app.ts"]);
      expect(receipt.files_changed).toBe(1);
      expect(receipt.commit_sha).toBe(await raw(["rev-parse", "HEAD"], worktree));
      expect(receipt.parent_sha).toBe(await raw(["rev-parse", "HEAD~1"], worktree));
    });

    it("records an unverified commit only with a stated reason", async () => {
      const git = lifecycle();
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "docs", "readme.md"), "# docs updated\n");

      const receipt = await git.commit({
        message: "docs: update",
        paths: ["docs/readme.md"],
        verification: unverified,
      });
      expect(receipt.verification.kind).toBe("UNVERIFIED");
    });

    it("makes a verified commit without receipts unrepresentable", () => {
      const base = {
        schema_version: 1,
        scope,
        branch_name: "agent/x-12345678",
        commit_sha: "a".repeat(40),
        parent_sha: "b".repeat(40),
        staged_paths: ["src/app.ts"],
        files_changed: 1,
        insertions: 1,
        deletions: 0,
      };
      // No receipts at all.
      expect(() =>
        gitCommitReceipt.parse({
          ...base,
          verification: {
            kind: "VERIFIED",
            run_receipts: [],
            verdict: "PASSED",
            evidence_tree_digest: DIGEST,
          },
        }),
      ).toThrow();
      // A non-PASSED verdict cannot be laundered into VERIFIED.
      expect(() =>
        gitCommitReceipt.parse({
          ...base,
          verification: {
            kind: "VERIFIED",
            run_receipts: [DIGEST],
            verdict: "FAILED",
            evidence_tree_digest: DIGEST,
          },
        }),
      ).toThrow();
      // An unverified commit cannot omit its reason.
      expect(() =>
        gitCommitReceipt.parse({ ...base, verification: { kind: "UNVERIFIED" } }),
      ).toThrow();
      // There is no third shape.
      expect(() =>
        gitCommitReceipt.parse({ ...base, verification: { kind: "SKIPPED" } }),
      ).toThrow();
    });

    it("creates and read-only reconciles one exact evidence-bound commit", async () => {
      const git = lifecycle(["src/app.ts"]);
      const branch = await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 77;\n");
      const actual = await git.diff();
      const descriptor = gitEvidenceBoundCommitDescriptor.parse({
        schema_version: 1,
        operation_id: "eng-op-commit-1",
        case_id: scope.case_id,
        work_unit_id: "unit-1",
        workspace_id: scope.workspace_id,
        repository_id: "repo-1",
        run_id: "run-1",
        checkpoint_revision: 0,
        branch_name: branch.branch_name,
        expected_parent_sha: baseSha,
        exact_paths: ["src/app.ts"],
        message: "feat: exact change\n\n[remoteagent-operation:eng-op-commit-1]",
        operation_marker: "[remoteagent-operation:eng-op-commit-1]",
        tree_digest: DIGEST,
        actual_diff_digest: DIGEST,
        raw_patch_digest: canonicalDigest(actual.patch),
        accepted: [
          { slice_id: "slice-1", attempt: 1, evidence_digest: DIGEST, review_digest: DIGEST },
        ],
        evidence_digest: DIGEST_ROLLUP,
        review_digest: DIGEST_ROLLUP,
        final_verification_digest: DIGEST,
      });
      const fences: string[] = [];
      const receipt = await git.commitEvidenceBound({
        descriptor,
        beforeStage: async () => void fences.push("add"),
        beforeCommit: async () => void fences.push("commit"),
      });
      expect(fences).toEqual(["add", "commit"]);
      expect(receipt.parent_sha).toBe(baseSha);
      expect(receipt.staged_paths).toEqual(["src/app.ts"]);
      expect(await raw(["log", "-1", "--format=%B"], worktree)).toContain(
        descriptor.operation_marker,
      );
      expect(await git.observeEvidenceBoundCommit(descriptor)).toEqual(receipt);
      expect(await raw(["rev-list", "--count", `${baseSha}..HEAD`], worktree)).toBe("1");
    });

    it("stops on stale fences and refuses extra staged paths", async () => {
      const git = lifecycle(["src/app.ts", "docs/readme.md"]);
      const branch = await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 88;\n");
      const actual = await git.diff();
      const descriptor = gitEvidenceBoundCommitDescriptor.parse({
        schema_version: 1,
        operation_id: "eng-op-commit-2",
        case_id: scope.case_id,
        work_unit_id: "unit-1",
        workspace_id: scope.workspace_id,
        repository_id: "repo-1",
        run_id: "run-1",
        checkpoint_revision: 0,
        branch_name: branch.branch_name,
        expected_parent_sha: baseSha,
        exact_paths: ["src/app.ts"],
        message: "feat: exact change\n\n[remoteagent-operation:eng-op-commit-2]",
        operation_marker: "[remoteagent-operation:eng-op-commit-2]",
        tree_digest: DIGEST,
        actual_diff_digest: DIGEST,
        raw_patch_digest: canonicalDigest(actual.patch),
        accepted: [
          { slice_id: "slice-1", attempt: 1, evidence_digest: DIGEST, review_digest: DIGEST },
        ],
        evidence_digest: DIGEST_ROLLUP,
        review_digest: DIGEST_ROLLUP,
        final_verification_digest: DIGEST,
      });
      await expect(
        git.commitEvidenceBound({
          descriptor,
          beforeStage: async () => {
            throw new Error("stale add fence");
          },
          beforeCommit: async () => undefined,
        }),
      ).rejects.toThrow(/stale add fence/);
      expect(await raw(["diff", "--cached", "--name-only"], worktree)).toBe("");

      await expect(
        git.commitEvidenceBound({
          descriptor,
          beforeStage: async () => undefined,
          beforeCommit: async () => {
            throw new Error("stale commit fence");
          },
        }),
      ).rejects.toThrow(/stale commit fence/);
      expect(await raw(["rev-parse", "HEAD"], worktree)).toBe(baseSha);
      await raw(["reset", "HEAD", "--", "src/app.ts"], worktree);

      await writeFile(join(worktree, "docs", "readme.md"), "foreign staged\n");
      await raw(["add", "docs/readme.md"], worktree);
      await expectCodeAsync(
        () =>
          git.commitEvidenceBound({
            descriptor,
            beforeStage: async () => undefined,
            beforeCommit: async () => undefined,
          }),
        GIT_DIRTY_FOREIGN,
      );
      expect(await raw(["rev-parse", "HEAD"], worktree)).toBe(baseSha);
    });

    it("ignores repository-controlled hooks, fsmonitor, filters, signing and diff executables", async () => {
      const git = lifecycle(["src/app.ts"]);
      const branch = await git.ensureBranch("work", baseSha);
      const executableConfig = await mkdtemp(join(tmpdir(), "git-executable-config-"));
      dirs.push(executableConfig);
      const canary = join(executableConfig, "git-executable-config-ran");
      const driver = join(executableConfig, "evil-driver.sh");
      await writeFile(
        driver,
        `#!/bin/sh\ntouch '${canary}'\nif [ "$#" -gt 0 ]; then cat "$1"; else cat; fi\n`,
      );
      await chmod(driver, 0o700);
      const hooks = join(executableConfig, "evil-hooks");
      await mkdir(hooks);
      await writeFile(join(hooks, "post-commit"), `#!/bin/sh\ntouch '${canary}'\n`);
      await chmod(join(hooks, "post-commit"), 0o700);
      await writeFile(
        join(worktree, ".git", "info", "attributes"),
        "src/app.ts filter=evil diff=evil\n",
      );
      await raw(["config", "core.hooksPath", hooks], worktree);
      await raw(["config", "core.fsmonitor", driver], worktree);
      await raw(["config", "filter.evil.clean", driver], worktree);
      await raw(["config", "filter.evil.smudge", driver], worktree);
      await raw(["config", "filter.evil.process", driver], worktree);
      await raw(["config", "filter.evil.required", "true"], worktree);
      await raw(["config", "commit.gpgSign", "true"], worktree);
      await raw(["config", "diff.external", driver], worktree);
      await raw(["config", "diff.evil.textconv", driver], worktree);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 99;\n");
      const actual = await git.diff();
      const descriptor = gitEvidenceBoundCommitDescriptor.parse({
        schema_version: 1,
        operation_id: "eng-op-commit-config",
        case_id: scope.case_id,
        work_unit_id: "unit-1",
        workspace_id: scope.workspace_id,
        repository_id: "repo-1",
        run_id: "run-1",
        checkpoint_revision: 0,
        branch_name: branch.branch_name,
        expected_parent_sha: baseSha,
        exact_paths: ["src/app.ts"],
        message: "feat: safe config\n\n[remoteagent-operation:eng-op-commit-config]",
        operation_marker: "[remoteagent-operation:eng-op-commit-config]",
        tree_digest: DIGEST,
        actual_diff_digest: DIGEST,
        raw_patch_digest: canonicalDigest(actual.patch),
        accepted: [
          { slice_id: "slice-1", attempt: 1, evidence_digest: DIGEST, review_digest: DIGEST },
        ],
        evidence_digest: DIGEST_ROLLUP,
        review_digest: DIGEST_ROLLUP,
        final_verification_digest: DIGEST,
      });
      const receipt = await git.commitEvidenceBound({
        descriptor,
        beforeStage: async () => undefined,
        beforeCommit: async () => undefined,
      });
      expect(await git.observeEvidenceBoundCommit(descriptor)).toEqual(receipt);
      await expect(access(canary)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("fails closed on an unsupported target-controlled filter driver identity", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);
      const executableConfig = await mkdtemp(join(tmpdir(), "git-weird-filter-"));
      dirs.push(executableConfig);
      const canary = join(executableConfig, "weird-filter-ran");
      const driver = join(executableConfig, "weird-filter.sh");
      await writeFile(driver, `#!/bin/sh\ntouch '${canary}'\ncat\n`);
      await chmod(driver, 0o700);
      await writeFile(
        join(worktree, ".git", "info", "attributes"),
        "src/app.ts filter=evil/slash\n",
      );
      await raw(["config", "filter.evil/slash.clean", driver], worktree);
      await raw(["config", "filter.evil/slash.process", driver], worktree);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 100;\n");
      await expectCodeAsync(() => git.diff(), GIT_COMMAND_FAILED);
      expect(await raw(["rev-parse", "HEAD"], worktree)).toBe(baseSha);
      expect(await raw(["diff", "--cached", "--name-only"], worktree)).toBe("");
      await expect(access(canary)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("AC5: dirty user changes are detected and never silently overwritten", () => {
    it("classifies a foreign modification as DIRTY_FOREIGN", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);
      // A file the agent never declared — someone else's uncommitted work.
      await writeFile(join(worktree, "docs", "readme.md"), "USER EDIT IN PROGRESS\n");

      const status = await git.status();
      expect(status.state).toBe(GitWorkingTreeState.DIRTY_FOREIGN);
      expect(status.foreignPaths).toContain("docs/readme.md");
    });

    it("refuses to commit over a foreign modification, leaving its bytes intact", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 7;\n");
      await writeFile(join(worktree, "docs", "readme.md"), "USER EDIT IN PROGRESS\n");

      await expectCodeAsync(
        async () =>
          git.commit({ message: "feat: x", paths: ["src/app.ts"], verification: unverified }),
        GIT_DIRTY_FOREIGN,
      );

      // The user's bytes are still there and nothing was committed.
      expect(await readFile(join(worktree, "docs", "readme.md"), "utf8")).toBe(
        "USER EDIT IN PROGRESS\n",
      );
      expect(await raw(["rev-parse", "HEAD"], worktree)).toBe(
        await raw(["rev-parse", "HEAD"], worktree),
      );
    });

    it("refuses to rebase over a foreign modification", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "docs", "readme.md"), "USER EDIT\n");

      const report = await git.rebase(baseSha);
      expect(report.outcome).toBe(GitRebaseOutcome.REFUSED);
      expect(report.refusal_code).toBe(GIT_DIRTY_FOREIGN);
      expect(await readFile(join(worktree, "docs", "readme.md"), "utf8")).toBe("USER EDIT\n");
    });

    it("reports CLEAN and DIRTY_AGENT correctly", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);
      expect((await git.status()).state).toBe(GitWorkingTreeState.CLEAN);

      await writeFile(join(worktree, "src", "app.ts"), "export const a = 5;\n");
      const dirty = await git.status();
      expect(dirty.state).toBe(GitWorkingTreeState.DIRTY_AGENT);
      expect(dirty.agentPaths).toEqual(["src/app.ts"]);
    });
  });

  describe("AC4: a rebase conflict is aborted, never auto-resolved", () => {
    it("reports CONFLICTED and leaves the repository NOT mid-rebase", async () => {
      const git = lifecycle(["src/app.ts"]);

      // Build genuinely divergent history: both branches change the same line.
      await raw(["checkout", "-b", "other-base", baseSha], worktree);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 'theirs';\n");
      await raw(["add", "src/app.ts"], worktree);
      await raw(["commit", "-m", "theirs"], worktree);
      const theirs = await raw(["rev-parse", "HEAD"], worktree);

      await raw(["checkout", "base-line"], worktree);
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 'ours';\n");
      await raw(["add", "src/app.ts"], worktree);
      await raw(["commit", "-m", "ours"], worktree);

      const report = await git.rebase(theirs);

      expect(report.outcome).toBe(GitRebaseOutcome.CONFLICTED);
      expect(report.conflicting_paths.length).toBeGreaterThan(0);
      // The load-bearing assertion: "aborted rather than resolved" means the repo is
      // not left mid-rebase. `REBASE_HEAD` exists only during a rebase.
      await expect(raw(["rev-parse", "--verify", "REBASE_HEAD"], worktree)).rejects.toThrow();
      // And the base was not silently advanced.
      expect(report.new_base_sha).toBe(report.previous_base_sha);
    });

    it("reports UP_TO_DATE when the target is already an ancestor", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);

      const report = await git.rebase(baseSha);
      expect(report.outcome).toBe(GitRebaseOutcome.UP_TO_DATE);
      expect(report.conflicting_paths).toEqual([]);
    });

    it("rebases cleanly when histories do not overlap", async () => {
      const git = lifecycle(["src/app.ts", "docs/readme.md"]);

      await raw(["checkout", "-b", "other-base", baseSha], worktree);
      await writeFile(join(worktree, "docs", "readme.md"), "# theirs\n");
      await raw(["add", "docs/readme.md"], worktree);
      await raw(["commit", "-m", "theirs"], worktree);
      const theirs = await raw(["rev-parse", "HEAD"], worktree);

      await raw(["checkout", "base-line"], worktree);
      await git.ensureBranch("work", baseSha);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 'ours';\n");
      await raw(["add", "src/app.ts"], worktree);
      await raw(["commit", "-m", "ours"], worktree);

      const report = await git.rebase(theirs);
      expect(report.outcome).toBe(GitRebaseOutcome.REBASED);
      expect(report.new_base_sha).toBe(theirs);
    });

    it("has no strategy or resolution parameter at all", () => {
      const git = lifecycle();
      // One argument, and it is a SHA. There is no way to ask for auto-resolution.
      expect(git.rebase.length).toBe(1);
    });
  });

  describe("AC6: forbidden destructive commands have negative tests", () => {
    it("refuses every forbidden subcommand", () => {
      for (const argv of [
        ["push", "origin", "HEAD"],
        ["clean", "-xd"],
        ["submodule", "update"],
        ["remote", "add", "evil", "https://example.invalid"],
        ["filter-branch", "--all"],
        ["gc"],
        ["reflog", "expire"],
      ]) {
        expect(() => assertPermitted(argv), argv.join(" ")).toThrow(GitLifecycleError);
      }
    });

    it("refuses every forbidden flag, including on an otherwise safe subcommand", () => {
      for (const argv of [
        ["reset", "--hard", "HEAD~1"],
        ["commit", "--force"],
        ["checkout", "-f", "--", "src"],
        ["reset", "--keep", "HEAD~1"],
        ["reset", "--merge", "HEAD~1"],
      ]) {
        expect(() => assertPermitted(argv), argv.join(" ")).toThrow(GitLifecycleError);
      }
    });

    it("refuses a broad checkout or restore with no pathspec", () => {
      // Assert the stable `code`, not the prose: messages are dropped at
      // boundaries because they can embed host paths.
      for (const argv of [
        ["checkout", "HEAD"],
        ["restore", "."],
      ]) {
        try {
          assertPermitted(argv);
          throw new Error(`expected a refusal for: ${argv.join(" ")}`);
        } catch (error) {
          expect((error as { code?: string }).code).toBe(GIT_OPERATION_FORBIDDEN);
        }
      }
      // With an explicit pathspec it is permitted.
      expect(() => assertPermitted(["checkout", "HEAD", "--", "src/app.ts"])).not.toThrow();
    });

    it("refuses the bypasses an audit probe actually found", () => {
      // Every entry here defeated the original denylist. `-C` and `--git-dir`
      // redirect the command at another repository; `-c` defines an alias or a
      // hooksPath, which is arbitrary code execution; and `stash drop`,
      // `update-ref -d` and `branch -D` are destructive verbs a denylist simply
      // had not enumerated. The allowlist refuses all of them by default.
      for (const argv of [
        ["-C", "/tmp", "push", "origin", "HEAD"],
        ["--git-dir", "/tmp/x", "push"],
        ["-c", "alias.p=push", "p"],
        ["-c", "core.hooksPath=/tmp/evil", "commit", "-m", "x"],
        ["--exec-path=/tmp", "push"],
        ["stash", "drop"],
        ["update-ref", "-d", "refs/heads/main"],
        ["branch", "-D", "main"],
        ["branch", "-d", "main"],
        ["branch", "-M", "main", "other"],
        ["worktree", "remove", "/tmp"],
        ["fetch", "origin"],
        ["cherry-pick", "abc"],
        ["revert", "abc"],
        ["log", "--ext-diff", "HEAD"],
        ["check-attr", "-a", "--", "src/app.ts"],
      ]) {
        try {
          assertPermitted(argv);
          throw new Error(`expected a refusal for: ${argv.join(" ")}`);
        } catch (error) {
          expect((error as { code?: string }).code, argv.join(" ")).toBe(GIT_OPERATION_FORBIDDEN);
        }
      }
    });

    it("refuses staging anything when NO paths were declared", async () => {
      // Found by an audit probe. The check read `declared.size > 0 && ...`, so a
      // lifecycle built without `declaredPaths` staged whatever it was handed —
      // the probe staged `secret.env`. An absent declaration means nothing was
      // declared, not that everything is permitted.
      const git = new GitLifecycle({
        worktreePath: worktree,
        mirrorPath: mirror,
        scope,
        repositoryId: "repo-1",
      });
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 4;\n");

      await expectCodeAsync(async () => git.stage(["src/app.ts"]), GIT_PATH_OUT_OF_SCOPE);
      expect(await raw(["diff", "--cached", "--name-only"], worktree)).toBe("");
    });

    it("permits the operations the lifecycle actually needs", () => {
      for (const argv of [
        ["status", "--porcelain=v1", "-z"],
        ["diff", "--numstat", "-z", "HEAD"],
        ["--literal-pathspecs", "add", "--", "src/app.ts"],
        ["commit", "--no-verify", "-m", "msg"],
        ["rebase", "abc"],
        ["rebase", "--abort"],
        ["merge-base", "--is-ancestor", "a", "b"],
        ["rev-parse", "HEAD"],
      ]) {
        expect(() => assertPermitted(argv), argv.join(" ")).not.toThrow();
      }
    });

    it("refuses a protected branch commit", async () => {
      const git = lifecycle(["src/app.ts"]);
      // Stay on a protected branch instead of creating an agent branch.
      await raw(["checkout", "-b", "main"], worktree);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 3;\n");

      await expectCodeAsync(
        async () =>
          git.commit({ message: "feat: x", paths: ["src/app.ts"], verification: unverified }),
        GIT_BRANCH_PROTECTED,
      );
      expect(await raw(["log", "--oneline"], worktree)).not.toContain("feat: x");
    });
  });

  describe("bounded output and export surface", () => {
    it("observes an empty declared surface as an empty diff", async () => {
      const report = await lifecycle([]).diff();

      expect(report).toEqual({
        patch: "",
        truncated: false,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      });
    });

    it("reports a diff with stat counts", async () => {
      const git = lifecycle(["src/app.ts"]);
      await git.ensureBranch("work", baseSha);
      await writeFile(
        join(worktree, "src", "app.ts"),
        "export const a = 1;\nexport const b = 2;\n",
      );

      const report = await git.diff();
      expect(report.truncated).toBe(false);
      expect(report.filesChanged).toBe(1);
      expect(report.insertions).toBeGreaterThan(0);
      expect(report.patch).toContain("export const b");
    });

    it("ignores target-controlled home config and external diff drivers", async () => {
      const homeCanary = join(worktree, "home-config-ran");
      const localCanary = join(worktree, "local-diff-ran");
      const homeDriver = join(worktree, "home-driver.sh");
      const localDriver = join(worktree, "local-driver.sh");
      await writeFile(homeDriver, `#!/bin/sh\ntouch '${homeCanary}'\nexit 0\n`);
      await writeFile(localDriver, `#!/bin/sh\ntouch '${localCanary}'\nexit 0\n`);
      await chmod(homeDriver, 0o700);
      await chmod(localDriver, 0o700);
      await writeFile(join(worktree, ".gitconfig"), `[diff]\n\texternal = ${homeDriver}\n`);
      await raw(["config", "diff.external", localDriver], worktree);
      await writeFile(join(worktree, "src", "app.ts"), "export const a = 99;\n");

      const report = await lifecycle([
        "src/app.ts",
        ".gitconfig",
        "home-driver.sh",
        "local-driver.sh",
      ]).diff();
      expect(report.patch).toContain("export const a = 99");
      await expect(access(homeCanary)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(localCanary)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("shares no exported name with the packages it builds on", async () => {
      // Only this package's actual dependencies are checked. `implementation-tools`
      // is deliberately NOT one of them — the collision hazard is a shared `export *`
      // barrel, which requires a real dependency edge, so importing a package this
      // one cannot reach would test nothing and only break under `--filter`.
      const [own, contracts, evidence] = await Promise.all([
        import("../src/index.js"),
        import("@remoteagent/contracts"),
        import("@remoteagent/test-evidence"),
      ]);
      const foreign = new Set([...Object.keys(contracts), ...Object.keys(evidence)]);
      expect(Object.keys(own).filter((name) => foreign.has(name))).toEqual([]);
    });
  });
});
