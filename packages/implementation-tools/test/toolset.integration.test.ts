/**
 * Integration tests for the COMPOSED toolset, against a REAL PostgreSQL and a
 * REAL filesystem (no SQL mock, no mocked `fs`).
 *
 * The units below this one each proved their own tool. What is provable only of
 * the composed set, and is therefore what this suite exists for:
 *
 *   1. **the model cannot change scope with any tool argument.** An adversarial
 *      sweep passes a foreign `identity` / `case_id` / `workspace_id` / `root` /
 *      `cwd` to EVERY tool in the set and asserts three things per tool: the call
 *      is refused or ignored, the ledger row (if any) is written under the
 *      server's scope, and the foreign case's scope has no rows at all. This
 *      cannot be satisfied by validating a supplied scope, only by never
 *      accepting one;
 *
 *   2. **protected paths are refused on every path-taking tool.** Repository
 *      instructions, credential material and `.git` are swept across `read`,
 *      `config`, `tree`, `write`, `patch` and `mkdir`, and each assertion checks
 *      the BYTES ON DISK afterwards — a refusal that still wrote would pass a
 *      code-only check;
 *
 *   3. **the fault/restart matrix never yields a false success.** For each
 *      mutating boundary the operation is interrupted or replayed, and after a
 *      restart (a fresh toolset over the same database) the outcome is either a
 *      clean state or one requiring reconciliation, never `SUCCEEDED`, and the
 *      side effect is never performed twice.
 */
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  OperationLedgerRepository,
  OperationStatus,
  TOOLSET_PATH_PROTECTED,
  ToolKind,
  ToolOutcome,
  createImplementationToolset,
  implementationToolResult,
  isProtectedPath,
} from "../src/index.js";
import type {
  CommandCatalogueEntry,
  ImplementationToolResult,
  ImplementationToolset,
  ToolIdentity,
} from "../src/index.js";

const available = await ensurePostgres();

const identity: ToolIdentity = { case_id: "case-set", workspace_id: "ws-set" };
/** A scope the toolset must never act under, however it is supplied. */
const FOREIGN: ToolIdentity = { case_id: "case-foreign", workspace_id: "ws-foreign" };

const NODE = process.execPath;

function catalogue(): Record<string, CommandCatalogueEntry> {
  return {
    echo: {
      executable: NODE,
      args: ["-e", "process.stdout.write('OUT');process.exit(0)"],
      timeoutMs: 5_000,
    },
  };
}

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
  "composed implementation toolset",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let ledger: OperationLedgerRepository;
    let root: string;
    let artifactRoot: string;
    const dirs: string[] = [];

    const inTx = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => db.withTransaction(fn);

    async function toolset(): Promise<ImplementationToolset> {
      return createImplementationToolset({
        root,
        identity,
        ledger,
        runTransaction: inTx,
        catalogue: catalogue(),
        artifactRoot,
      });
    }

    const exists = async (absolute: string): Promise<boolean> =>
      lstat(absolute).then(
        () => true,
        () => false,
      );

    async function seedCase(scope: ToolIdentity, repo: string, sha: string): Promise<void> {
      await new CaseRepository().insert(db, {
        caseId: scope.case_id,
        ownerId: "owner-s",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["gitlab"], connection_ids: ["conn-s"] },
        discordThreadId: `thread-${scope.case_id}`,
      });
      await new WorkspaceRepository().recordIntent(db, {
        workspaceId: scope.workspace_id,
        caseId: scope.case_id,
        repo,
        baseSha: sha,
        branchName: `ra/${scope.case_id}`,
      });
    }

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      ledger = new OperationLedgerRepository();
      root = await mkdtemp(join(tmpdir(), "toolset-root-"));
      artifactRoot = await mkdtemp(join(tmpdir(), "toolset-artifacts-"));
      dirs.push(root, artifactRoot);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "app.ts"), "export const a = 1;\n");
      await writeFile(join(root, "AGENTS.md"), "ORIGINAL INSTRUCTIONS\n");
      await writeFile(join(root, ".env"), "TOKEN=super-secret\n");
      await mkdir(join(root, ".git"));
      await writeFile(join(root, ".git", "config"), "[core]\n");

      await db.query(
        "TRUNCATE implementation_tool_operations, workspaces, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-s", displayName: "owner-s" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-s",
        ownerId: "owner-s",
        provider: "gitlab",
        alias: "private",
        displayName: "conn-s",
      });
      await seedCase(identity, "git@example.com:acme/repo.git", "0".repeat(40));
      await seedCase(FOREIGN, "git@example.com:acme/other.git", "1".repeat(40));
    });

    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    describe("criterion: the model cannot change scope through any tool argument", () => {
      /**
       * Every scope-shaped field a model might try, on every tool. The set is
       * built from the union of the lower tools' option names, so a field that
       * one of them accepts at CONSTRUCTION time is covered here as a per-call
       * argument.
       */
      const HOSTILE = {
        identity: FOREIGN,
        case_id: FOREIGN.case_id,
        workspace_id: FOREIGN.workspace_id,
        root: "/etc",
        cwd: "/etc",
        ledger: null,
      } as const;

      it("ignores or refuses hostile scope fields on every tool, and never writes under the foreign scope", async () => {
        const set = await toolset();

        const calls: readonly (readonly [string, () => Promise<ImplementationToolResult>])[] = [
          [
            "read",
            () =>
              set.read({
                operation_id: "s-read",
                relative_path: "src/app.ts",
                ...HOSTILE,
              } as never),
          ],
          [
            "search",
            () => set.search({ operation_id: "s-search", query: "export", ...HOSTILE } as never),
          ],
          ["tree", () => set.tree({ operation_id: "s-tree", ...HOSTILE } as never)],
          [
            "config",
            () =>
              set.config({
                operation_id: "s-config",
                relative_path: "package.json",
                ...HOSTILE,
              } as never),
          ],
          [
            "write",
            () =>
              set.write({
                operation_id: "s-write",
                relative_path: "out.txt",
                content: "x",
                ...HOSTILE,
              } as never),
          ],
          [
            "patch",
            () =>
              set.patch({
                operation_id: "s-patch",
                files: [{ relative_path: "p.txt", content: "y" }],
                ...HOSTILE,
              } as never),
          ],
          [
            "mkdir",
            () =>
              set.mkdir({ operation_id: "s-mkdir", relative_path: "made", ...HOSTILE } as never),
          ],
          [
            "command",
            () => set.command({ operation_id: "s-cmd", command: "echo", ...HOSTILE } as never),
          ],
        ];

        for (const [name, call] of calls) {
          const result = await call();
          // Whatever the outcome, the envelope's scope is the SERVER's.
          expect(result.identity, `${name} envelope scope`).toEqual(identity);

          // If the operation reached the ledger at all, its row is ours.
          const own = await ledger.findUnscoped(db, result.operation_id);
          if (own !== null) {
            expect(own.identity, `${name} ledger scope`).toEqual(identity);
          }
        }

        // The decisive assertion: the foreign scope has no operations at all.
        expect(await ledger.listRequiringReconciliation(db, FOREIGN)).toEqual([]);
        const foreignRows = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM implementation_tool_operations WHERE case_id = $1 OR workspace_id = $2",
          [FOREIGN.case_id, FOREIGN.workspace_id],
        );
        expect(foreignRows.rows[0]?.count).toBe("0");
      });

      it("exposes the server scope as data and does not let it be reassigned", async () => {
        const set = await toolset();
        expect(set.identity).toEqual(identity);
        // The surface is frozen: a model-driven caller cannot swap the scope for
        // subsequent calls either.
        expect(Object.isFrozen(set)).toBe(true);
        expect(() => {
          (set as unknown as { identity: ToolIdentity }).identity = FOREIGN;
        }).toThrow();
        expect(set.identity).toEqual(identity);
      });

      it("writes ledger rows that are invisible from the foreign scope", async () => {
        const set = await toolset();
        const written = await set.write({
          operation_id: "s-scoped",
          relative_path: "scoped.txt",
          content: "data",
        });
        expect(written.outcome).toBe(ToolOutcome.SUCCEEDED);

        expect(await ledger.find(db, "s-scoped", identity)).not.toBeNull();
        // A foreign scope addressing our id is refused loudly, never treated as a
        // fresh operation it may execute.
        await expect(ledger.find(db, "s-scoped", FOREIGN)).rejects.toThrow();
      });
    });

    describe("criterion: protected paths are refused on every path-taking tool", () => {
      const PROTECTED = [
        "AGENTS.md",
        "CLAUDE.md",
        ".env",
        ".git/config",
        "nested/deep/.env",
        "vendor/dep/.git/config",
        "keys/server.pem",
        "id_rsa",
      ] as const;

      it("classifies instruction, credential and VCS paths as protected", () => {
        for (const path of PROTECTED) {
          expect(isProtectedPath(path), path).toBe(true);
        }
        // Ordinary paths that merely resemble protected ones stay allowed.
        for (const path of [
          "src/app.ts",
          "docs/agents-guide.md",
          "environment.ts",
          "gitignore.md",
        ]) {
          expect(isProtectedPath(path), path).toBe(false);
        }
      });

      it("refuses reads of protected paths on read, config and tree", async () => {
        const set = await toolset();
        for (const [index, path] of PROTECTED.entries()) {
          const read = await set.read({
            operation_id: `p-read-${String(index)}`,
            relative_path: path,
          });
          expect(failureOf(read), `read ${path}`).toBe(TOOLSET_PATH_PROTECTED);
          const config = await set.config({
            operation_id: `p-cfg-${String(index)}`,
            relative_path: path,
          });
          expect(failureOf(config), `config ${path}`).toBe(TOOLSET_PATH_PROTECTED);
        }
        const tree = await set.tree({ operation_id: "p-tree", relative_path: ".git" });
        expect(failureOf(tree)).toBe(TOOLSET_PATH_PROTECTED);
      });

      it("refuses writes to protected paths and leaves the bytes untouched", async () => {
        const set = await toolset();
        const before = await readFile(join(root, "AGENTS.md"), "utf8");

        const write = await set.write({
          operation_id: "p-write",
          relative_path: "AGENTS.md",
          content: "HIJACKED INSTRUCTIONS\n",
        });
        expect(failureOf(write)).toBe(TOOLSET_PATH_PROTECTED);
        expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(before);

        const env = await set.write({
          operation_id: "p-env",
          relative_path: ".env",
          content: "TOKEN=stolen\n",
        });
        expect(failureOf(env)).toBe(TOOLSET_PATH_PROTECTED);
        expect(await readFile(join(root, ".env"), "utf8")).toBe("TOKEN=super-secret\n");

        // No ledger row: the refusal precedes any claim.
        expect(await ledger.findUnscoped(db, "p-write")).toBeNull();
        expect(await ledger.findUnscoped(db, "p-env")).toBeNull();
      });

      it("refuses a patch batch containing ONE protected path, writing none of it", async () => {
        const set = await toolset();
        const originalInstructions = await readFile(join(root, "AGENTS.md"), "utf8");

        const result = await set.patch({
          operation_id: "p-batch",
          files: [
            { relative_path: "src/app.ts", content: "export const a = 2;\n" },
            // One poisoned entry must condemn the whole batch, otherwise a model
            // can smuggle a protected write behind a legitimate one.
            { relative_path: "AGENTS.md", content: "HIJACKED\n" },
          ],
        });

        expect(failureOf(result)).toBe(TOOLSET_PATH_PROTECTED);
        expect(result.changed_files).toEqual([]);
        expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(originalInstructions);
        // The innocent file in the same batch was not written either.
        expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("export const a = 1;\n");
        expect(await ledger.findUnscoped(db, "p-batch")).toBeNull();
      });

      it("refuses mkdir of a protected directory and creates nothing", async () => {
        const set = await toolset();
        const result = await set.mkdir({
          operation_id: "p-mkdir",
          relative_path: "nested/.git",
          recursive: true,
        });

        expect(failureOf(result)).toBe(TOOLSET_PATH_PROTECTED);
        expect(await exists(join(root, "nested"))).toBe(false);
      });

      it("still allows ordinary paths through the same gate", async () => {
        const set = await toolset();
        const read = await set.read({ operation_id: "a-read", relative_path: "src/app.ts" });
        expect(read.outcome).toBe(ToolOutcome.SUCCEEDED);

        const write = await set.write({
          operation_id: "a-write",
          relative_path: "src/new.ts",
          content: "export const b = 2;\n",
        });
        expect(write.outcome).toBe(ToolOutcome.SUCCEEDED);
        expect(await readFile(join(root, "src", "new.ts"), "utf8")).toBe("export const b = 2;\n");

        const made = await set.mkdir({ operation_id: "a-mkdir", relative_path: "build" });
        expect(made.outcome).toBe(ToolOutcome.SUCCEEDED);
      });

      it("does not echo the model-supplied path back into the payload", async () => {
        const set = await toolset();
        const result = await set.read({
          operation_id: "p-echo",
          relative_path: "keys/../keys/server.pem",
        });
        expect(failureOf(result)).toBe(TOOLSET_PATH_PROTECTED);
        // Neither the path nor any host path may travel to the model.
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("server.pem");
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain(tmpdir());
      });
    });

    describe("criterion: the fault/restart matrix never reports a false success", () => {
      it("resolves an unsettled claim to AMBIGUOUS after restart, for every mutating tool", async () => {
        // One committed claim per mutating tool, with no receipt — exactly the
        // state a crash between claim and settle leaves behind.
        const cases = [
          ["f-write", ToolKind.WRITE_FILE] as const,
          ["f-patch", ToolKind.APPLY_PATCH] as const,
          ["f-mkdir", ToolKind.WRITE_FILE] as const,
          ["f-cmd", ToolKind.RUN_COMMAND] as const,
        ];
        for (const [operationId, kind] of cases) {
          await inTx(async (tx) =>
            ledger.claim(tx, {
              operationId,
              identity,
              kind,
              beforeDigest: null,
              changedFiles: [],
            }),
          );
        }

        // Restart: a brand-new repository and toolset over the same database.
        const restarted = new OperationLedgerRepository();
        const pending = await restarted.listRequiringReconciliation(db, identity);
        expect(pending.map((record) => record.operationId).sort()).toEqual(
          ["f-cmd", "f-mkdir", "f-patch", "f-write"].sort(),
        );
        for (const record of pending) {
          expect(record.status).toBe(OperationStatus.INTENT_RECORDED);
          expect(record.requiresReconciliation).toBe(true);
        }

        // A replay of each unresolved id is AMBIGUOUS, never SUCCEEDED, and does
        // not perform the effect.
        ledger = restarted;
        const set = await toolset();
        const replays = [
          await set.write({ operation_id: "f-write", relative_path: "w.txt", content: "x" }),
          await set.patch({
            operation_id: "f-patch",
            files: [{ relative_path: "p.txt", content: "y" }],
          }),
          await set.mkdir({ operation_id: "f-mkdir", relative_path: "d" }),
          await set.command({ operation_id: "f-cmd", command: "echo" }),
        ];
        for (const result of replays) {
          expect(result.outcome).toBe(ToolOutcome.AMBIGUOUS);
          if (result.outcome === ToolOutcome.AMBIGUOUS) {
            expect(result.requires_reconciliation).toBe(true);
          }
          // The payload the MODEL reads must agree with the envelope: a caller
          // reading only the rendered body must not see a reconciliable
          // operation described as complete.
          expect(body(result)["requires_reconciliation"]).toBe(true);
          expect(body(result)["outcome"]).toBe(ToolOutcome.AMBIGUOUS);
        }
        // None of the effects landed.
        expect(await exists(join(root, "w.txt"))).toBe(false);
        expect(await exists(join(root, "p.txt"))).toBe(false);
        expect(await exists(join(root, "d"))).toBe(false);
      });

      it("never performs a side effect twice for one operation_id", async () => {
        const set = await toolset();
        const first = await set.write({
          operation_id: "once",
          relative_path: "counted.txt",
          content: "first",
        });
        expect(first.outcome).toBe(ToolOutcome.SUCCEEDED);

        // Overwrite behind the tool's back, then replay. A second execution would
        // restore "first"; a correct replay reports the recorded outcome only.
        await writeFile(join(root, "counted.txt"), "tampered");
        const replay = await set.write({
          operation_id: "once",
          relative_path: "counted.txt",
          content: "first",
        });

        expect(replay.outcome).toBe(ToolOutcome.SUCCEEDED);
        expect(await readFile(join(root, "counted.txt"), "utf8")).toBe("tampered");
      });

      it("keeps a restarted toolset in agreement with the durable row", async () => {
        const set = await toolset();
        const created = await set.mkdir({ operation_id: "r-mkdir", relative_path: "persisted" });
        expect(created.outcome).toBe(ToolOutcome.SUCCEEDED);

        // Fresh repository, fresh toolset, same database and same workspace.
        ledger = new OperationLedgerRepository();
        const restarted = await toolset();
        const replay = await restarted.mkdir({
          operation_id: "r-mkdir",
          relative_path: "persisted",
        });

        expect(replay.outcome).toBe(ToolOutcome.SUCCEEDED);
        if (created.outcome === ToolOutcome.SUCCEEDED && replay.outcome === ToolOutcome.SUCCEEDED) {
          expect(replay.after_digest).toBe(created.after_digest);
        }
      });

      it("reports a clean FAILED, with no ledger row, when a refusal precedes any effect", async () => {
        const set = await toolset();
        // A missing parent without `recursive` is refused in pre-flight.
        const result = await set.mkdir({ operation_id: "clean", relative_path: "absent/child" });

        expect(result.outcome).toBe(ToolOutcome.FAILED);
        expect(result.changed_files).toEqual([]);
        expect(await ledger.findUnscoped(db, "clean")).toBeNull();
        expect(await exists(join(root, "absent"))).toBe(false);
      });

      it("exposes only the server catalogue keys through the composed set", async () => {
        const set = await toolset();
        expect([...set.commands]).toEqual(["echo"]);
        const unknown = await set.command({ operation_id: "u-cmd", command: "rm-rf" });
        expect(unknown.outcome).toBe(ToolOutcome.FAILED);
      });
    });
  },
  available,
);
