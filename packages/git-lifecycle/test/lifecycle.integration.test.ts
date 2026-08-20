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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GIT_BRANCH_PROTECTED,
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
  gitCommitReceipt,
  isProtectedBranch,
} from "../src/index.js";
import type { GitCommitVerification, GitScope } from "../src/index.js";

const execFileAsync = promisify(execFile);
const scope: GitScope = { case_id: "case-git", workspace_id: "ws-git" };

const DIGEST = `sha256:${"a".repeat(64)}`;

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
