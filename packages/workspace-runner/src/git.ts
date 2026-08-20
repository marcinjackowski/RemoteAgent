import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRepository = Readonly<{
  sourcePath: string;
  mirrorPath: string;
}>;

async function runGit(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

export async function ensureMirror(repository: GitRepository): Promise<void> {
  let exists = true;
  try {
    await access(repository.mirrorPath);
  } catch {
    exists = false;
  }
  if (exists) {
    const bare = await runGit([
      "--git-dir",
      repository.mirrorPath,
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (bare !== "true") throw new Error("Configured mirror is not a bare Git repository");
  } else {
    await mkdir(dirname(repository.mirrorPath), { recursive: true });
    await runGit(["clone", "--mirror", repository.sourcePath, repository.mirrorPath]);
  }
}

export async function verifyCommit(repository: GitRepository, baseSha: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error("baseSha must be an exact Git object SHA");
  const resolved = await runGit([
    "--git-dir",
    repository.mirrorPath,
    "rev-parse",
    `${baseSha}^{commit}`,
  ]);
  if (resolved.toLowerCase() !== baseSha.toLowerCase()) {
    throw new Error("baseSha does not resolve to the requested commit");
  }
  return resolved;
}

export async function addWorktree(
  repository: GitRepository,
  worktreePath: string,
  branchName: string,
  baseSha: string,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName) || branchName.includes("..")) {
    throw new Error("Invalid branch intent");
  }
  await runGit([
    "--git-dir",
    repository.mirrorPath,
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    baseSha,
  ]);
}

export async function worktreeHead(worktreePath: string): Promise<string> {
  return runGit(["rev-parse", "HEAD"], worktreePath);
}
