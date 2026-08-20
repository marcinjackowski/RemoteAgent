/**
 * Integration tests for the journalled multi-file write, against a REAL
 * PostgreSQL and a REAL filesystem (no SQL mock, no mocked `fs`).
 *
 * The three criteria are proven by observation, never by asserting what the
 * implementation says about itself:
 *
 *   1. **the intent precedes the side effect.** The observer's `beforeFile` hook
 *      runs at the instant *before* the first `open` for writing. From inside it
 *      the suite (a) reads the ledger over a SEPARATE pooled connection — a claim
 *      is only visible there once its transaction committed — and (b) recomputes
 *      the workspace tree digest and compares it with the pre-digest recorded in
 *      that very row. So the row exists *and* the workspace is provably still
 *      untouched at that moment, which is stronger than ordering alone;
 *
 *   2. **a real interruption is AMBIGUOUS / PARTIAL_WRITE.** `afterFile` throws
 *      after the k-th file, so the sequence genuinely aborts with part of the
 *      batch already written. The load-bearing assertions are on the BYTES ON
 *      DISK: the first k files carry the new content and the remainder still carry
 *      the old, which is a state neither the pre-state nor the post-state;
 *
 *   3. **restart sees the partial state.** A brand-new `Database` pool and a
 *      brand-new repository over the same database read the operation as requiring
 *      reconciliation, and a fresh toolset replaying the same `operation_id` gets
 *      AMBIGUOUS again while performing no second write.
 *
 * A fourth suite is the falsification attempt for the central claim: it sweeps
 * every interruption point and every fault class this module can produce and
 * asserts that no run whose `changed_files` is non-empty ever reports SUCCEEDED,
 * neither in the envelope nor in the durable row.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  WorkspaceRepository,
  resolvePoolConfig,
} from "@remoteagent/database";
import type { Transaction } from "@remoteagent/database";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  AmbiguityReason,
  ImplementationWriteError,
  INVALID_WRITE_REQUEST,
  MAX_WRITE_FILE_BYTES,
  OperationLedgerRepository,
  OperationStatus,
  ToolKind,
  ToolOutcome,
  WRITE_PARENT_NOT_A_DIRECTORY,
  WRITE_PRE_STATE_MISMATCH,
  WRITE_TARGET_NOT_A_FILE,
  createImplementationWriteTools,
  implementationToolResult,
} from "../src/index.js";
import type {
  ImplementationToolResult,
  ImplementationWriteObserver,
  ImplementationWriteTools,
  ToolIdentity,
} from "../src/index.js";

const available = await ensurePostgres();

const identity: ToolIdentity = { case_id: "case-w", workspace_id: "ws-w" };

/** Deterministic batch: four files, all pre-existing with known old content. */
const BATCH = ["a.ts", "docs/b.md", "src/c.ts", "src/d.ts"] as const;

const oldContent = (path: string): string => `old:${path}\n`;
const newContent = (path: string): string => `new:${path}\n`;

/** A second `Database` over the SAME database, sharing only PostgreSQL. */
function peerDatabase(databaseName: string): Database {
  const base = resolvePoolConfig();
  if ("connectionString" in base && base.connectionString !== undefined) {
    const url = new URL(base.connectionString);
    url.pathname = `/${databaseName}`;
    return new Database({ connectionString: url.toString() });
  }
  return new Database({ ...base, database: databaseName });
}

/** Every envelope must survive a re-parse: a malformed one cannot escape. */
function body(result: ImplementationToolResult): Record<string, unknown> {
  expect(implementationToolResult.safeParse(result).success).toBe(true);
  return JSON.parse(result.output.value) as Record<string, unknown>;
}

describeIntegration(
  "journalled multi-file write",
  () => {
    let db: Database;
    let databaseName: string;
    let drop: () => Promise<void>;
    let ledger: OperationLedgerRepository;
    let root: string;
    const roots: string[] = [];

    const inTx = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => db.withTransaction(fn);

    async function makeRoot(): Promise<string> {
      const created = await mkdtemp(join(tmpdir(), "implementation-write-"));
      roots.push(created);
      await mkdir(join(created, "src"));
      await mkdir(join(created, "docs"));
      for (const path of BATCH) {
        await writeFile(join(created, path), oldContent(path));
      }
      return created;
    }

    async function tools(
      observer?: ImplementationWriteObserver,
    ): Promise<ImplementationWriteTools> {
      return createImplementationWriteTools({
        root,
        identity,
        ledger,
        runTransaction: inTx,
        ...(observer === undefined ? {} : { observer }),
      });
    }

    const files = (paths: readonly string[] = BATCH) =>
      paths.map((path) => ({ relative_path: path, content: newContent(path) }));

    const onDisk = async (path: string): Promise<string> =>
      readFile(join(root, path), "utf8").catch(() => "<missing>");

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      databaseName = created.name;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      ledger = new OperationLedgerRepository();
      root = await makeRoot();
      await db.query(
        "TRUNCATE implementation_tool_operations, workspaces, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-w", displayName: "owner-w" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-w",
        ownerId: "owner-w",
        provider: "gitlab",
        alias: "private",
        displayName: "conn-w",
      });
      await new CaseRepository().insert(db, {
        caseId: identity.case_id,
        ownerId: "owner-w",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["gitlab"], connection_ids: ["conn-w"] },
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
      await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    describe("criterion 1: the intent is journalled BEFORE the first write", () => {
      it("commits the intent, with the pre-digest, before any file is touched", async () => {
        const beforeFirst: Record<string, unknown>[] = [];
        const digestBefore = await computeTreeDigest(root);

        const write = await tools({
          beforeFile: async (event) => {
            if (event.index !== 0) return;
            // A SEPARATE pooled connection: this row is only visible here if its
            // claim transaction already committed.
            const seen = await new OperationLedgerRepository().find(db, "op-order", identity);
            beforeFirst.push({
              status: seen?.status ?? null,
              beforeDigest: seen?.beforeDigest ?? null,
              declared: [...(seen?.changedFiles ?? [])],
              // ... and the workspace is STILL the pre-state that row pinned.
              liveDigest: await computeTreeDigest(root),
            });
          },
        });

        const result = await write.patch({ operation_id: "op-order", files: files() });

        expect(beforeFirst).toHaveLength(1);
        expect(beforeFirst[0]).toEqual({
          status: OperationStatus.INTENT_RECORDED,
          beforeDigest: digestBefore,
          declared: [...BATCH],
          liveDigest: digestBefore,
        });
        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
      });

      it("declares the FULL write surface at claim time, not the applied prefix", async () => {
        const write = await tools({
          afterFile: (event) => {
            if (event.index === 0) throw new Error("interrupted");
          },
        });
        await write.patch({ operation_id: "op-declared", files: files() });

        const record = await ledger.find(db, "op-declared", identity);
        // The claim listed all four; the receipt narrowed it to what was touched.
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
        expect([...(record?.changedFiles ?? [])]).toEqual(["a.ts"]);
        const claimed = await db.query<{ before_digest: string }>(
          "SELECT before_digest FROM implementation_tool_operations WHERE operation_id = $1",
          ["op-declared"],
        );
        expect(claimed.rows[0]?.before_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      it("writes NO ledger row for a refusal decided before the filesystem", async () => {
        const write = await tools();
        const result = await write.patch({
          operation_id: "op-preflight",
          files: files(),
          expected_before_digest: `sha256:${"f".repeat(64)}`,
        });

        expect(result.outcome).toBe(ToolOutcome.FAILED);
        if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
        expect(result.failure_code).toBe(WRITE_PRE_STATE_MISMATCH);
        expect(result.changed_files).toEqual([]);
        // Provably non-mutating: no claim, and every file still holds old bytes.
        expect(await ledger.find(db, "op-preflight", identity)).toBeNull();
        for (const path of BATCH) {
          expect(await onDisk(path)).toBe(oldContent(path));
        }
      });

      it("succeeds only with a verified post-state and matching bytes on disk", async () => {
        const write = await tools();
        const result = await write.patch({
          operation_id: "op-success",
          files: files(),
          expected_before_digest: await computeTreeDigest(root),
        });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        if (result.outcome !== ToolOutcome.SUCCEEDED) throw new Error("expected SUCCEEDED");
        expect(result.kind).toBe(ToolKind.APPLY_PATCH);
        expect([...result.changed_files]).toEqual([...BATCH]);
        expect(result.after_digest).toBe(await computeTreeDigest(root));
        expect(result.after_digest).not.toBe(result.before_digest);
        for (const path of BATCH) {
          expect(await onDisk(path)).toBe(newContent(path));
        }
        const record = await ledger.find(db, "op-success", identity);
        expect(record?.status).toBe(OperationStatus.SUCCEEDED);
        expect(record?.requiresReconciliation).toBe(false);
      });
    });

    describe("criterion 2: a real interruption yields AMBIGUOUS / PARTIAL_WRITE", () => {
      it.each([0, 1, 2])(
        "leaves a partial state visible on disk when aborted after file %i",
        async (stopAfter) => {
          const write = await tools({
            afterFile: (event) => {
              if (event.index === stopAfter) throw new Error("process interrupted");
            },
          });

          const result = await write.patch({
            operation_id: `op-partial-${String(stopAfter)}`,
            files: files(),
          });

          expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
          if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
          expect(result.ambiguity_reason).toBe(AmbiguityReason.PARTIAL_WRITE);
          expect(result.requires_reconciliation).toBe(true);
          // `changed_files` = every path that MAY have changed: the ones written
          // plus the one in flight when the interruption hit.
          expect([...result.changed_files]).toEqual(BATCH.slice(0, stopAfter + 1));
          expect(body(result)["requires_reconciliation"]).toBe(true);

          // The load-bearing assertion: real bytes, a genuinely mixed workspace.
          for (const [index, path] of BATCH.entries()) {
            expect(await onDisk(path)).toBe(
              index <= stopAfter ? newContent(path) : oldContent(path),
            );
          }
          const live = await computeTreeDigest(root);
          expect(live).not.toBe(result.before_digest);
          expect(result.after_digest).toBe(live);
        },
      );

      it("reports AMBIGUOUS when the in-flight file's own open(2) fails", async () => {
        // Swap the third target for a directory between validation and write, so
        // the failing `open` is the one for a path already counted as touched.
        const write = await tools({
          beforeFile: async (event) => {
            if (event.index !== 2) return;
            await rm(join(root, event.relative_path));
            await mkdir(join(root, event.relative_path));
          },
        });

        const result = await write.patch({ operation_id: "op-open-fails", files: files() });

        expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
        expect(result.ambiguity_reason).toBe(AmbiguityReason.PARTIAL_WRITE);
        // The path whose write failed is still listed: it MAY have been changed.
        expect([...result.changed_files]).toEqual(["a.ts", "docs/b.md", "src/c.ts"]);
        expect(await onDisk("a.ts")).toBe(newContent("a.ts"));
        expect(await onDisk("src/d.ts")).toBe(oldContent("src/d.ts"));
        // Only a code travels; no absolute host path reaches the model.
        expect(result.output.value).not.toContain(root);
      });

      it("reports AMBIGUOUS / UNVERIFIED_POST_STATE when a re-read disagrees", async () => {
        // All writes return, then the content is changed underneath before the
        // verification pass — the post-state cannot be established.
        const write = await tools({
          afterFile: async (event) => {
            if (event.index !== BATCH.length - 1) return;
            await writeFile(join(root, "a.ts"), "someone else won the race\n");
          },
        });

        const result = await write.patch({ operation_id: "op-unverified", files: files() });

        expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
        expect(result.ambiguity_reason).toBe(AmbiguityReason.UNVERIFIED_POST_STATE);
        expect([...result.changed_files]).toEqual([...BATCH]);
        const record = await ledger.find(db, "op-unverified", identity);
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
        expect(record?.requiresReconciliation).toBe(true);
      });

      it("keeps the durable row AMBIGUOUS, matching the envelope", async () => {
        const write = await tools({
          afterFile: (event) => {
            if (event.index === 1) throw new Error("interrupted");
          },
        });
        await write.patch({ operation_id: "op-durable", files: files() });

        const row = await db.query<{
          status: string;
          ambiguity_reason: string;
          changed_files: string[];
        }>(
          "SELECT status, ambiguity_reason, changed_files FROM implementation_tool_operations WHERE operation_id = $1",
          ["op-durable"],
        );
        expect(row.rows[0]?.status).toBe(OperationStatus.AMBIGUOUS);
        expect(row.rows[0]?.ambiguity_reason).toBe(AmbiguityReason.PARTIAL_WRITE);
        expect(row.rows[0]?.changed_files).toEqual(["a.ts", "docs/b.md"]);
      });
    });

    describe("criterion 3: a restart sees the partial state and cannot resolve it to success", () => {
      it("is read as requiring reconciliation by a fresh pool and repository", async () => {
        const write = await tools({
          afterFile: (event) => {
            if (event.index === 1) throw new Error("interrupted");
          },
        });
        await write.patch({ operation_id: "op-restart", files: files() });

        const peer = peerDatabase(databaseName);
        try {
          const fresh = new OperationLedgerRepository();
          const record = await fresh.find(peer, "op-restart", identity);
          expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
          expect(record?.ambiguityReason).toBe(AmbiguityReason.PARTIAL_WRITE);
          expect(record?.requiresReconciliation).toBe(true);
          expect([...(record?.changedFiles ?? [])]).toEqual(["a.ts", "docs/b.md"]);

          const pending = await fresh.listRequiringReconciliation(peer, identity);
          expect(pending.map((item) => item.operationId)).toEqual(["op-restart"]);
        } finally {
          await peer.close();
        }
      });

      it("replays a partial operation as AMBIGUOUS and performs no second write", async () => {
        const first = await tools({
          afterFile: (event) => {
            if (event.index === 1) throw new Error("interrupted");
          },
        });
        await first.patch({ operation_id: "op-replay", files: files() });
        const afterFirst = await Promise.all(BATCH.map((path) => onDisk(path)));

        // "Restart": a fresh pool, a fresh repository, a fresh toolset — and a hook
        // that would fail the test loudly if the effect ran a second time.
        const peer = peerDatabase(databaseName);
        try {
          const replay = await createImplementationWriteTools({
            root,
            identity,
            ledger: new OperationLedgerRepository(),
            runTransaction: (fn) => peer.withTransaction(fn),
            observer: {
              beforeFile: () => {
                throw new Error("the effect must not run twice");
              },
            },
          });
          const result = await replay.patch({ operation_id: "op-replay", files: files() });

          expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
          if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
          expect(result.requires_reconciliation).toBe(true);
          expect(result.ambiguity_reason).toBe(AmbiguityReason.PARTIAL_WRITE);
        } finally {
          await peer.close();
        }
        // Byte-identical to the partial state: no second effect happened.
        expect(await Promise.all(BATCH.map((path) => onDisk(path)))).toEqual(afterFirst);
      });

      it("reports AMBIGUOUS for a replay that arrives while the claim is unsettled", async () => {
        // A crashed attempt: the claim is committed, the receipt never is.
        await inTx(async (tx) =>
          ledger.claim(tx, {
            operationId: "op-unsettled",
            identity,
            kind: ToolKind.APPLY_PATCH,
            beforeDigest: await computeTreeDigest(root),
            changedFiles: [...BATCH],
          }),
        );

        const write = await tools({
          beforeFile: () => {
            throw new Error("the effect must not run for an already-claimed id");
          },
        });
        const result = await write.patch({ operation_id: "op-unsettled", files: files() });

        // `INTENT_RECORDED` means "outcome unknown", which is AMBIGUOUS — never
        // a success, and never a clean FAILED.
        expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
        expect(result.ambiguity_reason).toBe(AmbiguityReason.INTERRUPTED);
        expect(result.requires_reconciliation).toBe(true);
        for (const path of BATCH) {
          expect(await onDisk(path)).toBe(oldContent(path));
        }
      });

      it("cannot be upgraded to SUCCEEDED after the fact, at the database level", async () => {
        const write = await tools({
          afterFile: (event) => {
            if (event.index === 0) throw new Error("interrupted");
          },
        });
        await write.patch({ operation_id: "op-no-upgrade", files: files() });

        // The repository's fence refuses...
        const upgraded = await inTx(async (tx) =>
          ledger.settle(tx, "op-no-upgrade", identity, {
            outcome: ToolOutcome.SUCCEEDED,
            afterDigest: await computeTreeDigest(root),
            changedFiles: ["a.ts"],
          }),
        );
        expect(upgraded).toBe(false);
        // ...and so does the schema, for a row with no verified post-state.
        await expect(
          db.query(
            "UPDATE implementation_tool_operations SET status = 'SUCCEEDED', ambiguity_reason = NULL, after_digest = NULL WHERE operation_id = $1",
            ["op-no-upgrade"],
          ),
        ).rejects.toThrow(/implementation_tool_operations_succeeded_digest_chk/);
        const record = await ledger.find(db, "op-no-upgrade", identity);
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
      });

      it("does not re-run a settled SUCCEEDED operation on replay", async () => {
        const write = await tools();
        const first = await write.patch({ operation_id: "op-done", files: files() });
        expect(first.outcome).toBe(ToolOutcome.SUCCEEDED);

        const replay = await tools({
          beforeFile: () => {
            throw new Error("the effect must not run twice");
          },
        });
        const second = await replay.patch({ operation_id: "op-done", files: files() });
        expect(second.outcome).toBe(ToolOutcome.SUCCEEDED);
        if (second.outcome !== ToolOutcome.SUCCEEDED) throw new Error("expected SUCCEEDED");
        expect(second.after_digest).toBe(await computeTreeDigest(root));
      });
    });

    describe("no path leads from a mutation to SUCCEEDED", () => {
      /** Every fault this module can produce, at every interruption point. */
      const faults: readonly (readonly [string, ImplementationWriteObserver])[] = [
        ...BATCH.map(
          (_path, index) =>
            [
              `throw after file ${String(index)}`,
              {
                afterFile: (event) => {
                  if (event.index === index) throw new Error("interrupted");
                },
              },
            ] as const,
        ),
        ...BATCH.map(
          (_path, index) =>
            [
              `target replaced by a directory before file ${String(index)}`,
              {
                beforeFile: async (event) => {
                  if (event.index !== index) return;
                  await rm(join(root, event.relative_path));
                  await mkdir(join(root, event.relative_path));
                },
              },
            ] as const,
        ),
        [
          "target replaced by a symlink mid-batch",
          {
            beforeFile: async (event) => {
              if (event.index !== 2) return;
              await rm(join(root, event.relative_path));
              await symlink(join(root, "a.ts"), join(root, event.relative_path));
            },
          },
        ],
        [
          "content changed under the verification pass",
          {
            afterFile: async (event) => {
              if (event.index !== BATCH.length - 1) return;
              await writeFile(join(root, "docs/b.md"), "raced\n");
            },
          },
        ],
      ];

      it.each(faults)("%s never reports SUCCEEDED once a file was touched", async (_name, hook) => {
        const write = await tools(hook);
        const result = await write.patch({ operation_id: "op-sweep", files: files() });

        const record = await ledger.find(db, "op-sweep", identity);
        if (result.outcome === ToolOutcome.SUCCEEDED) {
          throw new Error("a faulted write reported SUCCEEDED");
        }
        expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (result.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
        expect(result.requires_reconciliation).toBe(true);
        expect(result.changed_files.length).toBeGreaterThan(0);
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
        expect(record?.requiresReconciliation).toBe(true);
      });

      it("reports a clean FAILED only when nothing was opened for writing", async () => {
        const opened: string[] = [];
        const write = await tools({
          beforeFile: (event) => {
            opened.push(event.relative_path);
          },
        });

        // Every refusal below is decided in the read-only pre-flight.
        const cases: readonly (readonly [string, string, Record<string, unknown>])[] = [
          [
            "op-fail-parent",
            WRITE_PARENT_NOT_A_DIRECTORY,
            { files: [{ relative_path: "missing/dir/x.ts", content: "x" }] },
          ],
          [
            "op-fail-dir",
            WRITE_TARGET_NOT_A_FILE,
            { files: [{ relative_path: "src", content: "x" }] },
          ],
          // Traversal never even reaches the path policy: `workspaceRelativePath`
          // rejects a `..` segment at the contract boundary, so the code is
          // INVALID_REQUEST rather than the policy's PATH_ESCAPE. Two independent
          // layers refuse it; the outer one answers first.
          [
            "op-fail-escape",
            INVALID_WRITE_REQUEST,
            { files: [{ relative_path: "../escape.ts", content: "x" }] },
          ],
          [
            "op-fail-absolute",
            INVALID_WRITE_REQUEST,
            { files: [{ relative_path: "/etc/passwd", content: "x" }] },
          ],
          [
            "op-fail-oversize",
            INVALID_WRITE_REQUEST,
            { files: [{ relative_path: "a.ts", content: "x".repeat(MAX_WRITE_FILE_BYTES + 1) }] },
          ],
          [
            "op-fail-duplicate",
            INVALID_WRITE_REQUEST,
            {
              files: [
                { relative_path: "a.ts", content: "one" },
                { relative_path: "a.ts", content: "two" },
              ],
            },
          ],
          ["op-fail-empty", INVALID_WRITE_REQUEST, { files: [] }],
        ];

        for (const [operationId, code, request] of cases) {
          const result = await write.patch({
            operation_id: operationId,
            files: request["files"] as { relative_path: string; content: string }[],
          });
          expect(result.outcome, operationId).toBe(ToolOutcome.FAILED);
          if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
          expect(result.failure_code, operationId).toBe(code);
          // The contract forbids a mutating FAILED; the ledger has no row at all.
          expect(result.changed_files).toEqual([]);
          expect(await ledger.find(db, operationId, identity)).toBeNull();
        }

        // Nothing was ever opened for writing, and every file holds old bytes.
        expect(opened).toEqual([]);
        for (const path of BATCH) {
          expect(await onDisk(path)).toBe(oldContent(path));
        }
      });

      it("refuses to write through a symlinked target found at validation time", async () => {
        await writeFile(join(root, "outside.txt"), "untouched\n");
        await symlink(join(root, "outside.txt"), join(root, "link.ts"));

        const write = await tools();
        const result = await write.write({
          operation_id: "op-symlink",
          relative_path: "link.ts",
          content: "through the link\n",
        });

        expect(result.outcome).toBe(ToolOutcome.FAILED);
        if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
        expect(result.failure_code).toBe("SYMLINK_NOT_ALLOWED");
        expect(await onDisk("outside.txt")).toBe("untouched\n");
        expect(result.output.value).not.toContain(root);
      });

      it("writes a single file through `write` with the WRITE_FILE kind", async () => {
        const write = await tools();
        const result = await write.write({
          operation_id: "op-single",
          relative_path: "a.ts",
          content: "single\n",
        });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        if (result.outcome !== ToolOutcome.SUCCEEDED) throw new Error("expected SUCCEEDED");
        expect(result.kind).toBe(ToolKind.WRITE_FILE);
        expect([...result.changed_files]).toEqual(["a.ts"]);
        expect(await onDisk("a.ts")).toBe("single\n");
        // Untargeted files are untouched.
        expect(await onDisk("src/c.ts")).toBe(oldContent("src/c.ts"));
      });

      it("exposes the pre-flight error as a code, never as a host path", () => {
        const error = new ImplementationWriteError(WRITE_TARGET_NOT_A_FILE);
        expect(error.message).toBe(WRITE_TARGET_NOT_A_FILE);
        expect(error.code).toBe(WRITE_TARGET_NOT_A_FILE);
      });
    });
  },
  available,
);
