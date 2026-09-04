import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  canonicalDigest,
  relativeRepositoryPath,
  type EngineeringCompilerDiagnostic,
  type EngineeringXcodeTestDiagnostic,
} from "@remoteagent/contracts";
import {
  createTestRunner,
  testCommandManifest,
  verificationGateManifestDigest,
  verificationGateTestPhase,
  type VerificationGateDefinition,
  type VerificationGatePlatformAdapter,
  type VerificationGatePlatformRunInput,
} from "@remoteagent/test-evidence";
import {
  ProcessRunnerError,
  createWorkspacePathPolicy,
  type ProcessRunInput,
  type ProcessRunResult,
} from "@remoteagent/workspace-runner";

const OUTPUT_LIMIT = 1024 * 1024;
const STREAMED_DIAGNOSTIC_LIMIT = 64 * 1024;
const STREAMED_DIAGNOSTIC_LINE_LIMIT = 16 * 1024;
const STREAMED_DIAGNOSTIC_COUNT_LIMIT = 32;
const XCODE_OUTPUT_ROOT = ".remoteagent-xcode";
const XCODE_TEST_ACTIONS = new Set(["build-for-testing", "test", "test-without-building"]);
const XCODE_ENABLE_TESTABILITY = "ENABLE_TESTABILITY=YES";
const XCODE_SWIFTPM_CONFIGURATION = [
  "project.xcworkspace",
  "xcshareddata",
  "swiftpm",
  "configuration",
] as const;

type BoundedOutputCapture = Readonly<{
  append(chunk: Buffer): void;
  result(): Readonly<{ value: string; truncated: boolean }>;
}>;

type StreamedDiagnosticCapture = Readonly<{
  append(chunk: Buffer): void;
  result(): string;
}>;

/**
 * Keep a diagnostic head and tail without letting verbose build output grow memory.
 * Unlike the generic untrusted-command runner, this boundary executes only the exact
 * server-selected xcodebuild binary. Dropping middle bytes is safe; killing a valid build
 * merely because Xcode printed compiler invocations is not.
 */
function createBoundedOutputCapture(limit: number): BoundedOutputCapture {
  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  let head: Buffer = Buffer.alloc(0);
  let tail: Buffer = Buffer.alloc(0);
  let originalBytes = 0;

  return Object.freeze({
    append(chunk: Buffer): void {
      originalBytes += chunk.length;
      let remaining = chunk;
      if (head.length < headLimit) {
        const retained = remaining.subarray(0, headLimit - head.length);
        head = Buffer.concat([head, retained]);
        remaining = remaining.subarray(retained.length);
      }
      if (remaining.length === 0) return;
      tail =
        remaining.length >= tailLimit
          ? remaining.subarray(remaining.length - tailLimit)
          : Buffer.concat([tail, remaining]).subarray(
              Math.max(0, tail.length + remaining.length - tailLimit),
            );
    },
    result(): Readonly<{ value: string; truncated: boolean }> {
      const retainedBytes = head.length + tail.length;
      if (retainedBytes === originalBytes) {
        return { value: Buffer.concat([head, tail]).toString("utf8"), truncated: false };
      }
      const marker = `\n[REMOTEAGENT_OUTPUT_TRUNCATED original_bytes=${String(originalBytes)} retained_bytes=${String(retainedBytes)}]\n`;
      return {
        value: `${head.toString("utf8")}${marker}${tail.toString("utf8")}`,
        truncated: true,
      };
    },
  });
}

/**
 * Preserve a small diagnostic side channel while the ordinary head/tail capture remains bounded.
 * Xcode can print several megabytes of compiler invocations after the actionable Swift error and
 * before its final summary. Keeping only the stream boundaries used to erase the repository path
 * and line number, leaving the correction model to guess from `Testing failed:` prose.
 *
 * Raw lines live only in memory here. The platform adapter still relativizes the exact disposable
 * workspace prefix and the shared runner still applies its secret/host-path redactor before either
 * the receipt excerpt or artifact is persisted.
 */
function createStreamedDiagnosticCapture(): StreamedDiagnosticCapture {
  const retained: string[] = [];
  let retainedBytes = 0;
  let pending = "";
  let continuationLines = 0;
  let diagnosticCount = 0;

  const retain = (line: string): void => {
    if (retainedBytes >= STREAMED_DIAGNOSTIC_LIMIT) return;
    const remaining = STREAMED_DIAGNOSTIC_LIMIT - retainedBytes;
    const bounded = Buffer.from(line).subarray(0, remaining).toString("utf8");
    if (bounded.length === 0) return;
    retained.push(bounded);
    retainedBytes += Buffer.byteLength(bounded);
  };

  const observeLine = (line: string): void => {
    if (diagnosticCount < STREAMED_DIAGNOSTIC_COUNT_LIMIT && SWIFT_COMPILER_DIAGNOSTIC.test(line)) {
      diagnosticCount += 1;
      continuationLines = 2;
      retain(line);
      return;
    }
    if (continuationLines > 0) {
      continuationLines -= 1;
      if (line.trim().length > 0) retain(line);
    }
  };

  return Object.freeze({
    append(chunk: Buffer): void {
      const lines = `${pending}${chunk.toString("utf8")}`.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) observeLine(line);
      if (Buffer.byteLength(pending) > STREAMED_DIAGNOSTIC_LINE_LIMIT) {
        pending = Buffer.from(pending).subarray(-STREAMED_DIAGNOSTIC_LINE_LIMIT).toString("utf8");
      }
    },
    result(): string {
      if (pending.length > 0) {
        observeLine(pending);
        pending = "";
      }
      if (retained.length === 0) return "";
      return `\n[REMOTEAGENT_STREAMED_SWIFT_DIAGNOSTICS count=${String(diagnosticCount)}]\n${retained.join("\n")}\n`;
    },
  });
}

export type XcodeGateAdapterOptions = Readonly<{
  xcodebuildPath: string;
  developerDir: string;
  destination: string;
  knownSecrets?: readonly string[];
  /** Test seam only. Production leaves this undefined and uses the bounded process boundary. */
  processRunner?: (input: ProcessRunInput) => Promise<ProcessRunResult>;
}>;

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function exactArg(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || index !== args.lastIndexOf(flag) || index + 1 >= args.length) {
    throw new Error(`Xcode gate requires exactly one ${flag}`);
  }
  return args[index + 1]!;
}

/**
 * Non-Debug schemes may legally compile an application module without `-enable-testing` even
 * when xcodebuild was asked to run tests. Xcode then spends the full build budget before the test
 * target fails to import its own module. Keep that deployment error out of the model correction
 * loop by requiring the server-owned test command to make testability explicit.
 */
function assertExplicitXcodeTestability(args: readonly string[]): void {
  if (!args.some((argument) => XCODE_TEST_ACTIONS.has(argument))) return;
  if (args.includes("-quiet")) {
    throw new Error("Xcode test gate must preserve diagnostic output and cannot use -quiet");
  }
  const settings = args.filter((argument) => argument.startsWith("ENABLE_TESTABILITY="));
  if (settings.length !== 1 || settings[0] !== XCODE_ENABLE_TESTABILITY) {
    throw new Error("Xcode test gate requires exactly one ENABLE_TESTABILITY=YES setting");
  }
}

/**
 * Resolve the simulator destination from the same server-owned gate catalogue that will be
 * executed. The live harness used to accept a second environment value for this field; a typo in
 * that duplicate value spent a full model run before the adapter correctly refused the mismatch.
 * Keeping one authority makes the refusal happen during composition, before any model call.
 */
export function xcodeDestinationFromGateCatalog(
  definitions: readonly VerificationGateDefinition[],
  xcodebuildPath: string,
): string {
  const candidates = definitions.filter(
    (definition) =>
      definition.environment_profile === "BUILD_TOOLCHAIN" &&
      definition.network_profile === "PLATFORM_MANAGED" &&
      definition.executable === xcodebuildPath,
  );
  if (candidates.length === 0) {
    throw new Error("Xcode gate catalog has no server-selected simulator destination");
  }
  for (const candidate of candidates) assertExplicitXcodeTestability(candidate.argv);
  const testCommands = candidates
    .filter((candidate) => candidate.argv.some((argument) => XCODE_TEST_ACTIONS.has(argument)))
    .map((candidate) =>
      canonicalDigest({
        executable: candidate.executable,
        argv: candidate.argv,
        relative_cwd: candidate.relative_cwd,
      }),
    );
  if (new Set(testCommands).size !== testCommands.length) {
    throw new Error("Xcode gate catalog contains a duplicate test command");
  }
  const destinations = new Set(
    candidates.map((definition) => exactArg(definition.argv, "-destination")),
  );
  if (destinations.size !== 1) {
    throw new Error("Xcode gate catalog has conflicting simulator destinations");
  }
  return [...destinations][0]!;
}

async function xcodeSwiftPmConfigurationPath(
  disposableRoot: string,
  relativeCwd: string,
  args: readonly string[],
): Promise<Readonly<{ path: string; existed: boolean }>> {
  const projectArgument = exactArg(args, "-project");
  if (
    isAbsolute(projectArgument) ||
    !projectArgument.endsWith(".xcodeproj") ||
    projectArgument
      .split(/[\\/]/u)
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Xcode gate project must be a canonical relative .xcodeproj path");
  }
  const gateCwd = await realpath(join(disposableRoot, relativeCwd));
  const projectRoot = await realpath(resolve(gateCwd, projectArgument));
  if (!contained(gateCwd, projectRoot)) {
    throw new Error("Xcode gate project escapes its disposable working directory");
  }
  const path = join(projectRoot, ...XCODE_SWIFTPM_CONFIGURATION);
  const parent = await realpath(dirname(path));
  if (!contained(projectRoot, parent)) {
    throw new Error("Xcode SwiftPM configuration parent escapes the selected project");
  }
  const existing = await lstat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("Xcode SwiftPM configuration path has an unsafe type");
  }
  return Object.freeze({ path, existed: existing !== undefined });
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Keep compiler locations useful without exposing the disposable host root. The generic runner
 * still performs the final secret/absolute-path redaction, so only the exact workspace prefix is
 * converted to a repository-relative diagnostic before that boundary.
 */
function relativizeXcodeDiagnostics(
  value: string,
  workspaceRoots: readonly string[],
  swiftSourcePaths: readonly string[],
): string {
  const rooted = [...new Set(workspaceRoots)]
    .sort((left, right) => right.length - left.length)
    .reduce((current, root) => current.split(`${root}${sep}`).join(""), value);
  return rooted
    .split(/\r?\n/u)
    .map((line) => {
      const match = SWIFT_COMPILER_DIAGNOSTIC.exec(line);
      if (match === null || !isAbsolute(match[1]!)) return line;
      const candidates = swiftSourcePaths.filter((path) => match[1]!.endsWith(`/${path}`));
      if (candidates.length !== 1) return line;
      return `${candidates[0]!}${line.slice(match[1]!.length)}`;
    })
    .join("\n");
}

async function collectSwiftSourcePaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const directories = [""];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) directories.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".swift")) {
        paths.push(candidate.split(sep).join("/"));
      }
      if (paths.length > 20_000) throw new Error("Xcode source inventory exceeds policy bound");
    }
  }
  return Object.freeze(paths.sort());
}

const SWIFT_COMPILER_DIAGNOSTIC = /^(.+?\.swift):(\d+):(\d+):\s+(?:fatal\s+)?error:\s+(.+)$/u;
const XCTEST_ASSERTION_DIAGNOSTIC = /^(.+?\.swift):(\d+):\s+error:\s+(-\[[^\]]+\])\s*:\s*(.+)$/u;
const XCTEST_CASE_FAILURE = /^Test [Cc]ase '([^']+)' failed(?: \([^)]+\))?\.?$/u;
const SWIFT_TESTING_FAILURE = /^[^\n]*(?:✘|✗)\s+(?:Test|Suite)\b[^\n]*\bfailed\b/iu;
const XCODE_TESTING_FAILED_HEADER = /^Testing failed:\s*$/u;
const XCODE_TRANSIENT_DEPENDENCY_FAILURES = [
  /Could not resolve package dependencies/iu,
  /Failed to clone repository/iu,
  /expected flush after ref listing/iu,
  /RPC failed;.*(?:curl|HTTP)/iu,
  /fatal:\s+the remote end hung up unexpectedly/iu,
] as const;

function isTransientXcodeDependencyFailure(result: ProcessRunResult): boolean {
  if (
    result.exitCode === 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.cancelled ||
    result.outputTruncated
  ) {
    return false;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return XCODE_TRANSIENT_DEPENDENCY_FAILURES.some((pattern) => pattern.test(output));
}

/** Retry once only when Xcode itself reports failure but names no code/test failure. */
export function shouldRetryUninformativeXcodeTest(
  args: readonly string[],
  result: ProcessRunResult,
): boolean {
  if (
    !args.some((argument) => XCODE_TEST_ACTIONS.has(argument)) ||
    result.signal !== null ||
    result.timedOut ||
    result.cancelled ||
    result.outputTruncated
  ) {
    return false;
  }
  if (isTransientXcodeDependencyFailure(result)) return true;
  if (result.exitCode !== 65) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes("** TEST FAILED **")) return false;
  return !output
    .split(/\r?\n/u)
    .some(
      (line) =>
        SWIFT_COMPILER_DIAGNOSTIC.test(line) ||
        XCTEST_ASSERTION_DIAGNOSTIC.test(line) ||
        XCTEST_CASE_FAILURE.test(line) ||
        SWIFT_TESTING_FAILURE.test(line),
    );
}

/**
 * Extract only canonical repository-relative Swift compiler locations. The raw build log remains
 * UNTRUSTED_DATA in the artifact store; this projection is bounded, digest-bound and contains no
 * host path. Source/caret lines immediately following the diagnostic are retained only as a small
 * repair excerpt.
 */
export function parseXcodeCompilerDiagnostics(
  value: string,
): readonly EngineeringCompilerDiagnostic[] {
  const lines = value.split(/\r?\n/u);
  const diagnostics = new Map<string, EngineeringCompilerDiagnostic>();
  for (let index = 0; index < lines.length && diagnostics.size < 32; index += 1) {
    const raw = lines[index] ?? "";
    const match = SWIFT_COMPILER_DIAGNOSTIC.exec(raw);
    if (match === null) continue;
    const parsedPath = relativeRepositoryPath.safeParse(match[1]?.replace(/^\.\//u, ""));
    const line = Number(match[2]);
    const column = Number(match[3]);
    const message = match[4]?.trim().slice(0, 2048) ?? "";
    if (
      !parsedPath.success ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      !Number.isSafeInteger(column) ||
      column < 1 ||
      message.length === 0
    ) {
      continue;
    }
    const continuation: string[] = [];
    for (let offset = 1; offset <= 2; offset += 1) {
      const candidate = lines[index + offset];
      if (candidate === undefined || SWIFT_COMPILER_DIAGNOSTIC.test(candidate)) break;
      if (candidate.trim().length > 0) continuation.push(candidate);
    }
    const excerpt = [raw, ...continuation].join("\n").trim().slice(0, 4096);
    if (excerpt.length === 0) continue;
    const identity = {
      path: parsedPath.data,
      line,
      column,
      message,
      excerpt,
    };
    const diagnostic = Object.freeze({
      ...identity,
      digest: canonicalDigest(identity),
    });
    diagnostics.set(diagnostic.digest, diagnostic);
  }
  return Object.freeze([...diagnostics.values()]);
}

/**
 * Project stable XCTest identities out of verbose xcodebuild output. `-quiet` deliberately drops
 * these lines, which previously reduced every correction to the useless `TEST FAILED` marker and
 * made timestamp-varying whole-log digests look like progress. Paths are accepted only after the
 * adapter has converted the disposable workspace prefix to a repository-relative value.
 */
export function parseXcodeTestDiagnostics(
  value: string,
): readonly EngineeringXcodeTestDiagnostic[] {
  const diagnostics = new Map<string, EngineeringXcodeTestDiagnostic>();
  let testingFailedSummary = false;
  for (const raw of value.split(/\r?\n/u)) {
    if (diagnostics.size >= 32) break;
    if (XCODE_TESTING_FAILED_HEADER.test(raw.trim())) {
      testingFailedSummary = true;
      continue;
    }
    if (testingFailedSummary) {
      const message = raw
        .trim()
        .replace(/^[-\u2022]\s*/u, "")
        .slice(0, 4096);
      if (
        message.length === 0 ||
        message.startsWith("** TEST ") ||
        message === "The following build commands failed:"
      ) {
        testingFailedSummary = false;
      } else {
        const identity = {
          test_name: "XCODE_TEST_BUILD",
          message,
          path: null,
          line: null,
        };
        const diagnostic = Object.freeze({ ...identity, digest: canonicalDigest(identity) });
        diagnostics.set(diagnostic.digest, diagnostic);
        continue;
      }
    }
    const assertion = XCTEST_ASSERTION_DIAGNOSTIC.exec(raw);
    if (assertion !== null) {
      const parsedPath = relativeRepositoryPath.safeParse(assertion[1]?.replace(/^\.\//u, ""));
      const line = Number(assertion[2]);
      const testName = assertion[3]?.trim().slice(0, 1024) ?? "";
      const message = assertion[4]?.trim().slice(0, 4096) ?? "";
      if (
        parsedPath.success &&
        Number.isSafeInteger(line) &&
        line > 0 &&
        testName.length > 0 &&
        message.length > 0
      ) {
        const identity = {
          test_name: testName,
          message,
          path: parsedPath.data,
          line,
        };
        const diagnostic = Object.freeze({ ...identity, digest: canonicalDigest(identity) });
        diagnostics.set(diagnostic.digest, diagnostic);
      }
      continue;
    }
    const failedCase = XCTEST_CASE_FAILURE.exec(raw);
    const testName = failedCase?.[1]?.trim().slice(0, 1024) ?? "";
    if (testName.length === 0) continue;
    const identity = {
      test_name: testName,
      message: "Test case failed",
      path: null,
      line: null,
    };
    const diagnostic = Object.freeze({ ...identity, digest: canonicalDigest(identity) });
    diagnostics.set(diagnostic.digest, diagnostic);
  }
  return Object.freeze([...diagnostics.values()]);
}

/**
 * Xcode cannot run inside the generic sandbox profile: it spawns compiler services and uses
 * simulator state. This boundary is deliberately narrower instead of pretending HERMETIC:
 * canonical xcodebuild only, argv (never a shell), one disposable cwd, controlled HOME/TMPDIR,
 * bounded output, timeout/cancellation and a server-selected destination.
 */
async function runXcodeProcess(input: ProcessRunInput): Promise<ProcessRunResult> {
  if (!Number.isFinite(input.limits.timeoutMs) || input.limits.timeoutMs <= 0) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Xcode timeout must be positive");
  }
  if (input.args.some((argument) => argument.includes("\0"))) {
    throw new ProcessRunnerError("INVALID_COMMAND", "Xcode argv must be NUL-free");
  }
  const policy = await createWorkspacePathPolicy(input.workspaceRoot);
  const cwd = await policy.validateCommandCwd(input.cwd);
  await policy.validateCommandCwd(input.cwd);
  const canonicalExecutable = await realpath(input.executable).catch(() => undefined);
  if (canonicalExecutable === undefined || canonicalExecutable !== input.executable) {
    throw new ProcessRunnerError("INVALID_COMMAND", "xcodebuild must be canonical");
  }
  if (input.signal?.aborted === true) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      outputTruncated: false,
    };
  }

  return new Promise((resolveResult, reject) => {
    const stdout = createBoundedOutputCapture(OUTPUT_LIMIT / 2);
    const stderr = createBoundedOutputCapture(OUTPUT_LIMIT / 2);
    const stdoutDiagnostics = createStreamedDiagnosticCapture();
    const stderrDiagnostics = createStreamedDiagnosticCapture();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(input.executable, [...input.args], {
      cwd,
      env: { ...(input.env ?? {}) },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      (target === "stdout" ? stdout : stderr).append(chunk);
      (target === "stdout" ? stdoutDiagnostics : stderrDiagnostics).append(chunk);
    };
    const finish = (): void => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (reason: "timeout" | "cancel"): void => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      killTree(child);
    };
    function onAbort(): void {
      terminate("cancel");
    }
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(new ProcessRunnerError("SPAWN_FAILED", error.message));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      finish();
      const capturedStdout = stdout.result();
      const capturedStderr = stderr.result();
      resolveResult({
        exitCode,
        signal,
        stdout: `${capturedStdout.value}${stdoutDiagnostics.result()}`,
        stderr: `${capturedStderr.value}${stderrDiagnostics.result()}`,
        timedOut,
        cancelled,
        outputTruncated: capturedStdout.truncated || capturedStderr.truncated,
      });
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted === true) onAbort();
    const timer = setTimeout(() => terminate("timeout"), input.limits.timeoutMs);
    timer.unref();
  });
}

export async function createXcodeVerificationGatePlatformAdapter(
  options: XcodeGateAdapterOptions,
): Promise<VerificationGatePlatformAdapter> {
  const xcodebuildPath = await realpath(options.xcodebuildPath);
  const developerDir = await realpath(options.developerDir);
  if (!contained(developerDir, xcodebuildPath)) {
    throw new Error("xcodebuild must belong to the selected developer directory");
  }
  if (options.destination.trim().length === 0) throw new Error("Xcode destination is required");

  return Object.freeze({
    run: async (input: VerificationGatePlatformRunInput) => {
      const definition = input.definition;
      if (
        definition.environment_profile !== "BUILD_TOOLCHAIN" ||
        definition.network_profile !== "PLATFORM_MANAGED"
      ) {
        throw new Error("Xcode adapter accepts only BUILD_TOOLCHAIN + PLATFORM_MANAGED gates");
      }
      if ((await realpath(definition.executable)) !== xcodebuildPath) {
        throw new Error("Xcode gate executable is not the server-selected xcodebuild");
      }
      assertExplicitXcodeTestability(definition.argv);
      const relativeOutputRoot = `${definition.relative_cwd}/${XCODE_OUTPUT_ROOT}`;
      if (
        definition.mutable_outputs.length !== 1 ||
        definition.mutable_outputs[0] !== relativeOutputRoot
      ) {
        throw new Error(`Xcode gate mutable output must be exactly ${relativeOutputRoot}`);
      }
      if (exactArg(definition.argv, "-destination") !== options.destination) {
        throw new Error("Xcode gate destination differs from the server-selected simulator");
      }
      const derivedData = exactArg(definition.argv, "-derivedDataPath");
      const sourcePackages = exactArg(definition.argv, "-clonedSourcePackagesDirPath");
      for (const [label, value] of [
        ["DerivedData", derivedData],
        ["SourcePackages", sourcePackages],
      ] as const) {
        const gateCwd = join(input.disposable_root, definition.relative_cwd);
        const resolved = resolve(gateCwd, value);
        const outputRoot = join(gateCwd, XCODE_OUTPUT_ROOT);
        if (!contained(outputRoot, resolved) || resolved === outputRoot) {
          throw new Error(`${label} must be below the disposable Xcode output root`);
        }
      }

      const outputRoot = join(input.disposable_root, definition.relative_cwd, XCODE_OUTPUT_ROOT);
      const home = join(outputRoot, "Home");
      const temporary = join(outputRoot, "Tmp");
      const canonicalDisposableRoot = await realpath(input.disposable_root).catch(
        () => input.disposable_root,
      );
      const swiftSourcePaths = await collectSwiftSourcePaths(canonicalDisposableRoot);
      const swiftPmConfiguration = await xcodeSwiftPmConfigurationPath(
        input.disposable_root,
        definition.relative_cwd,
        definition.argv,
      );
      const manifest = testCommandManifest.parse({
        schema_version: 1,
        manifest_id: `verification-${definition.gate_id}`,
        digest: verificationGateManifestDigest(definition),
        entries: [
          {
            name: definition.gate_id,
            phase: verificationGateTestPhase(definition),
            executable: definition.executable,
            argv: definition.argv,
            relative_cwd: definition.relative_cwd,
            timeout_ms: definition.timeout_ms,
            required: true,
          },
        ],
      });
      const environment = Object.freeze({
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        HOME: home,
        TMPDIR: temporary,
        DEVELOPER_DIR: developerDir,
        PATH: `${join(developerDir, "usr", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      });
      const runner = await createTestRunner({
        root: input.disposable_root,
        scope: input.scope,
        manifest,
        store: input.store,
        knownSecrets: options.knownSecrets ?? [],
        environment,
        processRunner: async (processInput) => {
          let createdSwiftPmConfiguration = false;
          try {
            // The shared runner binds its receipt to the tree immediately before this
            // callback. Creating disposable HOME/TMPDIR earlier would make the adapter's
            // own scratch directories look like a source mutation and invalidate an
            // otherwise honest platform receipt.
            await Promise.all([home, temporary].map((path) => mkdir(path, { recursive: true })));
            if (!swiftPmConfiguration.existed) {
              await mkdir(swiftPmConfiguration.path);
              createdSwiftPmConfiguration = true;
            }
            const execute = options.processRunner ?? runXcodeProcess;
            const first = await execute(processInput);
            const retried = shouldRetryUninformativeXcodeTest(definition.argv, first);
            const result = retried ? await execute(processInput) : first;
            if (
              retried &&
              isTransientXcodeDependencyFailure(first) &&
              isTransientXcodeDependencyFailure(result)
            ) {
              throw new Error("Xcode dependency resolution remained unavailable after retry");
            }
            const retryMarker = retried
              ? `[REMOTEAGENT_XCODE_INFRASTRUCTURE_RETRY first_result_digest=${canonicalDigest({
                  exit_code: first.exitCode,
                  stdout: first.stdout,
                  stderr: first.stderr,
                })}]\n`
              : "";
            return {
              ...result,
              stdout: relativizeXcodeDiagnostics(
                `${retryMarker}${result.stdout}`,
                [processInput.workspaceRoot, input.disposable_root, canonicalDisposableRoot],
                swiftSourcePaths,
              ),
              stderr: relativizeXcodeDiagnostics(
                result.stderr,
                [processInput.workspaceRoot, input.disposable_root, canonicalDisposableRoot],
                swiftSourcePaths,
              ),
            };
          } finally {
            // DerivedData, package checkouts and the isolated HOME are build outputs, not
            // source evidence. Remove the exact validated disposable root before the shared
            // runner computes its post-tree digest; stdout/stderr are already held in memory.
            await rm(outputRoot, { recursive: true, force: true });
            // Xcode creates this empty/untracked SwiftPM directory even when package checkouts
            // and DerivedData are redirected. It is deterministic tool scratch, not source.
            // Only remove the exact directory when this invocation created it; a pre-existing
            // directory remains protected and any change beneath it invalidates the receipt.
            if (createdSwiftPmConfiguration) {
              await rm(swiftPmConfiguration.path, { recursive: true, force: true });
            }
          }
        },
      });
      return runner.run({
        command_name: definition.gate_id,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  });
}
