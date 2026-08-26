/**
 * Integration tests for the scoped `mkdir` tool, against a REAL PostgreSQL and a
 * REAL filesystem (no SQL mock, no mocked `fs`).
 *
 * The three criteria are proven by observation of the disk and of the durable
 * ledger row, never by asserting what the implementation reports about itself:
 *
 *   1. **creation is confined to the scope.** Traversal, an absolute path, a
 *      symlinked leaf and a symlinked intermediate component each get their own
 *      negative test, and each asserts that the escape target does NOT exist
 *      afterwards — a refusal that still created something outside the root would
 *      pass a code-only assertion;
 *
 *   2. **the operation is idempotent.** Repeating `mkdir` on an existing
 *      directory succeeds, reports `existed: true` with an empty `changed_files`,
 *      and leaves the workspace tree digest byte-identical. A file at the target
 *      is refused rather than reported as an existing directory;
 *
 *   3. **diagnostics carry no host paths.** A canary sweep over the ENTIRE
 *      rendered envelope of every outcome class asserts that neither the temp
 *      root nor `/Users/`, `/home/`, `/private/` or `/tmp/` appears anywhere.
 *
 * A fourth suite covers the ledger contract this tool inherits: the intent is
 * committed before the syscall, and a replay of the same `operation_id` reports
 * the recorded outcome while creating nothing.
 */
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  INVALID_MKDIR_REQUEST,
  MKDIR_PARENT_NOT_A_DIRECTORY,
  MKDIR_SYMLINK_NOT_ALLOWED,
  MKDIR_TARGET_NOT_A_DIRECTORY,
  OperationLedgerRepository,
  OperationStatus,
  ToolKind,
  ToolOutcome,
  createImplementationMkdirTool,
  implementationToolResult,
} from "../src/index.js";
import type {
  ImplementationMkdirTool,
  ImplementationToolResult,
  ToolIdentity,
} from "../src/index.js";

const available = await ensurePostgres();

const identity: ToolIdentity = { case_id: "case-m", workspace_id: "ws-m" };

/** Every envelope must survive a re-parse: a malformed one cannot escape. */
function body(result: ImplementationToolResult): Record<string, unknown> {
  expect(implementationToolResult.safeParse(result).success).toBe(true);
  return JSON.parse(result.output.value) as Record<string, unknown>;
}

function failureOf(result: ImplementationToolResult): string {
  expect(result.outcome).toBe(ToolOutcome.FAILED);
  if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
  return result.failure_code;
}

describeIntegration(
  "scoped mkdir tool",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let ledger: OperationLedgerRepository;
    let root: string;
    const dirs: string[] = [];

    const inTx = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => db.withTransaction(fn);

    async function tool(): Promise<ImplementationMkdirTool> {
      return createImplementationMkdirTool({ root, identity, ledger, runTransaction: inTx });
    }

    const exists = async (absolute: string): Promise<boolean> =>
      lstat(absolute).then(
        () => true,
        () => false,
      );

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      ledger = new OperationLedgerRepository();
      root = await mkdtemp(join(tmpdir(), "mkdir-root-"));
      dirs.push(root);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "existing.ts"), "export const a = 1;\n");
      await db.query(
        "TRUNCATE implementation_tool_operations, workspaces, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-m", displayName: "owner-m" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-m",
        ownerId: "owner-m",
        provider: "gitlab",
        alias: "private",
        displayName: "conn-m",
      });
      await new CaseRepository().insert(db, {
        caseId: identity.case_id,
        ownerId: "owner-m",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["gitlab"], connection_ids: ["conn-m"] },
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

    describe("criterion 1: creation is confined to the workspace scope", () => {
      it("awaits the server writer fence immediately before mkdir", async () => {
        let checks = 0;
        const guarded = await createImplementationMkdirTool({
          root,
          identity,
          ledger,
          runTransaction: inTx,
          beforeMutation: async () => {
            checks += 1;
            throw new Error("stale fence");
          },
        });
        const result = await guarded.run({
          operation_id: "op-mkdir-fence",
          relative_path: "guarded",
        });

        expect(checks).toBe(1);
        expect(result.outcome).toBe(ToolOutcome.FAILED);
        expect(await exists(join(root, "guarded"))).toBe(false);
      });

      it("creates a directory inside the scope and reports it", async () => {
        const created = await (await tool()).run({ operation_id: "op-ok", relative_path: "build" });

        expect(created.outcome).toBe(ToolOutcome.SUCCEEDED);
        expect(created.kind).toBe(ToolKind.WRITE_FILE);
        expect(created.changed_files).toEqual(["build"]);
        expect((await lstat(join(root, "build"))).isDirectory()).toBe(true);
        expect(body(created)["existed"]).toBe(false);
        expect(body(created)["created"]).toBe(1);
      });

      it("refuses a traversal escape and creates nothing outside the root", async () => {
        const outside = join(root, "..", "escaped-traversal");
        const result = await (
          await tool()
        ).run({
          operation_id: "op-esc",
          relative_path: "../escaped-traversal",
        });

        expect(failureOf(result)).toBe(INVALID_MKDIR_REQUEST);
        expect(result.changed_files).toEqual([]);
        expect(await exists(outside)).toBe(false);
        // Refused during pure validation, so no claim was minted at all.
        expect(await ledger.find(db, "op-esc", identity)).toBeNull();
      });

      it("refuses an absolute path and creates nothing there", async () => {
        const absolute = join(tmpdir(), "mkdir-absolute-escape");
        const result = await (
          await tool()
        ).run({
          operation_id: "op-abs",
          relative_path: absolute,
        });

        expect(failureOf(result)).toBe(INVALID_MKDIR_REQUEST);
        expect(await exists(absolute)).toBe(false);
        expect(await ledger.find(db, "op-abs", identity)).toBeNull();
      });

      it("refuses a symlinked leaf and does not create through the link", async () => {
        const target = await mkdtemp(join(tmpdir(), "mkdir-symlink-target-"));
        dirs.push(target);
        await symlink(target, join(root, "linked"));

        const result = await (
          await tool()
        ).run({
          operation_id: "op-link",
          relative_path: "linked",
        });

        // Assert the POLICY code, not merely FAILED. Without this the test also
        // passes when the policy call is removed and the plain `lstat` check
        // refuses the symlink as "not a directory" — a weaker guarantee that
        // would not survive the leaf being a symlink to a DIRECTORY.
        expect(failureOf(result)).toBe(MKDIR_SYMLINK_NOT_ALLOWED);
        expect(result.changed_files).toEqual([]);
        expect(await exists(join(target, "child"))).toBe(false);
      });

      it("refuses a symlinked INTERMEDIATE component, not just the leaf", async () => {
        const target = await mkdtemp(join(tmpdir(), "mkdir-symlink-mid-"));
        dirs.push(target);
        await symlink(target, join(root, "midlink"));

        const result = await (
          await tool()
        ).run({
          operation_id: "op-mid",
          relative_path: "midlink/nested/deep",
          recursive: true,
        });

        // The symlink is an INTERMEDIATE component and it points at a real
        // directory, so a bare `isDirectory()` check would happily traverse it.
        // Only the path policy refuses this, which is why the code is asserted.
        expect(failureOf(result)).toBe(MKDIR_SYMLINK_NOT_ALLOWED);
        // Nothing was created through the link, which a code-only assertion
        // would not have caught.
        expect(await exists(join(target, "nested"))).toBe(false);
      });

      it("refuses a symlinked leaf pointing at a DIRECTORY", async () => {
        // The sharpest case: `lstat` says symlink, but the resolved target is a
        // real directory, so any check phrased as "exists and is a directory"
        // treats this as an idempotent success and silently adopts a path
        // outside the workspace. Only `validateCreateTarget` rejects it.
        const target = await mkdtemp(join(tmpdir(), "mkdir-symlink-dir-"));
        dirs.push(target);
        await mkdir(join(target, "inner"));
        await symlink(target, join(root, "dirlink"));

        const result = await (
          await tool()
        ).run({
          operation_id: "op-dirlink",
          relative_path: "dirlink/inner",
          recursive: true,
        });

        expect(failureOf(result)).toBe(MKDIR_SYMLINK_NOT_ALLOWED);
        expect(result.changed_files).toEqual([]);
        expect(await ledger.find(db, "op-dirlink", identity)).toBeNull();
      });

      it("refuses a request key that is not part of the contract", async () => {
        const result = await (
          await tool()
        ).run({
          operation_id: "op-extra",
          relative_path: "build",
          // A field the model might invent to widen the operation.
          mode: 0o777,
        } as never);

        expect(failureOf(result)).toBe(INVALID_MKDIR_REQUEST);
        expect(await exists(join(root, "build"))).toBe(false);
      });
    });

    describe("criterion 2: creation is idempotent", () => {
      it("repeating mkdir on an existing directory succeeds and changes nothing", async () => {
        const first = await (await tool()).run({ operation_id: "op-i1", relative_path: "build" });
        expect(first.outcome).toBe(ToolOutcome.SUCCEEDED);
        const afterFirst = await computeTreeDigest(root);

        // A DIFFERENT operation_id, so this is a genuine second operation rather
        // than a replay short-circuit.
        const second = await (await tool()).run({ operation_id: "op-i2", relative_path: "build" });

        expect(second.outcome).toBe(ToolOutcome.SUCCEEDED);
        expect(second.changed_files).toEqual([]);
        expect(body(second)["existed"]).toBe(true);
        expect(body(second)["created"]).toBe(0);
        expect(await computeTreeDigest(root)).toBe(afterFirst);
        if (second.outcome === ToolOutcome.SUCCEEDED) {
          expect(second.after_digest).toBe(afterFirst);
        }
      });

      it("treats a pre-existing directory as success without any prior call", async () => {
        const before = await computeTreeDigest(root);
        const result = await (await tool()).run({ operation_id: "op-pre", relative_path: "src" });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        expect(result.changed_files).toEqual([]);
        expect(body(result)["existed"]).toBe(true);
        expect(await computeTreeDigest(root)).toBe(before);
      });

      it("refuses a FILE at the target instead of claiming a directory exists", async () => {
        const before = await computeTreeDigest(root);
        const result = await (
          await tool()
        ).run({ operation_id: "op-file", relative_path: "src/existing.ts" });

        expect(failureOf(result)).toBe(MKDIR_TARGET_NOT_A_DIRECTORY);
        expect(body(result)["existed"]).toBe(false);
        expect(await computeTreeDigest(root)).toBe(before);
        // Still a file, not replaced by a directory.
        expect((await lstat(join(root, "src", "existing.ts"))).isFile()).toBe(true);
      });

      it("creates nested ancestors when recursive, reporting each one", async () => {
        const result = await (
          await tool()
        ).run({ operation_id: "op-rec", relative_path: "a/b/c", recursive: true });

        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
        // Every created ancestor is reported: the write surface is not understated.
        expect(result.changed_files).toEqual(["a", "a/b", "a/b/c"]);
        expect((await lstat(join(root, "a", "b", "c"))).isDirectory()).toBe(true);
      });

      it("refuses a non-recursive request whose parent is missing", async () => {
        const result = await (await tool()).run({ operation_id: "op-nore", relative_path: "x/y" });

        expect(failureOf(result)).toBe(MKDIR_PARENT_NOT_A_DIRECTORY);
        expect(await exists(join(root, "x"))).toBe(false);
      });

      it("refuses a file standing in for an ancestor", async () => {
        await writeFile(join(root, "blocker"), "not a directory\n");
        const result = await (
          await tool()
        ).run({ operation_id: "op-blk", relative_path: "blocker/child", recursive: true });

        expect(failureOf(result)).toBe(MKDIR_PARENT_NOT_A_DIRECTORY);
        expect((await lstat(join(root, "blocker"))).isFile()).toBe(true);
      });
    });

    describe("criterion 3: diagnostics never carry absolute host paths", () => {
      const HOST_MARKERS = ["/Users/", "/home/", "/private/", "/tmp/", "/var/folders/"] as const;

      it("leaks neither the root nor any host path marker in ANY outcome class", async () => {
        const built = await tool();
        await writeFile(join(root, "afile"), "x\n");
        const results = [
          await built.run({ operation_id: "op-c1", relative_path: "build" }),
          await built.run({ operation_id: "op-c2", relative_path: "build" }),
          await built.run({ operation_id: "op-c3", relative_path: "../escape" }),
          await built.run({ operation_id: "op-c4", relative_path: "afile" }),
          await built.run({ operation_id: "op-c5", relative_path: "deep/nest" }),
          await built.run({ operation_id: "op-c6", relative_path: join(tmpdir(), "abs") }),
        ];

        // Sweep the WHOLE serialized envelope, not just the payload: a host path
        // in a failure_code or a changed_files entry would count too.
        for (const result of results) {
          const serialized = JSON.stringify(result);
          expect(serialized).not.toContain(root);
          expect(serialized).not.toContain(tmpdir());
          for (const marker of HOST_MARKERS) {
            expect(serialized).not.toContain(marker);
          }
        }
      });

      it("reports codes and counts rather than paths on failure", async () => {
        const result = await (
          await tool()
        ).run({ operation_id: "op-diag", relative_path: "src/existing.ts" });
        const payload = body(result);

        expect(payload["failure_code"]).toBe(MKDIR_TARGET_NOT_A_DIRECTORY);
        expect(payload["error_code"]).toBe(MKDIR_TARGET_NOT_A_DIRECTORY);
        expect(payload["created"]).toBe(0);
        expect(payload["changed_files"]).toEqual([]);
      });
    });

    describe("ledger contract: intent precedes the effect, replay creates nothing", () => {
      it("records a durable SUCCEEDED receipt scoped to the case and workspace", async () => {
        const result = await (await tool()).run({ operation_id: "op-led", relative_path: "build" });
        expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);

        const record = await ledger.find(db, "op-led", identity);
        expect(record?.status).toBe(OperationStatus.SUCCEEDED);
        expect(record?.kind).toBe(ToolKind.WRITE_FILE);
        expect(record?.changedFiles).toEqual(["build"]);
        expect(record?.requiresReconciliation).toBe(false);
        expect(record?.beforeDigest).not.toBe(record?.afterDigest);
      });

      it("replays the recorded outcome without creating a second time", async () => {
        const first = await (await tool()).run({ operation_id: "op-rep", relative_path: "build" });
        expect(first.outcome).toBe(ToolOutcome.SUCCEEDED);
        const digestAfterFirst = await computeTreeDigest(root);

        // Remove the directory behind the tool's back. A replay must NOT recreate
        // it: the outcome comes from the durable row, not from a fresh syscall.
        await rm(join(root, "build"), { recursive: true });

        const replay = await (await tool()).run({ operation_id: "op-rep", relative_path: "build" });

        expect(replay.outcome).toBe(ToolOutcome.SUCCEEDED);
        expect(await exists(join(root, "build"))).toBe(false);
        if (first.outcome === ToolOutcome.SUCCEEDED && replay.outcome === ToolOutcome.SUCCEEDED) {
          expect(replay.after_digest).toBe(first.after_digest);
        }
        expect(digestAfterFirst).not.toBe(await computeTreeDigest(root));
      });

      it("reports AMBIGUOUS for a replay that arrives while the claim is unsettled", async () => {
        // Simulate a crashed attempt: the claim is committed, no receipt follows.
        const before = await computeTreeDigest(root);
        await inTx(async (tx) =>
          ledger.claim(tx, {
            operationId: "op-crash",
            identity,
            kind: ToolKind.WRITE_FILE,
            beforeDigest: before,
            changedFiles: ["build"],
          }),
        );

        const replay = await (
          await tool()
        ).run({ operation_id: "op-crash", relative_path: "build" });

        expect(replay.outcome).toBe(ToolOutcome.AMBIGUOUS);
        if (replay.outcome === ToolOutcome.AMBIGUOUS) {
          expect(replay.requires_reconciliation).toBe(true);
        }
        // No second effect: the unresolved claim blocked it.
        expect(await exists(join(root, "build"))).toBe(false);
      });

      it("refuses an operation_id owned by a different scope", async () => {
        const foreign: ToolIdentity = { case_id: "case-other", workspace_id: "ws-other" };
        const before = await computeTreeDigest(root);
        await new CaseRepository().insert(db, {
          caseId: foreign.case_id,
          ownerId: "owner-m",
          status: "IMPLEMENTING",
          integrationScope: { providers: ["gitlab"], connection_ids: ["conn-m"] },
          discordThreadId: `thread-${foreign.case_id}`,
        });
        await new WorkspaceRepository().recordIntent(db, {
          workspaceId: foreign.workspace_id,
          caseId: foreign.case_id,
          repo: "git@example.com:acme/other.git",
          baseSha: "1".repeat(40),
          branchName: `ra/${foreign.case_id}`,
        });
        await inTx(async (tx) =>
          ledger.claim(tx, {
            operationId: "op-foreign",
            identity: foreign,
            kind: ToolKind.WRITE_FILE,
            beforeDigest: before,
            changedFiles: ["build"],
          }),
        );

        // A foreign id is a loud server-side fault, not a model-visible outcome.
        await expect(
          (await tool()).run({ operation_id: "op-foreign", relative_path: "build" }),
        ).rejects.toThrow();
        expect(await exists(join(root, "build"))).toBe(false);
      });
    });
  },
  available,
);
