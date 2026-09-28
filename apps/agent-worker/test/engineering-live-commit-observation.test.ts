import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest } from "@remoteagent/contracts";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterEach, expect, it } from "vitest";

import { observeEngineeringLiveCommit } from "./engineering-live-commit-observation.js";

const run = promisify(execFile);
const roots: string[] = [];
const sha = (value: string) => canonicalDigest(value);

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await run("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    maxBuffer: 128 * 1024,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join("/tmp", "ra055-commit-observation-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "RemoteAgent Test"]);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", ".gitignore", "tracked.txt"]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "-qb", "remoteagent/observation"]);
  await writeFile(join(root, "tracked.txt"), "candidate\n");
  await git(root, ["commit", "-qam", "candidate"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const treeDigest = await computeTreeDigest(root);
  const receipt = {
    schema_version: 1,
    artifact_kind: "LocalCommitReceipt" as const,
    case_id: "case-observation",
    run_id: "run-observation",
    revision: 1,
    authority: "SERVER_OWNED" as const,
    receipt_id: "commit-observation",
    branch,
    commit_sha: commit,
    parent_sha: base,
    tree_digest: treeDigest,
    diff_digest: sha("diff"),
    evidence_digest: sha("evidence"),
    review_digest: sha("review"),
    verification_decision_digest: sha("verification"),
  };
  return { root, base, commit, receipt };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts a clean symbolic single-parent commit with the exact tree digest", async () => {
  const value = await fixture();
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, value.receipt),
  ).resolves.toBeUndefined();
});

it.each([
  [
    "nonexistent commit",
    (value: Awaited<ReturnType<typeof fixture>>) => ({
      ...value.receipt,
      commit_sha: "a".repeat(40),
    }),
  ],
  [
    "wrong parent",
    (value: Awaited<ReturnType<typeof fixture>>) => ({
      ...value.receipt,
      parent_sha: "b".repeat(40),
    }),
  ],
  [
    "wrong branch",
    (value: Awaited<ReturnType<typeof fixture>>) => ({
      ...value.receipt,
      branch: "remoteagent/other",
    }),
  ],
  [
    "wrong tree digest",
    (value: Awaited<ReturnType<typeof fixture>>) => ({
      ...value.receipt,
      tree_digest: sha("wrong-tree"),
    }),
  ],
] as const)("rejects %s", async (_label, mutate) => {
  const value = await fixture();
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, mutate(value)),
  ).rejects.toThrow();
});

it("rejects a valid receipt when the expected source parent is wrong", async () => {
  const value = await fixture();
  await expect(
    observeEngineeringLiveCommit(value.root, "c".repeat(40), value.receipt),
  ).rejects.toThrow(/source parent mismatch/u);
});

it("rejects staged and unstaged tracked changes with a matching dirty digest", async () => {
  const value = await fixture();
  await writeFile(join(value.root, "tracked.txt"), "unstaged\n");
  const unstagedReceipt = { ...value.receipt, tree_digest: await computeTreeDigest(value.root) };
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, unstagedReceipt),
  ).rejects.toThrow(/worktree is dirty/u);

  await writeFile(join(value.root, "tracked.txt"), "staged\n");
  await git(value.root, ["add", "tracked.txt"]);
  const stagedReceipt = { ...value.receipt, tree_digest: await computeTreeDigest(value.root) };
  await expect(observeEngineeringLiveCommit(value.root, value.base, stagedReceipt)).rejects.toThrow(
    /worktree is dirty/u,
  );
});

it("rejects untracked and ignored files with a matching dirty digest", async () => {
  const value = await fixture();
  await writeFile(join(value.root, "untracked.txt"), "untracked\n");
  const untrackedReceipt = { ...value.receipt, tree_digest: await computeTreeDigest(value.root) };
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, untrackedReceipt),
  ).rejects.toThrow(/worktree is dirty/u);

  await rm(join(value.root, "untracked.txt"));
  await writeFile(join(value.root, "ignored.txt"), "ignored\n");
  const ignoredReceipt = { ...value.receipt, tree_digest: await computeTreeDigest(value.root) };
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, ignoredReceipt),
  ).rejects.toThrow(/untracked files/u);
});

it("rejects detached HEAD and a nested path that is not the repository root", async () => {
  const value = await fixture();
  await git(value.root, ["checkout", "--detach", "-q", value.commit]);
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, { ...value.receipt, branch: "HEAD" }),
  ).rejects.toThrow(/symbolic branch/u);

  const second = await fixture();
  const nested = join(second.root, "nested");
  await mkdir(nested);
  await expect(
    observeEngineeringLiveCommit(nested, second.base, {
      ...second.receipt,
      tree_digest: await computeTreeDigest(nested),
    }),
  ).rejects.toThrow(/repository root mismatch/u);
});

it("rejects a merge commit because the receipt must identify one parent", async () => {
  const value = await fixture();
  await git(value.root, ["checkout", "-qb", "side"]);
  await writeFile(join(value.root, "side.txt"), "side\n");
  await git(value.root, ["add", "side.txt"]);
  await git(value.root, ["commit", "-qm", "side"]);
  await git(value.root, ["checkout", "-q", "remoteagent/observation"]);
  await git(value.root, ["merge", "--no-ff", "-m", "merge side", "side"]);
  const merge = await git(value.root, ["rev-parse", "HEAD"]);
  const firstParent = (await git(value.root, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(
    /\s+/u,
  )[1]!;
  const receipt = {
    ...value.receipt,
    commit_sha: merge,
    parent_sha: firstParent,
    tree_digest: await computeTreeDigest(value.root),
  };
  await expect(observeEngineeringLiveCommit(value.root, firstParent, receipt)).rejects.toThrow(
    /exactly one parent/u,
  );
});

it("rejects an invalid local commit receipt before inspecting Git", async () => {
  const value = await fixture();
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, {
      ...value.receipt,
      commit_sha: undefined,
    }),
  ).rejects.toThrow();
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, {
      ...value.receipt,
      authority: "MODEL",
    }),
  ).rejects.toThrow();
});

it("ignores Git replacement objects while observing the committed parent", async () => {
  const value = await fixture();
  const tree = await git(value.root, ["rev-parse", "HEAD^{tree}"]);
  const fakeParent = await git(value.root, ["commit-tree", tree, "-m", "fake parent"]);
  const replacement = await git(value.root, [
    "commit-tree",
    tree,
    "-p",
    fakeParent,
    "-m",
    "replacement",
  ]);
  await git(value.root, ["replace", value.commit, replacement]);
  try {
    await expect(
      observeEngineeringLiveCommit(value.root, fakeParent, {
        ...value.receipt,
        parent_sha: fakeParent,
      }),
    ).rejects.toThrow();
  } finally {
    await git(value.root, ["replace", "-d", value.commit]);
  }
});

it("does not rewrite the index when only tracked-file mtime changes", async () => {
  const value = await fixture();
  const indexPath = join(value.root, ".git", "index");
  const before = await readFile(indexPath);
  const now = new Date(Date.now() + 2_000);
  await utimes(join(value.root, "tracked.txt"), now, now);
  await expect(
    observeEngineeringLiveCommit(value.root, value.base, value.receipt),
  ).resolves.toBeUndefined();
  const after = await readFile(indexPath);
  expect(after.equals(before)).toBe(true);
});
