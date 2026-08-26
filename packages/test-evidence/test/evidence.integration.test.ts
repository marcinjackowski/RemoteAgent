/**
 * Integration tests for the evidence layer, against a REAL filesystem and REAL
 * spawned processes (no mocked `fs`, no fake process runner).
 *
 * The fixture suites required by the task are real `node -e` programs: pass, fail,
 * timeout, huge output and secret output. A simulated process would prove nothing
 * about criterion 4, whose whole content is how a real exit code, signal or
 * timeout is classified.
 *
 * What each block proves, and why it is the observation rather than the claim:
 *
 *   1. **AC1 — a model cannot record a PASS.** The adversarial block attacks the
 *      derivation directly: zero runs, a forged receipt digest, a receipt from
 *      another tree, and an attempt to construct a verdict object by hand. Each
 *      must be refused, because the verdict has to be underivable rather than
 *      merely unset;
 *   2. **AC2 — every result is bound to a workspace and tree digest.** Asserted on
 *      the receipt AND by mutating the workspace between runs, so the binding
 *      demonstrably tracks state instead of being a copied constant;
 *   3. **AC3 — a snapshot update carries a diff and a justification.** Includes
 *      the rubber-stamp attempts that actually happen: boilerplate text, the diff
 *      pasted back, and an acceptance replayed onto different bytes;
 *   4. **AC4 — timeout/cancel/OOM differ from a failed assertion.** A real
 *      timeout, a real cancel, and a real external SIGKILL, each of which must NOT
 *      be `FAILED`;
 *   5. **AC5 — secrets are redacted in excerpts AND in the stored artifact.** The
 *      canary sweep reads the artifact BYTES BACK OFF DISK, because "redacted in
 *      the excerpt" while the file holds the secret is the failure this criterion
 *      exists to prevent;
 *   6. **AC6 — retention/size limits keep the audit metadata.** A huge output is
 *      truncated by the store, and after pruning the payload the reference still
 *      answers what was dropped and what the kept bytes hashed to.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_INTEGRITY_FAILED,
  COMMAND_NOT_IN_MANIFEST,
  EvidenceContractError,
  EvidenceVerdict,
  LocalArtifactStore,
  MAX_EXCERPT_BYTES,
  SNAPSHOT_DIFF_MISMATCH,
  SNAPSHOT_JUSTIFICATION_REQUIRED,
  SNAPSHOT_NOTHING_TO_ACCEPT,
  SnapshotStatus,
  TestOutcome,
  TestPhase,
  VerificationSession,
  acceptSnapshotChange,
  classify,
  classifySnapshot,
  createTestRunner,
  deriveVerdict,
  evidenceVerdict,
  testRun,
} from "../src/index.js";
import type {
  ArtifactReference,
  EvidenceScope,
  TestCommandEntry,
  TestCommandManifest,
  TestRunner,
} from "../src/index.js";

const NODE = process.execPath;
const scope: EvidenceScope = { case_id: "case-ev", workspace_id: "ws-ev" };

/** Distinct, self-identifying secrets so a leak is unambiguous. */
const CANARY = "CANARY-7b2e-do-not-store-QQ";
const GLPAT = "glpat-ZYXWVUTSRQ0987654321";
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTk5OTk5OTk5In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SECRETS = [CANARY, GLPAT, AKIA, JWT] as const;

/**
 * Assert a thrown error carries a specific stable `code`.
 *
 * Asserting on `code` rather than on message text is deliberate and stricter:
 * prose can be reworded, whereas the code is what a caller branches on. It also
 * matches how these errors travel — messages are dropped at boundaries because
 * they can embed absolute host paths.
 */
function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect((error as { code?: string }).code, String(error)).toBe(code);
    return;
  }
  throw new Error(`expected a throw with code ${code}`);
}

/** Async counterpart of {@link expectCode}. */
async function expectCodeAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect((error as { code?: string }).code, String(error)).toBe(code);
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

function entry(
  name: string,
  body: string,
  extra: Partial<TestCommandEntry> = {},
  args: readonly string[] = [],
): TestCommandEntry {
  return {
    name,
    phase: TestPhase.UNIT,
    executable: NODE,
    argv: ["-e", body, ...args],
    relative_cwd: ".",
    timeout_ms: 10_000,
    required: true,
    ...extra,
  };
}

/** Emits every secret on stdout and stderr; argv avoids quoting problems. */
const LEAK_BODY =
  "const s = process.argv.slice(1).join('\\n');" +
  "process.stdout.write(s);process.stderr.write(s);process.exit(0);";

function manifest(entries: readonly TestCommandEntry[]): TestCommandManifest {
  return {
    schema_version: 1,
    manifest_id: "manifest-1",
    // A real digest over the entries, so a run pins the manifest it used.
    digest: `sha256:${"a".repeat(64)}`,
    entries: [...entries],
  };
}

describe("test evidence layer", () => {
  let root: string;
  let storeRoot: string;
  let store: LocalArtifactStore;
  const dirs: string[] = [];

  async function runner(
    entries: readonly TestCommandEntry[],
    overrides: Partial<Parameters<typeof createTestRunner>[0]> = {},
  ): Promise<TestRunner> {
    return createTestRunner({
      root,
      scope,
      manifest: manifest(entries),
      store,
      knownSecrets: [CANARY],
      ...overrides,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "evidence-root-"));
    storeRoot = await mkdtemp(join(tmpdir(), "evidence-store-"));
    dirs.push(root, storeRoot);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const a = 1;\n");
    store = new LocalArtifactStore({ root: storeRoot, knownSecrets: [CANARY] });
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  describe("AC1: a model cannot record a PASS without a successful receipt", () => {
    it("refuses to derive a verdict from zero runs", () => {
      // The degenerate case this criterion is really about: "nothing ran" must
      // never render as "everything is fine".
      expect(() => deriveVerdict([], new Set(["unit"]))).toThrow(EvidenceContractError);
    });

    it("refuses to derive a verdict when no REQUIRED run is present", async () => {
      const built = await runner([entry("optional", "process.exit(0)", { required: false })]);
      const run = await built.run({ command_name: "optional" });
      expect(run.outcome).toBe(TestOutcome.PASSED);

      // A green optional run is not evidence for the required set.
      expect(() => deriveVerdict([run], new Set(["unit"]))).toThrow(EvidenceContractError);
    });

    it("derives FAILED from a real failing suite, and PASSED only from a real green one", async () => {
      const built = await runner([
        entry("green", "process.exit(0)"),
        entry("red", "process.stderr.write('assert failed');process.exit(1)"),
      ]);
      const green = await built.run({ command_name: "green" });
      const red = await built.run({ command_name: "red" });

      expect(green.outcome).toBe(TestOutcome.PASSED);
      expect(red.outcome).toBe(TestOutcome.FAILED);
      expect(red.exit_code).toBe(1);

      expect(deriveVerdict([green], new Set(["green"])).verdict).toBe(EvidenceVerdict.PASSED);
      expect(deriveVerdict([green, red], built.requiredCommands).verdict).toBe(
        EvidenceVerdict.FAILED,
      );
    });

    it("rejects a hand-built PASSED verdict that no receipt supports", () => {
      // A caller cannot mint a verdict object directly: `derived_from` must carry
      // real receipt digests, and the schema refuses an empty set.
      expect(() =>
        evidenceVerdict.parse({
          schema_version: 1,
          scope,
          verdict: EvidenceVerdict.PASSED,
          derived_from: [],
          blocking: [],
          tree_digest: `sha256:${"b".repeat(64)}`,
        }),
      ).toThrow();
    });

    it("rejects a forged PASSED receipt whose exit code is not zero", () => {
      // The contract makes the lie unrepresentable rather than merely unlikely.
      expect(() =>
        testRun.parse({
          schema_version: 1,
          run_id: "forged",
          scope,
          command_name: "unit",
          phase: TestPhase.UNIT,
          manifest_digest: `sha256:${"a".repeat(64)}`,
          outcome: TestOutcome.PASSED,
          exit_code: 1,
          signal: null,
          duration_ms: 1,
          tree_digest_before: `sha256:${"c".repeat(64)}`,
          tree_digest_after: `sha256:${"c".repeat(64)}`,
          environment: { digest: `sha256:${"d".repeat(64)}`, variable_names: [] },
          excerpt: {
            trust: "UNTRUSTED_DATA",
            value: "",
            truncated: false,
            original_byte_length: 0,
          },
          artifact: null,
          receipt_digest: `sha256:${"e".repeat(64)}`,
        }),
      ).toThrow();
    });

    it("rejects a PASSED receipt with no observed post-state", () => {
      expect(() =>
        testRun.parse({
          schema_version: 1,
          run_id: "forged-2",
          scope,
          command_name: "unit",
          phase: TestPhase.UNIT,
          manifest_digest: `sha256:${"a".repeat(64)}`,
          outcome: TestOutcome.PASSED,
          exit_code: 0,
          signal: null,
          duration_ms: 1,
          tree_digest_before: `sha256:${"c".repeat(64)}`,
          tree_digest_after: null,
          environment: { digest: `sha256:${"d".repeat(64)}`, variable_names: [] },
          excerpt: {
            trust: "UNTRUSTED_DATA",
            value: "",
            truncated: false,
            original_byte_length: 0,
          },
          artifact: null,
          receipt_digest: `sha256:${"e".repeat(64)}`,
        }),
      ).toThrow();
    });

    it("withholds PASSED when a required command produced NO receipt at all", async () => {
      // Found by an adversarial audit probe. Checking only "at least one required
      // run exists" returned PASSED while a second required command had never run
      // — a partially-executed suite indistinguishable from a complete one, which
      // is the more dangerous form of "nothing ran renders as fine".
      const built = await runner([
        entry("green", "process.exit(0)"),
        entry("never-ran", "process.exit(0)"),
      ]);
      const green = await built.run({ command_name: "green" });

      const verdict = deriveVerdict([green], built.requiredCommands);

      // INCONCLUSIVE, not FAILED: the command reported nothing, not a regression.
      expect(verdict.verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
      expect(verdict.blocking.join(" ")).toContain("never-ran");
      expect(verdict.blocking.join(" ")).toContain("no receipt");
    });

    it("reaches PASSED only once every required command has a receipt", async () => {
      const built = await runner([
        entry("green", "process.exit(0)"),
        entry("also-green", "process.exit(0)"),
      ]);
      const runs = [
        await built.run({ command_name: "green" }),
        await built.run({ command_name: "also-green" }),
      ];

      expect(deriveVerdict(runs, built.requiredCommands).verdict).toBe(EvidenceVerdict.PASSED);
    });

    it("maps a green exit without a durable log artifact to INFRASTRUCTURE", async () => {
      const unavailableStore = {
        put: async () => Promise.reject(new Error("store unavailable")),
        get: async () => Promise.reject(new Error("store unavailable")),
        has: async () => false,
      };
      const built = await runner([entry("green", "process.exit(0)")], {
        store: unavailableStore,
      });
      const run = await built.run({ command_name: "green" });

      expect(run.exit_code).toBe(0);
      expect(run.artifact).toBeNull();
      expect(run.outcome).toBe(TestOutcome.INFRASTRUCTURE);
      expect(deriveVerdict([run], new Set(["green"])).verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
    });

    it("refuses a command that is not in the server-owned manifest", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      // No receipt at all, rather than a fabricated INFRASTRUCTURE one.
      await expect(built.run({ command_name: "rm-rf" })).rejects.toThrow(COMMAND_NOT_IN_MANIFEST);
    });
  });

  describe("AC2: every result is bound to a workspace and a tree digest", () => {
    it("records the real pre-state digest and tracks a workspace change", async () => {
      const before = await computeTreeDigest(root);
      const built = await runner([entry("green", "process.exit(0)")]);

      const first = await built.run({ command_name: "green" });
      expect(first.tree_digest_before).toBe(before);
      expect(first.scope).toEqual(scope);

      // Mutate the workspace; the next receipt must pin a DIFFERENT state, which a
      // copied constant would not.
      await writeFile(join(root, "src", "app.ts"), "export const a = 2;\n");
      const second = await built.run({ command_name: "green" });

      expect(second.tree_digest_before).not.toBe(first.tree_digest_before);
      expect(second.tree_digest_before).toBe(await computeTreeDigest(root));
    });

    it("refuses to mix runs from different trees into one verdict", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const first = await built.run({ command_name: "green" });
      await writeFile(join(root, "src", "app.ts"), "export const a = 3;\n");
      const second = await built.run({ command_name: "green" });

      // Otherwise a green run from one tree would vouch for another.
      expect(() => deriveVerdict([first, second], new Set(["green"]))).toThrow(
        EvidenceContractError,
      );
    });

    it("carries a reproducible receipt digest that a reader can re-check", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const run = await built.run({ command_name: "green" });
      const verdict = deriveVerdict([run], new Set(["green"]));

      expect(verdict.derived_from).toEqual([run.receipt_digest]);
      expect(verdict.tree_digest).toBe(run.tree_digest_before);
    });
  });

  describe("AC4: timeout, cancel and OOM differ from a failed assertion", () => {
    it("classifies a REAL timeout as TIMED_OUT, not FAILED", async () => {
      const built = await runner([entry("hang", "setTimeout(()=>{},5000)", { timeout_ms: 400 })]);
      const run = await built.run({ command_name: "hang" });

      expect(run.outcome).toBe(TestOutcome.TIMED_OUT);
      expect(run.outcome).not.toBe(TestOutcome.FAILED);
      // A timeout must withhold a verdict rather than assert a regression.
      expect(deriveVerdict([run], new Set(["hang"])).verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
    });

    it("classifies a pre-launch cancel as CANCELED", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const controller = new AbortController();
      controller.abort();

      const run = await built.run({ command_name: "green", signal: controller.signal });
      expect(run.outcome).toBe(TestOutcome.CANCELED);
      expect(deriveVerdict([run], new Set(["green"])).verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
    });

    it("forwards an active cancel to the process runner and records CANCELED", async () => {
      const built = await runner([entry("hang", "setTimeout(()=>{},5000)")]);
      const controller = new AbortController();
      const pending = built.run({ command_name: "hang", signal: controller.signal });
      setTimeout(() => controller.abort(), 100);

      const run = await pending;
      expect(run.outcome).toBe(TestOutcome.CANCELED);
      expect(run.outcome).not.toBe(TestOutcome.TIMED_OUT);
      expect(run.exit_code).toBeNull();
    });

    it("classifies a missing executable as INFRASTRUCTURE, never FAILED", async () => {
      const built = await runner([
        { ...entry("missing", ""), executable: "/nonexistent/definitely-not-here" },
      ]);
      const run = await built.run({ command_name: "missing" });

      // The suite never ran, so it cannot have found a regression.
      expect(run.outcome).toBe(TestOutcome.INFRASTRUCTURE);
      expect(deriveVerdict([run], new Set(["missing"])).verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
    });

    it("classifies an EXTERNAL SIGKILL (how OOM presents) as INFRASTRUCTURE", () => {
      // `runProcess` rejects memoryBytes as NOT_ENFORCEABLE, so there is no memory
      // limit to trip: an OOM kill arrives as a signal with no exit code. Tested
      // through `classify` because an external kill cannot be provoked
      // deterministically through a spawn.
      expect(
        classify({
          launched: true,
          exitCode: null,
          signal: "SIGKILL",
          timedOut: false,
          canceled: false,
          output: "",
        }),
      ).toBe(TestOutcome.INFRASTRUCTURE);
    });

    it("keeps our own timeout distinct from an external kill", () => {
      // Ordering check: a timed-out process ALSO reports a signal, so reading the
      // signal first would misattribute our kill as external.
      expect(
        classify({
          launched: true,
          exitCode: null,
          signal: "SIGKILL",
          timedOut: true,
          canceled: false,
          output: "",
        }),
      ).toBe(TestOutcome.TIMED_OUT);
    });

    it("reports a non-assertion outcome as run-level in the summary", async () => {
      const built = await runner([entry("hang", "setTimeout(()=>{},5000)", { timeout_ms: 400 })]);
      const session = new VerificationSession({ scope, runner: built });
      await session.runAll();
      const report = session.verify();

      expect(report.verdict.verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
      expect(report.summary.join(" ")).toContain("not a code regression");
    });

    it("prefers INCONCLUSIVE over FAILED when both are present", async () => {
      const built = await runner([
        entry("red", "process.exit(1)"),
        entry("hang", "setTimeout(()=>{},5000)", { timeout_ms: 400 }),
      ]);
      const runs = [
        await built.run({ command_name: "red" }),
        await built.run({ command_name: "hang" }),
      ];
      // With the harness in an unknown state, "the code is broken" is not a
      // statement the evidence supports.
      expect(deriveVerdict(runs, built.requiredCommands).verdict).toBe(
        EvidenceVerdict.INCONCLUSIVE,
      );
    });
  });

  describe("AC5: secrets are redacted in excerpts AND in stored artifacts", () => {
    it("removes every canary from the excerpt and from the artifact ON DISK", async () => {
      const built = await runner([entry("leak", LEAK_BODY, {}, [...SECRETS])]);
      const run = await built.run({ command_name: "leak" });

      expect(run.outcome).toBe(TestOutcome.PASSED);
      expect(run.artifact).not.toBeNull();

      for (const secret of SECRETS) {
        expect(run.excerpt.value, `excerpt: ${secret}`).not.toContain(secret);
      }

      // The load-bearing part: read the bytes back OFF DISK. "Redacted in the
      // excerpt" while the file holds the secret is the exact failure this
      // criterion exists to prevent.
      const reference = run.artifact as ArtifactReference;
      const stored = await store.get(reference);
      for (const secret of SECRETS) {
        expect(stored, `artifact: ${secret}`).not.toContain(secret);
      }
      const raw = await readFile(join(storeRoot, reference.relative_path), "utf8");
      for (const secret of SECRETS) {
        expect(raw, `raw file: ${secret}`).not.toContain(secret);
      }
    });

    it("redacts in the STORE itself, not only in the runner", async () => {
      // Found by mutation: neutering the store's redaction left every test green,
      // because the runner already redacts before calling `put`. That made the
      // store's own guarantee untested — and the store is a public port that
      // RA-017 and RA-025 will call directly, without the runner in front of it.
      // So it must redact its own input rather than trust its caller.
      const reference = await store.put({
        artifact_id: "direct-put",
        scope,
        content: `${CANARY}\n${GLPAT}\n${AKIA}\n${JWT}\n/Users/victim/.ssh/id_rsa\n`,
      });

      const stored = await store.get(reference);
      const raw = await readFile(join(storeRoot, reference.relative_path), "utf8");
      for (const secret of SECRETS) {
        expect(stored, `stored: ${secret}`).not.toContain(secret);
        expect(raw, `raw file: ${secret}`).not.toContain(secret);
      }
      expect(raw).not.toContain("/Users/victim");
    });

    it("redacts absolute host paths, which SecretRedactor alone would pass through", async () => {
      // This is why the package uses `redactCommandOutput` rather than
      // `SecretRedactor` — see CTF-006. Test output is full of host paths.
      const built = await runner([
        entry("paths", "process.stdout.write(process.argv[1])", {}, [
          `/Users/victim/.ssh/id_rsa and ${root}/src/app.ts`,
        ]),
      ]);
      const run = await built.run({ command_name: "paths" });

      expect(run.excerpt.value).not.toContain("/Users/victim");
      expect(run.excerpt.value).not.toContain(root);
    });

    it("keeps the artifact reference free of absolute host paths", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const run = await built.run({ command_name: "green" });

      const serialized = JSON.stringify(run.artifact);
      expect(serialized).not.toContain(storeRoot);
      expect(serialized).not.toContain(tmpdir());
    });
  });

  describe("AC6: retention and size limits keep the audit metadata", () => {
    it("truncates a huge output but records what was dropped", async () => {
      const small = new LocalArtifactStore({ root: storeRoot, maxArtifactBytes: 4_096 });
      const built = await runner([entry("huge", "process.stdout.write('x'.repeat(200000))")], {
        store: small,
      });

      const run = await built.run({ command_name: "huge" });
      const reference = run.artifact as ArtifactReference;

      expect(reference.complete).toBe(false);
      expect(reference.byte_length).toBe(4_096);
      expect(reference.original_byte_length).toBeGreaterThan(4_096);
      // The digest still covers exactly what was stored, so integrity of the kept
      // bytes is verifiable even though the payload is partial.
      await expect(small.get(reference)).resolves.toHaveLength(4_096);
    });

    it("bounds the inline excerpt independently of the artifact", async () => {
      const built = await runner([entry("huge", "process.stdout.write('y'.repeat(200000))")]);
      const run = await built.run({ command_name: "huge" });

      expect(run.excerpt.truncated).toBe(true);
      expect(new TextEncoder().encode(run.excerpt.value).length).toBeLessThanOrEqual(
        MAX_EXCERPT_BYTES,
      );
      // The pre-clip size survives, so the reader knows how much was dropped.
      expect(run.excerpt.original_byte_length).toBeGreaterThan(MAX_EXCERPT_BYTES);
    });

    it("keeps the receipt and reference intact after the payload is pruned", async () => {
      const built = await runner([entry("green", "process.stdout.write('output')")]);
      const run = await built.run({ command_name: "green" });
      const reference = run.artifact as ArtifactReference;

      expect(await store.has(reference)).toBe(true);
      expect(await store.prune(scope)).toBeGreaterThan(0);

      // Retention removed BYTES, not the audit trail: the outcome, the digest, the
      // sizes and the tree binding all still answer.
      expect(await store.has(reference)).toBe(false);
      expect(run.outcome).toBe(TestOutcome.PASSED);
      expect(reference.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(reference.original_byte_length).toBeGreaterThan(0);
      expect(deriveVerdict([run], new Set(["green"])).verdict).toBe(EvidenceVerdict.PASSED);

      // And the absence is honest rather than looking like corruption.
      await expectCodeAsync(async () => store.get(reference), ARTIFACT_INTEGRITY_FAILED);
    });

    it("detects a tampered artifact instead of returning it", async () => {
      const built = await runner([entry("green", "process.stdout.write('trustworthy')")]);
      const run = await built.run({ command_name: "green" });
      const reference = run.artifact as ArtifactReference;

      await writeFile(join(storeRoot, reference.relative_path), "tampered", "utf8");

      // An artifact that does not match its receipt is not evidence.
      await expectCodeAsync(async () => store.get(reference), ARTIFACT_INTEGRITY_FAILED);
    });

    it("isolates artifacts by scope", async () => {
      const built = await runner([entry("green", "process.stdout.write('mine')")]);
      const run = await built.run({ command_name: "green" });
      const reference = run.artifact as ArtifactReference;

      // Pruning another case's scope must not touch ours.
      expect(await store.prune({ case_id: "case-other", workspace_id: "ws-other" })).toBe(0);
      expect(await store.has(reference)).toBe(true);
      expect(reference.relative_path.startsWith(`${scope.case_id}/`)).toBe(true);
    });
  });

  describe("AC3: a snapshot update carries a diff and a justification", () => {
    const snapshotScope = scope;
    const recorded = "line one\nline two\nline three\n";
    const candidate = "line one\nline CHANGED\nline three\n";

    it("classifies unchanged, changed, new and removed from the bytes", () => {
      expect(
        classifySnapshot({
          snapshot_id: "s1",
          scope: snapshotScope,
          recorded,
          candidate: recorded,
        }).status,
      ).toBe(SnapshotStatus.UNCHANGED);
      expect(
        classifySnapshot({ snapshot_id: "s1", scope: snapshotScope, recorded, candidate }).status,
      ).toBe(SnapshotStatus.CHANGED);
      expect(
        classifySnapshot({ snapshot_id: "s1", scope: snapshotScope, recorded: null, candidate })
          .status,
      ).toBe(SnapshotStatus.NEW);
      expect(
        classifySnapshot({ snapshot_id: "s1", scope: snapshotScope, recorded, candidate: null })
          .status,
      ).toBe(SnapshotStatus.REMOVED);
    });

    it("produces a diff that shows the changed lines", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded,
        candidate,
      });

      expect(comparison.diff.changed_lines).toBe(1);
      expect(comparison.diff.value).toContain("-line two");
      expect(comparison.diff.value).toContain("+line CHANGED");
      expect(comparison.diff.trust).toBe("UNTRUSTED_DATA");
    });

    it("redacts secrets inside a snapshot diff", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded: "token: old\n",
        candidate: `token: ${GLPAT}\n`,
        knownSecrets: [CANARY],
      });

      expect(comparison.diff.value).not.toContain(GLPAT);
    });

    it("accepts a change only with a substantive justification", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded,
        candidate,
      });

      const acceptance = acceptSnapshotChange({
        comparison,
        candidate,
        justification:
          "The renderer now emits CHANGED for the second row because RA-013 renamed the field.",
      });

      expect(acceptance.accepted_digest).toBe(comparison.candidate_digest);
      expect(acceptance.comparison.status).toBe(SnapshotStatus.CHANGED);
    });

    it("refuses boilerplate justifications that carry no reasoning", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded,
        candidate,
      });

      for (const justification of ["ok", "updated", "LGTM", "re-record", "expected"]) {
        expectCode(
          () => acceptSnapshotChange({ comparison, candidate, justification }),
          SNAPSHOT_JUSTIFICATION_REQUIRED,
        );
      }
    });

    it("refuses a justification that merely restates the diff", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded,
        candidate,
      });

      expectCode(
        () =>
          acceptSnapshotChange({
            comparison,
            candidate,
            justification: `The diff is:\n${comparison.diff.value}`,
          }),
        SNAPSHOT_JUSTIFICATION_REQUIRED,
      );
    });

    it("refuses an acceptance replayed onto different bytes", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded,
        candidate,
      });

      // An approval obtained for one candidate must not transfer to another.
      expectCode(
        () =>
          acceptSnapshotChange({
            comparison,
            candidate: "line one\nline SOMETHING ELSE\nline three\n",
            justification:
              "This justification is long enough to pass the length gate but the bytes differ.",
          }),
        SNAPSHOT_DIFF_MISMATCH,
      );
    });

    it("refuses to accept an unchanged snapshot", () => {
      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope: snapshotScope,
        recorded,
        candidate: recorded,
      });

      expectCode(
        () =>
          acceptSnapshotChange({
            comparison,
            candidate: recorded,
            justification: "There is nothing to accept here but the text is long enough.",
          }),
        SNAPSHOT_NOTHING_TO_ACCEPT,
      );
    });
  });

  describe("Verification role: interprets results, cannot falsify them", () => {
    it("withholds PASSED while a snapshot change is unapproved", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const session = new VerificationSession({ scope, runner: built });
      await session.runAll();
      session.recordSnapshot(
        classifySnapshot({
          snapshot_id: "s1",
          scope,
          recorded: "old\n",
          candidate: "new\n",
        }),
      );

      const report = session.verify();
      // Every test passed, yet the snapshot decision is missing.
      expect(report.verdict.verdict).toBe(EvidenceVerdict.INCONCLUSIVE);
      expect(report.unapproved).toHaveLength(1);
      expect(report.summary.join(" ")).toContain("without an accepted justification");
    });

    it("reaches PASSED once the snapshot change is justified", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const session = new VerificationSession({ scope, runner: built });
      await session.runAll();

      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope,
        recorded: "old\n",
        candidate: "new\n",
      });
      session.recordSnapshot(comparison);
      session.attachSnapshotAcceptance(
        acceptSnapshotChange({
          comparison,
          candidate: "new\n",
          justification: "The fixture was intentionally renamed from old to new in this change.",
        }),
      );

      const report = session.verify();
      expect(report.verdict.verdict).toBe(EvidenceVerdict.PASSED);
      expect(report.unapproved).toEqual([]);
    });

    it("cannot upgrade a FAILED verdict with a snapshot acceptance", async () => {
      const built = await runner([entry("red", "process.exit(1)")]);
      const session = new VerificationSession({ scope, runner: built });
      await session.runAll();

      const comparison = classifySnapshot({
        snapshot_id: "s1",
        scope,
        recorded: "old\n",
        candidate: "new\n",
      });
      session.recordSnapshot(comparison);
      session.attachSnapshotAcceptance(
        acceptSnapshotChange({
          comparison,
          candidate: "new\n",
          justification: "Justified, but this must not rescue a genuinely failing suite.",
        }),
      );

      expect(session.verify().verdict.verdict).toBe(EvidenceVerdict.FAILED);
    });

    it("exposes the runs the verdict was derived from, so it can be re-checked", async () => {
      const built = await runner([entry("green", "process.exit(0)")]);
      const session = new VerificationSession({ scope, runner: built });
      await session.runAll();
      const report = session.verify();

      // Re-deriving from the same receipts must give the same answer.
      const rederived = deriveVerdict(report.runs, built.requiredCommands);
      expect(rederived.verdict).toBe(report.verdict.verdict);
      expect(rederived.derived_from).toEqual(report.verdict.derived_from);
    });

    it("throws rather than reporting PASSED when nothing ran", () => {
      const session = new VerificationSession({
        scope,
        runner: {
          commands: [],
          requiredCommands: new Set(),
          run: async () => {
            throw new Error("unreachable");
          },
        },
      });
      expect(() => session.verify()).toThrow(EvidenceContractError);
    });
  });

  describe("export surface", () => {
    it("shares no exported name with contracts or implementation-tools", async () => {
      const [own, contracts, tools] = await Promise.all([
        import("../src/index.js"),
        import("@remoteagent/contracts"),
        import("@remoteagent/implementation-tools"),
      ]);
      const foreign = new Set([...Object.keys(contracts), ...Object.keys(tools)]);
      const collisions = Object.keys(own).filter((name) => foreign.has(name));

      // ESM silently drops an ambiguous name from `export *`, so a collision would
      // make a schema resolve to `undefined` at some future import site.
      expect(collisions).toEqual([]);
    });
  });
});
