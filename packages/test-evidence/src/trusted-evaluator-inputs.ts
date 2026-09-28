import { createHash } from "node:crypto";

import { relativeRepositoryPath } from "@remoteagent/contracts";

export const TRUSTED_EVALUATOR_MAX_FILES = 16;
export const TRUSTED_EVALUATOR_MAX_FILE_BYTES = 64 * 1024;
export const TRUSTED_EVALUATOR_MAX_TOTAL_BYTES = 256 * 1024;
export const TRUSTED_EVALUATOR_MAX_TEST_IDS = 128;
export const TRUSTED_EVALUATOR_UI_LAYOUT = "XCODE_UI_HARNESS_V1" as const;

export type TrustedEvaluatorInputFile = Readonly<{
  relative_path: string;
  content: string;
  content_digest: string;
}>;

export type TrustedEvaluatorInputs = Readonly<{
  files: readonly TrustedEvaluatorInputFile[];
  required_executed_test_ids: readonly string[];
  layout?: typeof TRUSTED_EVALUATOR_UI_LAYOUT;
}>;

export type TrustedEvaluatorInputsSnapshot = Readonly<{
  files: readonly TrustedEvaluatorInputFile[];
  required_executed_test_ids: readonly string[];
  layout?: typeof TRUSTED_EVALUATOR_UI_LAYOUT;
  digest: string;
  total_bytes: number;
}>;

export class TrustedEvaluatorInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TrustedEvaluatorInputError";
  }
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function invalid(): never {
  throw new TrustedEvaluatorInputError("Invalid trusted evaluator inputs");
}

function canonicalTestId(id: string): string {
  const parts = id.split("/");
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0 || /\s/u.test(part) || /[*?]/u.test(part))
  )
    return invalid();
  const method = parts[2]!.replace(/\(\)$/u, "");
  if (method.length === 0 || /[*?\s]/u.test(method)) return invalid();
  return `${parts[0]}/${parts[1]}/${method}`;
}

function canonicalPath(path: string): string {
  if (
    !relativeRepositoryPath.safeParse(path).success ||
    path.split("/").some((part) => part.toLowerCase() === ".git" || part.length === 0) ||
    !/\.swift$/u.test(path) ||
    !(path.startsWith("Tests/") || path.includes("/Tests/"))
  )
    return invalid();
  return path;
}

function canonicalUiPath(path: string): string {
  if (
    !relativeRepositoryPath.safeParse(path).success ||
    path
      .split("/")
      .some(
        (part) =>
          part.toLowerCase() === ".git" || part.length === 0 || part === "." || part === "..",
      )
  )
    return invalid();
  return path;
}

const uiHarnessRequiredSuffixes = [
  "App/RemoteAgentUIHarnessApp.swift",
  "UITests/RemoteAgentUIHarnessUITests.swift",
  "RemoteAgentUIHarness.xcodeproj/project.pbxproj",
  "RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme",
] as const;

const uiHarnessPackageResolvedSuffix =
  "RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";

function validateUiHarnessLayout(
  files: readonly TrustedEvaluatorInputFile[],
  requiredIds: readonly string[],
): typeof TRUSTED_EVALUATOR_UI_LAYOUT {
  const roots = new Set<string>();
  for (const suffix of uiHarnessRequiredSuffixes) {
    const matches = files.filter((file) =>
      file.relative_path.endsWith(`Tests/RemoteAgentUIHarness/${suffix}`),
    );
    if (matches.length !== 1) return invalid();
    roots.add(matches[0]!.relative_path.slice(0, -suffix.length));
  }
  if (roots.size !== 1) return invalid();
  const root = [...roots][0]!;
  const rootParts = root.slice(0, -1).split("/");
  if (
    rootParts.at(-1) !== "RemoteAgentUIHarness" ||
    rootParts.at(-2) !== "Tests" ||
    rootParts.some((part) => part === "." || part === "..")
  )
    return invalid();
  const rootPrefix = root.slice(0, -1);
  const requiredPaths = new Set(
    uiHarnessRequiredSuffixes.map((suffix) => `${rootPrefix}/${suffix}`),
  );
  const packageResolvedPath = `${rootPrefix}/${uiHarnessPackageResolvedSuffix}`;
  for (const file of files) {
    if (requiredPaths.has(file.relative_path)) continue;
    if (file.relative_path === packageResolvedPath) continue;
    if (
      !file.relative_path.startsWith(`${rootPrefix}/App/`) &&
      !file.relative_path.startsWith(`${rootPrefix}/UITests/`)
    )
      return invalid();
    if (!file.relative_path.endsWith(".swift")) return invalid();
  }
  if (requiredIds.some((id) => id.split("/")[0] !== "RemoteAgentUIHarnessUITests"))
    return invalid();
  return TRUSTED_EVALUATOR_UI_LAYOUT;
}

/** Validate and freeze a deterministic server-owned evaluator input snapshot. */
export function validateTrustedEvaluatorInputs(input: unknown): TrustedEvaluatorInputsSnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  const raw = input as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) => !["files", "required_executed_test_ids", "layout"].includes(key),
    ) ||
    !Array.isArray(raw.files) ||
    raw.files.length < 1 ||
    raw.files.length > TRUSTED_EVALUATOR_MAX_FILES
  )
    return invalid();
  if (
    !Array.isArray(raw.required_executed_test_ids) ||
    raw.required_executed_test_ids.length < 1 ||
    raw.required_executed_test_ids.length > TRUSTED_EVALUATOR_MAX_TEST_IDS
  )
    return invalid();
  const files = Array.from(raw.files, (candidate: unknown) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return invalid();
    const file = candidate as Record<string, unknown>;
    if (
      Object.keys(file).some(
        (key) => !["relative_path", "content", "content_digest"].includes(key),
      ) ||
      typeof file.relative_path !== "string" ||
      typeof file.content !== "string" ||
      typeof file.content_digest !== "string"
    )
      return invalid();
    const path =
      raw.layout === TRUSTED_EVALUATOR_UI_LAYOUT
        ? canonicalUiPath(file.relative_path)
        : canonicalPath(file.relative_path);
    if (Buffer.from(file.content).toString("utf8") !== file.content) return invalid();
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > TRUSTED_EVALUATOR_MAX_FILE_BYTES) return invalid();
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(file.content_digest) ||
      sha256(file.content) !== file.content_digest
    )
      return invalid();
    return Object.freeze({
      relative_path: path,
      content: file.content,
      content_digest: file.content_digest,
    });
  });
  const paths = files.map((file) => file.relative_path);
  if (new Set(paths).size !== paths.length) return invalid();
  for (const path of paths)
    if (paths.some((other) => other !== path && other.startsWith(`${path}/`))) return invalid();
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  if (totalBytes > TRUSTED_EVALUATOR_MAX_TOTAL_BYTES) return invalid();
  const required = Array.from(raw.required_executed_test_ids, (id: unknown) => {
    if (typeof id !== "string" || id.length > 512) return invalid();
    return canonicalTestId(id);
  }).sort();
  if (new Set(required).size !== required.length) return invalid();
  const sortedFiles = [...files].sort((a, b) =>
    a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0,
  );
  const layout =
    raw.layout === undefined
      ? undefined
      : raw.layout === TRUSTED_EVALUATOR_UI_LAYOUT
        ? validateUiHarnessLayout(files, required)
        : invalid();
  const snapshotBase = {
    files: Object.freeze(sortedFiles),
    required_executed_test_ids: Object.freeze(required),
    total_bytes: totalBytes,
  };
  const snapshot = layout === undefined ? snapshotBase : { ...snapshotBase, layout };
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")}`;
  return Object.freeze({ ...snapshot, digest });
}

export function trustedEvaluatorInputsDigest(input: TrustedEvaluatorInputs): string {
  return validateTrustedEvaluatorInputs(input).digest;
}
