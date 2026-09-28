import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { engineeringLocalCommitReceipt } from "@remoteagent/contracts";
import { computeTreeDigest } from "@remoteagent/workspace-runner";

const run = promisify(execFile);

async function git(worktreePath: string, args: readonly string[]): Promise<string> {
  const result = await run("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: worktreePath,
    maxBuffer: 128 * 1024,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  return result.stdout.trim();
}

async function assertGitObservation(
  worktreePath: string,
  expectedSourceParent: string,
  receipt: unknown,
): Promise<void> {
  const parsed = engineeringLocalCommitReceipt.parse(receipt);
  const requestedRoot = await realpath(worktreePath);
  const actualRoot = await realpath(await git(worktreePath, ["rev-parse", "--show-toplevel"]));
  if (actualRoot !== requestedRoot) throw new Error("commit observation repository root mismatch");

  let branch: string;
  try {
    branch = await git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    throw new Error("commit observation requires a symbolic branch");
  }
  if (branch !== parsed.branch) throw new Error("commit observation branch mismatch");
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (head !== parsed.commit_sha) throw new Error("commit observation HEAD mismatch");
  const parents = (await git(worktreePath, ["rev-list", "--parents", "-n", "1", "HEAD"]))
    .split(/\s+/u)
    .filter(Boolean);
  if (parents.length !== 2 || parents[1] !== parsed.parent_sha)
    throw new Error("commit observation requires exactly one parent");
  if (parsed.parent_sha !== expectedSourceParent)
    throw new Error("commit observation source parent mismatch");

  const status = await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("commit observation worktree is dirty");
  const untracked = await git(worktreePath, ["ls-files", "--others", "-z"]);
  if (untracked !== "") throw new Error("commit observation has untracked files");
  if ((await computeTreeDigest(worktreePath)) !== parsed.tree_digest)
    throw new Error("commit observation tree digest mismatch");
}

export { assertGitObservation as observeEngineeringLiveCommit };
