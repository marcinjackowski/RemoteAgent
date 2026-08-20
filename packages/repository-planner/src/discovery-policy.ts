import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { relativeRepositoryPath, type RelativeRepositoryPath } from "@remoteagent/contracts";
import { validateWorkspaceRoot, type VerifiedWorkspacePath } from "@remoteagent/workspace-runner";

export const DISCOVERY_LIMITS = Object.freeze({
  maxFileBytes: 1_048_576,
  maxTotalScanBytes: 16_777_216,
  maxEntries: 512,
  maxDepth: 32,
  maxResults: 128,
});

export type DiscoveryErrorCode =
  | "INVALID_ROOT"
  | "PATH_ESCAPE"
  | "SYMLINK_NOT_ALLOWED"
  | "FILE_NOT_ALLOWED"
  | "BINARY_FILE"
  | "OVERSIZE"
  | "DISCOVERY_FAILED";

export class DiscoveryPolicyError extends Error {
  public constructor(
    public readonly code: DiscoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryPolicyError";
  }
}

export type DiscoveryReadSeam = (path: string) => Promise<void> | void;
export type SafeReadResult = Readonly<{
  relativePath: RelativeRepositoryPath;
  content: string;
  digest: string;
}>;
export type SafeTreeEntry = Readonly<{
  relativePath: RelativeRepositoryPath;
  kind: "file" | "directory" | "symlink";
  digest: string;
}>;
export type ScanBudget = { scannedBytes: number; entries: number };

const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(code: DiscoveryErrorCode, message: string): never {
  throw new DiscoveryPolicyError(code, message);
}

function hash(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function isForbiddenPath(path: string): boolean {
  const segments = path.split("/").map((segment) => segment.toLowerCase());
  if (segments.includes(".git")) return true;
  const name = segments.at(-1) ?? "";
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(?:key|pem|p12|pfx)$/u.test(name) ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    new Set([
      "credentials",
      "credentials.json",
      "secrets",
      "secrets.json",
      "token",
      "token.json",
    ]).has(name)
  );
}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  ".pnpm-store",
]);

function isBinary(content: Buffer): boolean {
  try {
    decoder.decode(content);
  } catch {
    return true;
  }
  if (content.includes(0)) return true;
  let controls = 0;
  for (const byte of content) if (byte < 7 || (byte > 14 && byte < 32)) controls += 1;
  return content.length > 0 && controls / content.length > 0.1;
}

function addBytes(budget: ScanBudget, bytes: number): void {
  budget.scannedBytes += bytes;
  if (budget.scannedBytes > DISCOVERY_LIMITS.maxTotalScanBytes)
    fail("OVERSIZE", "Discovery byte budget exceeded");
}

function addEntry(budget: ScanBudget): void {
  budget.entries += 1;
  if (budget.entries > DISCOVERY_LIMITS.maxEntries)
    fail("OVERSIZE", "Discovery entry limit exceeded");
}

async function verifyPath(
  root: VerifiedWorkspacePath,
  input: string,
  requireFile: boolean,
): Promise<{ relativePath: RelativeRepositoryPath; target: string }> {
  let relativePath: RelativeRepositoryPath;
  try {
    relativePath = relativeRepositoryPath.parse(input);
  } catch {
    fail("PATH_ESCAPE", "Path is not canonical and relative");
  }
  if (isForbiddenPath(relativePath)) fail("FILE_NOT_ALLOWED", "Path is not allowed");
  const target = resolve(root, relativePath);
  if (!contained(root, target)) fail("PATH_ESCAPE", "Path escapes the verified workspace");
  let current: string = root;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => fail("DISCOVERY_FAILED", "Path is unavailable"));
    if (stat.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", "Symlink path component is not allowed");
  }
  const canonical = await realpath(target).catch(() =>
    fail("DISCOVERY_FAILED", "Path is unavailable"),
  );
  if (!contained(root, canonical) || canonical !== target)
    fail("SYMLINK_NOT_ALLOWED", "Canonical path changed or escaped the workspace");
  const stat = await lstat(target);
  if (requireFile && !stat.isFile()) fail("DISCOVERY_FAILED", "Path is not a regular file");
  return { relativePath, target };
}

async function verifyDirectory(
  root: VerifiedWorkspacePath,
  input?: string,
): Promise<{ relativePath: string; target: string }> {
  const relativePath = input ?? "";
  if (relativePath !== "" && isForbiddenPath(relativePath))
    fail("FILE_NOT_ALLOWED", "Path is not allowed");
  const target = relativePath === "" ? root : resolve(root, relativePath);
  if (relativePath !== "" && !contained(root, target))
    fail("PATH_ESCAPE", "Path escapes the verified workspace");
  if (relativePath !== "") {
    try {
      relativeRepositoryPath.parse(relativePath);
    } catch {
      fail("PATH_ESCAPE", "Path is not canonical and relative");
    }
  }
  let current: string = root;
  for (const part of relativePath ? relativePath.split("/") : []) {
    current = join(current, part);
    const stat = await lstat(current).catch(() =>
      fail("DISCOVERY_FAILED", "Directory is unavailable"),
    );
    if (stat.isSymbolicLink())
      fail("SYMLINK_NOT_ALLOWED", "Symlink directory component is not allowed");
  }
  const canonical = await realpath(target).catch(() =>
    fail("DISCOVERY_FAILED", "Directory is unavailable"),
  );
  if (canonical !== target || (canonical !== root && !contained(root, canonical)))
    fail("SYMLINK_NOT_ALLOWED", "Canonical directory changed or escaped the workspace");
  if (!(await lstat(target)).isDirectory()) fail("DISCOVERY_FAILED", "Path is not a directory");
  return { relativePath, target };
}

export async function verifyDiscoveryRoot(
  root: VerifiedWorkspacePath,
): Promise<VerifiedWorkspacePath> {
  try {
    return await validateWorkspaceRoot(root);
  } catch {
    fail("INVALID_ROOT", "Workspace root is not a verified dedicated root");
  }
}

export async function readSafeFile(
  root: VerifiedWorkspacePath,
  input: string,
  beforeRead?: DiscoveryReadSeam,
  budget: ScanBudget = { scannedBytes: 0, entries: 0 },
): Promise<SafeReadResult> {
  const first = await verifyPath(root, input, true);
  await beforeRead?.(first.relativePath);
  const verified = await verifyPath(root, first.relativePath, true);
  const handle = await open(verified.target, constants.O_RDONLY | noFollow).catch(() =>
    fail("DISCOVERY_FAILED", "File could not be opened safely"),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("DISCOVERY_FAILED", "Opened path is not a regular file");
    if (stat.size > DISCOVERY_LIMITS.maxFileBytes) fail("OVERSIZE", "File exceeds byte limit");
    const canonical = await realpath(verified.target).catch(() =>
      fail("DISCOVERY_FAILED", "Path changed"),
    );
    if (canonical !== verified.target || !contained(root, canonical))
      fail("SYMLINK_NOT_ALLOWED", "File path changed during read");
    const bytes = await handle.readFile();
    addBytes(budget, bytes.byteLength);
    if (isBinary(bytes)) fail("BINARY_FILE", "Binary files are not readable");
    return {
      relativePath: verified.relativePath,
      content: decoder.decode(bytes),
      digest: hash(bytes),
    };
  } finally {
    await handle.close();
  }
}

export async function listSafeTree(
  root: VerifiedWorkspacePath,
  start?: string,
  beforeRead?: DiscoveryReadSeam,
  budget: ScanBudget = { scannedBytes: 0, entries: 0 },
): Promise<readonly SafeTreeEntry[]> {
  const entries: SafeTreeEntry[] = [];
  async function visit(directory: string, depth: number, relativeDirectory: string): Promise<void> {
    if (depth > DISCOVERY_LIMITS.maxDepth) fail("OVERSIZE", "Tree depth exceeds limit");
    await verifyDirectory(root, relativeDirectory || undefined);
    await beforeRead?.(relativeDirectory);
    const verified = await verifyDirectory(root, relativeDirectory || undefined);
    const children = (await readdir(verified.target, { withFileTypes: true })).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    );
    await verifyDirectory(root, relativeDirectory || undefined);
    for (const child of children) {
      const target = join(directory, child.name);
      const relativePath = relative(root, target).split(sep).join("/");
      if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
      if (isForbiddenPath(relativePath)) continue;
      const stat = await lstat(target).catch(() =>
        fail("DISCOVERY_FAILED", "Tree changed during scan"),
      );
      addEntry(budget);
      if (stat.isSymbolicLink()) {
        entries.push({
          relativePath: relativeRepositoryPath.parse(relativePath),
          kind: "symlink",
          digest: hash(await readlink(target)),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          relativePath: relativeRepositoryPath.parse(relativePath),
          kind: "directory",
          digest: hash(relativePath),
        });
        await visit(target, depth + 1, relativePath);
      } else if (stat.isFile()) {
        const read = await readSafeFile(root, relativePath, beforeRead, budget).catch((error) => {
          if (error instanceof DiscoveryPolicyError && error.code === "BINARY_FILE")
            return undefined;
          throw error;
        });
        if (read)
          entries.push({ relativePath: read.relativePath, kind: "file", digest: read.digest });
      }
    }
  }
  const startDirectory = await verifyDirectory(root, start);
  await visit(startDirectory.target, start ? start.split("/").length : 0, start ?? "");
  return entries;
}
