/**
 * The verification runner: execute a manifest entry and mint a `TestRun` receipt.
 *
 * This module owns the one decision the whole task turns on — **how a process
 * result becomes an outcome** — and it is deliberately the only place that
 * constructs a {@link TestRun}. A model names a manifest entry; it never supplies
 * an outcome, an exit code or a duration.
 *
 * No second process runner. `runProcess` from `@remoteagent/workspace-runner`
 * already owns argv-not-shell execution, `cwd` confinement re-checked immediately
 * before launch, the four-name environment allowlist with a forced `PATH`, output
 * byte capping, `killTree` on timeout and the network profile. Re-deriving any of
 * it here would create a second, divergent boundary.
 *
 * ## Criterion 4: timeout, cancel and OOM are not failed assertions
 *
 * The classification in {@link classify} is the criterion, and its ordering is
 * load-bearing:
 *
 * 1. `timedOut` -> `TIMED_OUT`. Checked FIRST, because a killed process also
 *    reports a signal and a null exit code, and reading those first would
 *    misattribute our own kill;
 * 2. cancelled before launch -> `CANCELED`, provably without side effects;
 * 3. killed by a signal that is not our timeout -> `INFRASTRUCTURE`. **This is how
 *    an out-of-memory kill presents.** `runProcess` rejects `memoryBytes` with
 *    `NOT_ENFORCEABLE` on this adapter, so there is no memory limit to trip and no
 *    honest way to report "OOM detected" — the receipt carries the raw `signal`
 *    and classifies conservatively. Claiming to detect OOM would be a fabrication;
 * 4. exit code 0 -> `PASSED`;
 * 5. any other exit code -> `FAILED`. The process ran to completion and *decided*
 *    to exit non-zero, which is the only case that is a statement about the code.
 *
 * A spawn failure (missing executable, unusable cwd) is `INFRASTRUCTURE`, never
 * `FAILED`: the suite did not run, so it cannot have found a regression.
 *
 * ## Criterion 2: the receipt is bound to the state it describes
 *
 * The tree digest is computed before and after the command via
 * `computeTreeDigest`, and both are on the receipt. A `PASSED` run without an
 * observed post-state is unrepresentable (the contract's `superRefine` rejects it),
 * so "the tests passed" is always attached to a specific tree.
 *
 * ## Criterion 5: redaction happens before anything is kept
 *
 * Output is redacted once, on the raw streams, and every consumer is fed from the
 * redacted text: the inline excerpt and the stored artifact alike. See
 * `./artifact-store.ts` for why the redactor is `redactCommandOutput` rather than
 * `SecretRedactor`.
 */
import { createHash } from "node:crypto";

import { redactCommandOutput } from "@remoteagent/implementation-tools";
import {
  ProcessRunnerError,
  computeTreeDigest,
  runProcess,
  validateWorkspaceRoot,
} from "@remoteagent/workspace-runner";
import type { NetworkMode, VerifiedWorkspacePath } from "@remoteagent/workspace-runner";
import { TrustLevel, canonicalDigest } from "@remoteagent/contracts";

import {
  MAX_EXCERPT_BYTES,
  TestOutcome,
  testRun,
  type ArtifactReference,
  type EvidenceExcerpt,
  type EvidenceScope,
  type TestCommandEntry,
  type TestCommandManifest,
  type TestRun,
} from "./contracts.js";
import type { ArtifactStore } from "./artifact-store.js";

/** The named command is not in the server-owned manifest. */
export const COMMAND_NOT_IN_MANIFEST = "COMMAND_NOT_IN_MANIFEST";

/** The workspace pre-state could not be read, so no run can be bound to it. */
export const PRE_STATE_UNREADABLE = "PRE_STATE_UNREADABLE";

/** Raised for faults this module classifies itself. */
export class TestRunnerError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "TestRunnerError";
    this.code = code;
  }
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Cut at a code-point boundary so clipping cannot split a surrogate pair. */
function clipToBytes(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  let low = 0;
  let high = value.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const code = best > 0 ? value.charCodeAt(best - 1) : 0;
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? best - 1 : best);
}

/** Observed process facts, normalized. `launched: false` means it never started. */
type Observation = Readonly<{
  launched: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  output: string;
}>;

/**
 * Turn observed process facts into an outcome.
 *
 * Exported for its own tests: this function IS criterion 4, and testing it through
 * a spawned process only would leave the signal branches (an external SIGKILL) hard
 * to exercise deterministically.
 */
export function classify(observation: Observation): TestOutcome {
  // First: our own timeout. A timed-out process also carries a signal and a null
  // exit code, so any other order would misread our kill as an external one.
  if (observation.timedOut) return TestOutcome.TIMED_OUT;
  if (observation.canceled) return TestOutcome.CANCELED;
  // The command never ran, so it cannot have found a regression.
  if (!observation.launched) return TestOutcome.INFRASTRUCTURE;
  // Killed by something that is not us. An OOM kill lands here; see module note.
  if (observation.signal !== null) return TestOutcome.INFRASTRUCTURE;
  if (observation.exitCode === 0) return TestOutcome.PASSED;
  // Only here does the process's own decision make this a claim about the code.
  return TestOutcome.FAILED;
}

/**
 * Fingerprint the environment a command observed.
 *
 * Names and a digest, never values: the environment can carry credentials and this
 * record is stored and model-visible. Two runs with the same fingerprint saw the
 * same environment, which is all a comparison needs.
 */
function fingerprint(env: Readonly<Record<string, string>>): {
  digest: string;
  variable_names: string[];
} {
  const names = Object.keys(env).sort();
  return {
    // Over names AND values, so a changed value changes the fingerprint even
    // though the value itself never leaves this function.
    digest: canonicalDigest(names.map((name) => [name, sha256(env[name] ?? "")])),
    variable_names: names,
  };
}

export type TestRunnerOptions = Readonly<{
  /** Workspace root; validated once by the workspace-runner path policy. */
  root: string;
  scope: EvidenceScope;
  /** Server-owned manifest. A model may only name an entry. */
  manifest: TestCommandManifest;
  store: ArtifactStore;
  network?: NetworkMode;
  knownSecrets?: readonly string[];
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}>;

export type TestRunnerInput = Readonly<{
  /** Manifest entry name. Not a command line — there is no shell here. */
  command_name: string;
  signal?: AbortSignal;
}>;

export type TestRunner = Readonly<{
  /** Manifest entry names, for prompt construction. */
  readonly commands: readonly string[];
  run(input: TestRunnerInput): Promise<TestRun>;
  /** Names of entries the manifest marks `required`, for `deriveVerdict`. */
  readonly requiredCommands: ReadonlySet<string>;
}>;

/**
 * Build the runner over a workspace and a manifest.
 *
 * Root validation happens once, here, and throws rather than producing a receipt:
 * an unusable root is a server-side configuration fault, not a test result. A
 * receipt saying `INFRASTRUCTURE` for a misconfigured server would put a fake run
 * into the evidence set.
 */
export async function createTestRunner(options: TestRunnerOptions): Promise<TestRunner> {
  const root: VerifiedWorkspacePath = await validateWorkspaceRoot(options.root);
  const { scope, manifest, store } = options;
  const now = options.now ?? (() => Date.now());
  const knownSecrets = options.knownSecrets ?? [];

  const entries = new Map<string, TestCommandEntry>(
    manifest.entries.map((entry) => [entry.name, entry]),
  );
  const requiredCommands: ReadonlySet<string> = new Set(
    manifest.entries.filter((entry) => entry.required).map((entry) => entry.name),
  );

  const run = async (input: TestRunnerInput): Promise<TestRun> => {
    const entry = entries.get(input.command_name);
    if (entry === undefined) {
      // Not a receipt: an unknown command produced no evidence at all, and minting
      // a run for it would put a fabricated entry into the evidence set.
      throw new TestRunnerError(COMMAND_NOT_IN_MANIFEST);
    }

    const treeDigestBefore = await computeTreeDigest(root).catch(() => null);
    if (treeDigestBefore === null) {
      throw new TestRunnerError(PRE_STATE_UNREADABLE, "workspace pre-state is unreadable");
    }

    const env: Readonly<Record<string, string>> = Object.freeze({ LANG: "C", TZ: "UTC" });
    const started = now();
    let observation: Observation;

    if (input.signal?.aborted === true) {
      observation = {
        launched: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        canceled: true,
        output: "",
      };
    } else {
      try {
        const result = await runProcess({
          executable: entry.executable,
          args: entry.argv,
          workspaceRoot: root,
          cwd: entry.relative_cwd,
          env,
          ...(options.network === undefined ? {} : { network: options.network }),
          limits: { timeoutMs: entry.timeout_ms },
        });
        observation = {
          launched: true,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          canceled: false,
          output: `${result.stdout}${result.stderr.length > 0 ? `\n${result.stderr}` : ""}`,
        };
      } catch (error) {
        // A spawn or policy failure. The suite did not run, so this is never
        // FAILED. Only the stable code travels: runner messages embed host paths.
        const code = error instanceof ProcessRunnerError ? error.code : "RUNNER_FAILED";
        observation = {
          launched: false,
          exitCode: null,
          signal: null,
          timedOut: false,
          canceled: false,
          output: `runner refused: ${code}`,
        };
      }
    }

    const durationMs = Math.max(0, now() - started);
    const outcome = classify(observation);

    // Redact ONCE, on the raw stream. Both the excerpt and the artifact are fed
    // from this, so no raw byte reaches either.
    const redacted = redactCommandOutput(observation.output, knownSecrets);
    const originalByteLength = byteLength(redacted);

    // The artifact holds the full (redacted) stream; the store applies its own
    // size bound and records what it dropped.
    const artifact: ArtifactReference | null = await store
      .put({
        artifact_id: `${input.command_name}-${String(started)}`,
        scope,
        content: redacted,
      })
      .catch(() => null);

    const clipped = clipToBytes(redacted, MAX_EXCERPT_BYTES);
    const excerpt: EvidenceExcerpt = {
      trust: TrustLevel.UNTRUSTED_DATA,
      value: clipped,
      truncated: byteLength(clipped) !== originalByteLength,
      original_byte_length: originalByteLength,
    };

    // A post-state is only meaningful if it can be observed; `null` is honest and
    // the contract refuses to pair it with PASSED.
    const treeDigestAfter = await computeTreeDigest(root).catch(() => null);

    /** Receipt fields, exactly as they appear on the `TestRun`. */
    const receiptFields = {
      run_id: `${input.command_name}-${String(started)}`,
      scope,
      command_name: entry.name,
      phase: entry.phase,
      manifest_digest: manifest.digest,
      outcome,
      exit_code: observation.exitCode,
      signal: observation.signal,
      tree_digest_before: treeDigestBefore,
      tree_digest_after: treeDigestAfter,
    };

    return testRun.parse({
      schema_version: 1,
      ...receiptFields,
      duration_ms: durationMs,
      environment: fingerprint(env),
      excerpt,
      artifact,
      // Over the identifying fields plus the artifact digest, so the receipt is
      // pinned to the exact stored output as well as to the command, outcome and
      // tree state. Deliberately NOT over `duration_ms`: wall-clock varies between
      // machines, and a digest that changes on every run identifies nothing.
      receipt_digest: canonicalDigest({
        ...receiptFields,
        artifact_digest: artifact?.digest ?? null,
      }),
    });
  };

  return Object.freeze({
    commands: [...entries.keys()],
    requiredCommands,
    run,
  });
}
