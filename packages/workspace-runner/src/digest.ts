import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { validateWorkspaceRoot, type VerifiedWorkspacePath } from "./path-policy.js";

const execFileAsync = promisify(execFile);

export class WorkspaceDigestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceDigestError";
  }
}

type TreeEntry = Readonly<{
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  content: string;
}>;

export type WorkspaceSnapshot = Readonly<{
  treeDigest: string;
  dirtyState: "CLEAN" | "DIRTY";
}>;

async function entries(
  root: VerifiedWorkspacePath,
  current: string,
  output: TreeEntry[],
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const children = (await readdir(current)).filter((name) => name !== ".git").sort();
  for (const name of children) {
    const path = join(current, name);
    const stat = await lstat(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (stat.isSymbolicLink()) {
      output.push({
        path: relativePath,
        kind: "symlink",
        mode: stat.mode & 0o7777,
        content: await readlink(path),
      });
    } else if (stat.isDirectory()) {
      output.push({ path: relativePath, kind: "directory", mode: stat.mode & 0o7777, content: "" });
      await entries(root, path, output);
    } else if (stat.isFile()) {
      const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
      const handle = await open(path, constants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile())
          throw new WorkspaceDigestError(`File changed during digest: ${relativePath}`);
        output.push({
          path: relativePath,
          kind: "file",
          mode: opened.mode & 0o7777,
          content: createHash("sha256")
            .update(await handle.readFile())
            .digest("hex"),
        });
      } finally {
        await handle.close();
      }
    } else {
      throw new WorkspaceDigestError(`Unsupported filesystem entry: ${relativePath}`);
    }
  }
}

export async function computeTreeDigest(root: string | VerifiedWorkspacePath): Promise<string> {
  const verified = await validateWorkspaceRoot(root);
  const snapshot: TreeEntry[] = [];
  await entries(verified, verified, snapshot);
  const hash = createHash("sha256");
  for (const entry of snapshot.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))) {
    const frame = Buffer.from(JSON.stringify([entry.kind, entry.mode, entry.path, entry.content]));
    hash.update(Buffer.from(`${frame.length}:`));
    hash.update(frame);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function inspectWorkspace(
  root: string | VerifiedWorkspacePath,
): Promise<WorkspaceSnapshot> {
  const verified = await validateWorkspaceRoot(root);
  const treeDigest = await computeTreeDigest(verified);
  const { stdout } = await execFileAsync(
    "git",
    ["-C", verified, "status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { maxBuffer: 1024 * 1024 },
  );
  return { treeDigest, dirtyState: stdout.length === 0 ? "CLEAN" : "DIRTY" };
}
