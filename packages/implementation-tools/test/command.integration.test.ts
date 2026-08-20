/**
 * Integration tests for the model-facing `command` tool, against a REAL
 * PostgreSQL, a REAL filesystem and REAL child processes launched through
 * `@remoteagent/workspace-runner`'s confined `runProcess` (no SQL mock, no mocked
 * `fs`, no fake spawn). Commands are run as `node -e <script>`, because on macOS
 * the `sandbox-exec` profile only allows `process-exec` of the single literal
 * executable and file-read within the workspace / `/bin` / `/usr/bin`; the
 * platform `/bin/sh` fails under it (it opens `/private/var/select/sh`), whereas
 * a canonical `node` binary starts cleanly.
 *
 * The three acceptance criteria are proven by observation, never by asserting
 * what the implementation says about itself:
 *
 *   1. **the policy is server-owned and cannot be widened by an argument.** The
 *      four fields a caller might try to override — its own environment, the
 *      `cwd`, the network mode, and the wall-clock / output limits — are each
 *      submitted on the request and each refused with the typed
 *      `POLICY_NOT_EXTENSIBLE` code, before anything is launched and before a
 *      ledger row is minted. A positive counterpart proves the server value is
 *      the one actually applied (the catalogue's `TZ` reaches the child; nothing
 *      the model sent could).
 *
 *   2. **output is redacted once, for every consumer.** A canary the server
 *      declared, plus host paths and provider tokens the local table must catch
 *      on its own, are injected into BOTH stdout and stderr; none of them appears
 *      in the model-facing payload, in the log record, or in the stored artifact.
 *      Clipping is explicit (a flag plus the pre-clip byte length), and the whole
 *      redacted output survives in the artifact, out of the prompt.
 *
 *   3. **timeout, cancel and a plain non-zero exit are distinguishable.** A
 *      timeout that fired *after* a file was written is AMBIGUOUS / INTERRUPTED
 *      with `requires_reconciliation`, never a FAILED that would assert "no
 *      effect"; a plain non-zero exit is FAILED; a cancel before launch is a
 *      provably non-mutating FAILED, and a cancel after launch is AMBIGUOUS.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  WorkspaceRepository,
} from "@remoteagent/database";
import type { Transaction } from "@remoteagent/database";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  AmbiguityReason,
  COMMAND_CANCELED,
  COMMAND_FAILED,
  COMMAND_NOT_ALLOWED,
  COMMAND_POLICY_NOT_EXTENSIBLE,
  CommandTermination,
  MAX_TOOL_OUTPUT_BYTES,
  OperationLedgerRepository,
  OperationStatus,
  ToolKind,
  ToolOutcome,
  createImplementationCommandTool,
  implementationToolResult,
} from "../src/index.js";
import type {
  CommandCatalogueEntry,
  CommandLogRecord,
  ImplementationCommandInput,
  ImplementationCommandObserver,
  ImplementationCommandTool,
  ImplementationToolResult,
  ToolIdentity,
} from "../src/index.js";

const available = await ensurePostgres();

const identity: ToolIdentity = { case_id: "case-cmd", workspace_id: "ws-cmd" };

const NODE = process.execPath;

/** A catalogue entry that runs `node -e <body>` with optional trailing argv. */
function nodeEntry(
  body: string,
  timeoutMs: number,
  extra: Partial<CommandCatalogueEntry> = {},
  args: readonly string[] = [],
): CommandCatalogueEntry {
  return { executable: NODE, args: ["-e", body, ...args], timeoutMs, ...extra };
}

/** Distinct, self-identifying secrets so a leak is unambiguous in an assertion. */
const CANARY = "CANARY-8f3a-do-not-log-ZZ";
const HOST_PATH = "/Users/victim/.ssh/id_rsa";
const GLPAT = "glpat-ABCDEFGHIJ1234567890";
const GHP = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const AKIA = "AKIAIOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----";

/** Every secret literal that must never survive redaction, in any channel. */
const SECRETS: readonly string[] = [
  CANARY,
  HOST_PATH,
  GLPAT,
  GHP,
  AKIA,
  JWT,
  "MIIEowIBAAKCAQEAsecret",
];

/**
 * Payload the `leak` command emits, verbatim, on BOTH stdout and stderr. The
 * secrets are passed as argv (not interpolated into the script) so newlines and
 * quotes in the PEM block need no escaping.
 */
const LEAK_ARGV: readonly string[] = [CANARY, `path=${HOST_PATH}`, GLPAT, GHP, AKIA, JWT, PEM];

const LEAK_SCRIPT =
  "const s = process.argv.slice(1).join('\\n');" +
  "process.stdout.write(s); process.stderr.write(s); process.exit(0);";

/** A widened request: the extra keys are what criterion 1 must refuse. */
type WidenedInput = ImplementationCommandInput & Record<string, unknown>;

function catalogue(): Record<string, CommandCatalogueEntry> {
  return {
    echo: nodeEntry(
      "process.stdout.write('OUT');process.stderr.write('ERR');process.exit(0)",
      5_000,
    ),
    tz: nodeEntry("process.stdout.write('TZ=' + (process.env.TZ ?? 'unset'))", 5_000, {
      env: { TZ: "UTC" },
    }),
    fail: nodeEntry("process.stderr.write('boom');process.exit(3)", 5_000),
    // Writes a file (a real side effect) and then outlives the short timeout.
    hang_timeout: nodeEntry(
      "require('node:fs').writeFileSync('marker.txt','x');setTimeout(()=>{},5000)",
      700,
    ),
    // Writes a file and self-exits at 2s, so a cancelled wait leaves no orphan.
    hang_cancel: nodeEntry(
      "require('node:fs').writeFileSync('marker.txt','x');setTimeout(()=>{},2000)",
      4_000,
    ),
    leak: nodeEntry(LEAK_SCRIPT, 5_000, {}, LEAK_ARGV),
    big: nodeEntry("process.stdout.write('A'.repeat(100000))", 5_000),
  };
}

/** Every envelope must survive a re-parse: a malformed one cannot escape. */
function body(result: ImplementationToolResult): Record<string, unknown> {
  expect(implementationToolResult.safeParse(result).success).toBe(true);
  return JSON.parse(result.output.value) as Record<string, unknown>;
}

describeIntegration(
  "model-facing command tool",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let ledger: OperationLedgerRepository;
    let root: string;
    let artifactRoot: string;
    const dirs: string[] = [];
    let logs: CommandLogRecord[];

    const inTx = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => db.withTransaction(fn);

    async function makeTool(
      overrides: {
        observer?: ImplementationCommandObserver;
        network?: "DENY" | "ALLOW";
      } = {},
    ): Promise<ImplementationCommandTool> {
      return createImplementationCommandTool({
        root,
        identity,
        ledger,
        runTransaction: inTx,
        catalogue: catalogue(),
        artifactRoot,
        knownSecrets: [CANARY],
        log: (record) => logs.push(record),
        ...overrides,
      });
    }

    const marker = async (): Promise<string> =>
      readFile(join(root, "marker.txt"), "utf8").catch(() => "<missing>");

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      logs = [];
      ledger = new OperationLedgerRepository();
      root = await mkdtemp(join(tmpdir(), "command-root-"));
      artifactRoot = await mkdtemp(join(tmpdir(), "command-artifacts-"));
      dirs.push(root, artifactRoot);
      await db.query(
        "TRUNCATE implementation_tool_operations, workspaces, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-c", displayName: "owner-c" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-c",
        ownerId: "owner-c",
        provider: "gitlab",
        alias: "private",
        displayName: "conn-c",
      });
      await new CaseRepository().insert(db, {
        caseId: identity.case_id,
        ownerId: "owner-c",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["gitlab"], connection_ids: ["conn-c"] },
        discordThreadId: `thread-${identity.case_id}`,
      });
      await new WorkspaceRepository().recordIntent(db, {
        workspaceId: identity.workspace_id,
        caseId: identity.case_id,
        repo: "git@example.com:acme/repo.git",
        baseSha: "0".repeat(40),
        branchName: `ra/${identity.case_id}`,
      });
    });

    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    describe("criterion 1: the policy is server-owned and cannot be widened by an argument", () => {
      /** Each entry is one field a caller might try to override, and its value. */
      const widenings: readonly (readonly [string, WidenedInput])[] = [
        ["own environment", { operation_id: "op-env", command: "echo", env: { GIT_TOKEN: "x" } }],
        ["cwd outside the root", { operation_id: "op-cwd", command: "echo", cwd: "../escape" }],
        ["network mode", { operation_id: "op-net", command: "echo", network: "ALLOW" }],
        ["a raised limit", { operation_id: "op-lim", command: "echo", timeoutMs: 9_999_999_999 }],
      ];

      it.each(widenings)(
        "refuses %s with a typed POLICY_NOT_EXTENSIBLE and launches nothing",
        async (_name, request) => {
          const tool = await makeTool();
          const result = await tool.run(request);

          expect(result.outcome).toBe(ToolOutcome.FAILED);
          if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
          expect(result.failure_code).toBe(COMMAND_POLICY_NOT_EXTENSIBLE);
          expect(result.changed_files).toEqual([]);
          // Refused in the pure-validation phase: no claim, so nothing ran.
          expect(await ledger.find(db, request.operation_id, identity)).toBeNull();
        },
      );

      it("applies the SERVER's environment, not one the model could choose", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-tz", command: "tz" });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        // The catalogue set TZ=UTC; the child observed it. The model has no field
        // that could have put it there — the only source is server policy.
        expect(body(result)["stdout"]).toBe("TZ=UTC");
      });

      it("refuses a command name that is not in the server catalogue", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-unknown", command: "rm-rf" });

        expect(result.outcome).toBe(ToolOutcome.FAILED);
        if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
        expect(result.failure_code).toBe(COMMAND_NOT_ALLOWED);
        expect(await ledger.find(db, "op-unknown", identity)).toBeNull();
      });

      it("exposes only the catalogue keys to the model", async () => {
        const tool = await makeTool();
        expect([...tool.commands].sort()).toEqual(
          ["big", "echo", "fail", "hang_cancel", "hang_timeout", "leak", "tz"].sort(),
        );
      });
    });

    describe("criterion 2: output is redacted once, for the model, the log and the artifact", () => {
      it("removes the canary, host paths and provider tokens from every channel", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-leak", command: "leak" });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        const payload = body(result);

        // (1) the model-facing payload. Nothing sensitive survives, and the
        // placeholder proves redaction actually fired rather than emitting empty.
        expect(result.output.value).toContain("[REDACTED]");
        for (const secret of SECRETS) {
          expect(result.output.value, `payload leaked ${secret}`).not.toContain(secret);
        }
        // The secrets were on BOTH streams, so both must be scrubbed.
        expect(String(payload["stdout"])).toContain("[REDACTED]");
        expect(String(payload["stderr"])).toContain("[REDACTED]");
        for (const secret of SECRETS) {
          expect(String(payload["stdout"]), `stdout leaked ${secret}`).not.toContain(secret);
          expect(String(payload["stderr"]), `stderr leaked ${secret}`).not.toContain(secret);
        }

        // (2) the log sink is fed the SAME redacted observation, never the raw one.
        const record = logs.find((entry) => entry.operation_id === "op-leak");
        expect(record).toBeDefined();
        for (const secret of SECRETS) {
          expect(record?.stdout, `log stdout leaked ${secret}`).not.toContain(secret);
          expect(record?.stderr, `log stderr leaked ${secret}`).not.toContain(secret);
        }

        // (3) the durable artifact is out of the prompt but is itself redacted,
        // and is referenced by a relative path and a content digest.
        expect(record?.artifact).not.toBeNull();
        const artifact = record?.artifact;
        if (artifact == null) throw new Error("expected an artifact reference");
        expect(artifact.reference).not.toContain(root);
        expect(artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        const stored = await readFile(join(artifactRoot, artifact.reference), "utf8");
        expect(stored).toContain("[REDACTED]");
        for (const secret of SECRETS) {
          expect(stored, `artifact leaked ${secret}`).not.toContain(secret);
        }
      });

      it("clips the model view explicitly while the artifact keeps the whole output", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-big", command: "big" });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        // The envelope declares the clip: a flag plus the pre-clip byte length,
        // and the carried bytes are within the model bound.
        expect(result.output.truncated).toBe(true);
        expect(result.output.original_byte_length).toBeGreaterThan(MAX_TOOL_OUTPUT_BYTES);
        expect(Buffer.byteLength(result.output.value, "utf8")).toBeLessThanOrEqual(
          MAX_TOOL_OUTPUT_BYTES,
        );

        const payload = body(result);
        expect(payload["complete"]).toBe(false);
        expect(Number(payload["dropped_output_bytes"])).toBeGreaterThan(0);
        // The runner never hit its own (larger) cap, so the artifact is whole.
        expect(payload["runner_output_truncated"]).toBe(false);

        const record = logs.find((entry) => entry.operation_id === "op-big");
        const artifact = record?.artifact;
        if (artifact == null) throw new Error("expected an artifact reference");
        expect(artifact.byte_length).toBeGreaterThan(MAX_TOOL_OUTPUT_BYTES);
      });
    });

    describe("criterion 3: timeout, cancel and a plain non-zero exit are distinguishable", () => {
      it("classifies a timeout that fired after a side effect as AMBIGUOUS, never FAILED", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-timeout", command: "hang_timeout" });

        // The file was written before the SIGKILL, so a FAILED here would assert
        // "no effect" — precisely the claim that cannot be made.
        expect(await marker()).toBe("x");
        expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
        expect(result.ambiguity_reason).toBe(AmbiguityReason.INTERRUPTED);
        expect(result.requires_reconciliation).toBe(true);

        const payload = body(result);
        expect(payload["termination"]).toBe(CommandTermination.TIMEOUT);
        expect(payload["workspace_changed"]).toBe(true);
        expect(payload["requires_reconciliation"]).toBe(true);

        const record = await ledger.find(db, "op-timeout", identity);
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
        expect(record?.requiresReconciliation).toBe(true);
      });

      it("classifies a plain non-zero exit as FAILED, not AMBIGUOUS", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-fail", command: "fail" });

        expect(result.outcome).toBe(ToolOutcome.FAILED);
        if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
        expect(result.failure_code).toBe(COMMAND_FAILED);
        expect(result.changed_files).toEqual([]);

        const payload = body(result);
        expect(payload["termination"]).toBe(CommandTermination.EXIT);
        expect(payload["exit_code"]).toBe(3);
        // A ran-to-completion process is fully observed: not reconciliation work.
        expect(payload["requires_reconciliation"]).toBe(false);
        expect((await ledger.find(db, "op-fail", identity))?.status).toBe(OperationStatus.FAILED);
      });

      it("succeeds on exit 0 with a verified post-state", async () => {
        const tool = await makeTool();
        const result = await tool.run({ operation_id: "op-ok", command: "echo" });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        if (result.outcome !== ToolOutcome.SUCCEEDED) throw new Error("expected SUCCEEDED");
        expect(result.kind).toBe(ToolKind.RUN_COMMAND);
        expect(result.after_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(result.changed_files).toEqual([]);

        const payload = body(result);
        expect(payload["termination"]).toBe(CommandTermination.EXIT);
        expect(payload["exit_code"]).toBe(0);
        expect(payload["stdout"]).toBe("OUT");
        expect(payload["stderr"]).toBe("ERR");
        expect((await ledger.find(db, "op-ok", identity))?.status).toBe(OperationStatus.SUCCEEDED);
      });

      it("treats a cancel BEFORE launch as a provably non-mutating FAILED", async () => {
        const controller = new AbortController();
        controller.abort();
        const tool = await makeTool();
        const before = await computeTreeDigest(root);

        const result = await tool.run({
          operation_id: "op-cancel-early",
          command: "hang_cancel",
          signal: controller.signal,
        });

        expect(result.outcome).toBe(ToolOutcome.FAILED);
        if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
        expect(result.failure_code).toBe(COMMAND_CANCELED);
        expect(result.changed_files).toEqual([]);
        // Nothing was started: no ledger row, no side effect on disk.
        expect(await ledger.find(db, "op-cancel-early", identity)).toBeNull();
        expect(await marker()).toBe("<missing>");
        expect(await computeTreeDigest(root)).toBe(before);
      });

      it("treats a cancel AFTER launch as AMBIGUOUS, because a side effect may have landed", async () => {
        const controller = new AbortController();
        // Fire the abort once the runner's abort listener is attached (a macrotask
        // after `beforeLaunch` resolves), so the wait is genuinely interrupted
        // mid-flight rather than refused up front.
        const tool = await makeTool({
          observer: {
            beforeLaunch: () => {
              setTimeout(() => controller.abort(), 0);
            },
          },
        });

        const result = await tool.run({
          operation_id: "op-cancel-late",
          command: "hang_cancel",
          signal: controller.signal,
        });

        expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
        expect(result.ambiguity_reason).toBe(AmbiguityReason.INTERRUPTED);
        expect(result.requires_reconciliation).toBe(true);
        expect(body(result)["termination"]).toBe(CommandTermination.CANCELED);

        const record = await ledger.find(db, "op-cancel-late", identity);
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
        expect(record?.requiresReconciliation).toBe(true);
      });
    });
  },
  available,
);
