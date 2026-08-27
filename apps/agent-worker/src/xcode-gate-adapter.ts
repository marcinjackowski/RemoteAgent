import { spawn } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const XCODE_OUTPUT_ROOT = ".remoteagent-xcode";
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
function relativizeXcodeDiagnostics(value: string, workspaceRoots: readonly string[]): string {
  return [...new Set(workspaceRoots)]
    .sort((left, right) => right.length - left.length)
    .reduce((current, root) => current.split(`${root}${sep}`).join(""), value);
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
        stdout: capturedStdout.value,
        stderr: capturedStderr.value,
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
            const result = await (options.processRunner ?? runXcodeProcess)(processInput);
            return {
              ...result,
              stdout: relativizeXcodeDiagnostics(result.stdout, [
                processInput.workspaceRoot,
                input.disposable_root,
              ]),
              stderr: relativizeXcodeDiagnostics(result.stderr, [
                processInput.workspaceRoot,
                input.disposable_root,
              ]),
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
