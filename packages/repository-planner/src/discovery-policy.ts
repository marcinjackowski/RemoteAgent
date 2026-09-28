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
  maxFilenameEntries: 8_192,
  maxDepth: 32,
  maxResults: 128,
});

export type DiscoveryErrorCode =
  | "INVALID_ROOT"
  | "PATH_ESCAPE"
  | "SYMLINK_NOT_ALLOWED"
  | "FILE_NOT_ALLOWED"
  | "BINARY_FILE"
  | "FILE_NOT_FOUND"
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
export type SafeSearchMatch = Readonly<{
  relativePath: RelativeRepositoryPath;
  digest: string;
  line: number;
  content: string;
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
  missingCode: "FILE_NOT_FOUND" | "DISCOVERY_FAILED" = "FILE_NOT_FOUND",
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
  const canonicalRoot = await realpath(root).catch(() =>
    fail("DISCOVERY_FAILED", "Workspace root is unavailable"),
  );
  if (canonicalRoot !== root) fail("SYMLINK_NOT_ALLOWED", "Workspace root changed");
  let current: string = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail(
          index === segments.length - 1 ? missingCode : "DISCOVERY_FAILED",
          "File is not present",
        );
      fail("DISCOVERY_FAILED", "Path is unavailable");
    });
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
  const verified = await verifyPath(root, first.relativePath, true, "DISCOVERY_FAILED");
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

/** Read a bounded line window while retaining the digest of the complete file. */
export async function readSafeFileExcerpt(
  root: VerifiedWorkspacePath,
  input: string,
  startLine: number,
  endLine: number,
  beforeRead?: DiscoveryReadSeam,
  budget: ScanBudget = { scannedBytes: 0, entries: 0 },
): Promise<
  Readonly<{
    relativePath: RelativeRepositoryPath;
    content: string;
    digest: string;
    startLine: number;
    endLine: number;
    endOfFile: boolean;
  }>
> {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    fail("DISCOVERY_FAILED", "Excerpt range is invalid");
  const result = await readSafeFile(root, input, beforeRead, budget);
  const starts = [0];
  const delimiters: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < result.content.length; index += 1) {
    if (result.content[index] === "\n") {
      const delimiterStart = index > 0 && result.content[index - 1] === "\r" ? index - 1 : index;
      delimiters.push({ start: delimiterStart, end: index + 1 });
      starts.push(index + 1);
    }
  }
  // A trailing newline terminates the final physical line; it does not create an extra
  // addressable empty line for excerpt coordinates.
  const lineCount =
    result.content.length > 0 && result.content.endsWith("\n") ? starts.length - 1 : starts.length;
  if (startLine > lineCount) fail("DISCOVERY_FAILED", "Excerpt starts beyond file");
  const boundedEnd = Math.min(endLine, lineCount);
  const startOffset = starts[startLine - 1]!;
  const terminatingDelimiter = delimiters[boundedEnd - 1];
  const endOffset =
    terminatingDelimiter === undefined || boundedEnd < lineCount
      ? (starts[boundedEnd] ?? result.content.length)
      : terminatingDelimiter.end;
  const content = result.content.slice(startOffset, endOffset);
  return {
    relativePath: result.relativePath,
    content,
    digest: result.digest,
    startLine,
    endLine: boundedEnd,
    endOfFile: boundedEnd === lineCount,
  };
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
      const parsedPath = relativeRepositoryPath.safeParse(relativePath);
      if (!parsedPath.success) continue;
      const stat = await lstat(target).catch(() =>
        fail("DISCOVERY_FAILED", "Tree changed during scan"),
      );
      addEntry(budget);
      if (stat.isSymbolicLink()) {
        entries.push({
          relativePath: parsedPath.data,
          kind: "symlink",
          digest: hash(await readlink(target)),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          relativePath: parsedPath.data,
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

/**
 * Find canonical paths by filename without reading every file in a large repository.
 *
 * This is deliberately a separate, filename-only budget. A repository may contain filenames
 * (for example SwiftGen's `Strings+Generated.swift`) that the narrower model-facing path contract
 * cannot represent. Such entries and their subtrees are not exposed or followed, but they also do
 * not make an unrelated canonical lookup fail. Symlinks are named but never traversed, and a
 * matching regular file is re-verified and read once so its provenance digest remains content-based.
 */
export async function findSafeFilenames(
  root: VerifiedWorkspacePath,
  query: string,
  beforeRead?: DiscoveryReadSeam,
): Promise<readonly SafeTreeEntry[]> {
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  const matches: SafeTreeEntry[] = [];
  let entries = 0;

  async function visit(relativeDirectory: string, depth: number): Promise<void> {
    if (depth > DISCOVERY_LIMITS.maxDepth) fail("OVERSIZE", "Tree depth exceeds limit");
    const first = await verifyDirectory(root, relativeDirectory || undefined);
    await beforeRead?.(relativeDirectory);
    const verified = await verifyDirectory(root, relativeDirectory || undefined);
    const children = (await readdir(verified.target, { withFileTypes: true })).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    );
    await verifyDirectory(root, relativeDirectory || undefined);
    for (const child of children) {
      if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
      const target = join(first.target, child.name);
      const candidate = relative(root, target).split(sep).join("/");
      if (isForbiddenPath(candidate)) continue;
      const parsed = relativeRepositoryPath.safeParse(candidate);
      // An unrepresentable path can never be returned to or requested by the model. Skipping an
      // unrepresentable directory also prevents accidentally exposing representable descendants
      // through a path the model-facing boundary itself could not validate.
      if (!parsed.success) continue;
      entries += 1;
      if (entries > DISCOVERY_LIMITS.maxFilenameEntries)
        fail("OVERSIZE", "Filename lookup entry limit exceeded");
      const stat = await lstat(target).catch(() =>
        fail("DISCOVERY_FAILED", "Tree changed during filename lookup"),
      );
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await visit(parsed.data, depth + 1);
        continue;
      }
      if (!stat.isFile() || !parsed.data.toLocaleLowerCase("en-US").includes(normalizedQuery))
        continue;
      const read = await readSafeFile(root, parsed.data, beforeRead).catch((error) => {
        if (error instanceof DiscoveryPolicyError && error.code === "BINARY_FILE") return undefined;
        throw error;
      });
      if (read === undefined) continue;
      matches.push({ relativePath: read.relativePath, kind: "file", digest: read.digest });
      if (matches.length >= DISCOVERY_LIMITS.maxResults)
        fail("OVERSIZE", "Filename result limit exceeded");
    }
  }

  await visit("", 0);
  return entries === 0 ? Object.freeze([]) : Object.freeze(matches);
}

/**
 * Return matches from the first safely readable file containing the query.
 *
 * Search is a bounded locator, not an exhaustive repository export. Stopping after the first
 * matching file avoids repeatedly carrying the same broad result set into a model conversation,
 * while deterministic byte/entry/depth limits still fail closed when no match is found in budget.
 */
export async function searchSafeText(
  root: VerifiedWorkspacePath,
  query: string,
  beforeRead?: DiscoveryReadSeam,
): Promise<readonly SafeSearchMatch[]> {
  const budget: ScanBudget = { scannedBytes: 0, entries: 0 };
  let visitedEntries = 0;

  async function visit(relativeDirectory: string, depth: number): Promise<SafeSearchMatch[]> {
    if (depth > DISCOVERY_LIMITS.maxDepth) fail("OVERSIZE", "Tree depth exceeds limit");
    const first = await verifyDirectory(root, relativeDirectory || undefined);
    await beforeRead?.(relativeDirectory);
    const verified = await verifyDirectory(root, relativeDirectory || undefined);
    const children = (await readdir(verified.target, { withFileTypes: true })).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    );
    await verifyDirectory(root, relativeDirectory || undefined);
    for (const child of children) {
      if (child.isDirectory() && SKIPPED_DIRECTORIES.has(child.name)) continue;
      const target = join(first.target, child.name);
      const candidate = relative(root, target).split(sep).join("/");
      if (isForbiddenPath(candidate)) continue;
      const parsed = relativeRepositoryPath.safeParse(candidate);
      if (!parsed.success) continue;
      visitedEntries += 1;
      if (visitedEntries > DISCOVERY_LIMITS.maxFilenameEntries)
        fail("OVERSIZE", "Text search entry limit exceeded");
      const stat = await lstat(target).catch(() =>
        fail("DISCOVERY_FAILED", "Tree changed during text search"),
      );
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const nested = await visit(parsed.data, depth + 1);
        if (nested.length > 0) return nested;
        continue;
      }
      if (!stat.isFile()) continue;
      const read = await readSafeFile(root, parsed.data, beforeRead, budget).catch((error) => {
        if (error instanceof DiscoveryPolicyError && error.code === "BINARY_FILE") return undefined;
        throw error;
      });
      if (read === undefined) continue;
      const matches: SafeSearchMatch[] = [];
      for (const [index, line] of read.content.split(/\r?\n/u).entries()) {
        if (!line.includes(query)) continue;
        matches.push({
          relativePath: read.relativePath,
          digest: read.digest,
          line: index + 1,
          content: line,
        });
        if (matches.length >= DISCOVERY_LIMITS.maxResults)
          fail("OVERSIZE", "Search result limit exceeded");
      }
      if (matches.length > 0) return matches;
    }
    return [];
  }

  return Object.freeze(await visit("", 0));
}
