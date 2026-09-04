import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  WorkspaceRepository,
  migrateUp,
  resolvePoolConfig,
  type Transaction,
} from "@remoteagent/database";
import {
  OperationLedgerRepository,
  ToolOutcome,
  type ToolIdentity,
} from "@remoteagent/implementation-tools";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CodeOwnedGeneratorCatalog,
  DisposableWorkspaceErrorCode,
  GeneratorBoundaryErrorCode,
  executeCodeOwnedGenerators,
} from "../src/index.js";

function databaseWithName(name?: string): Database {
  const base = resolvePoolConfig();
  if ("connectionString" in base && base.connectionString !== undefined) {
    const url = new URL(base.connectionString);
    if (name !== undefined) url.pathname = `/${name}`;
    return new Database({ connectionString: url.toString() });
  }
  return new Database(
    name === undefined ? { ...base, database: "postgres" } : { ...base, database: name },
  );
}

async function postgresAvailable(): Promise<boolean> {
  const db = databaseWithName();
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await db.close();
  }
}

async function createTestDatabase(): Promise<{ db: Database; drop: () => Promise<void> }> {
  const name = `ra_test_${randomUUID().replaceAll("-", "")}`;
  const admin = databaseWithName();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const db = databaseWithName(name);
  await migrateUp(db);
  return {
    db,
    drop: async () => {
      await db.close();
      const cleanup = databaseWithName();
      await cleanup.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [name],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      await cleanup.close();
    },
  };
}

const available = await postgresAvailable();
const describeIntegration = available
  ? describe
  : process.env.RA_REQUIRE_POSTGRES
    ? describe
    : describe.skip;
const NODE = await realpath(process.execPath);
const identity: ToolIdentity = { case_id: "case-generator", workspace_id: "ws-generator" };

describeIntegration("receipt-bound code-owned generators", () => {
  let db: Database;
  let drop: () => Promise<void>;
  let root: string;
  let artifacts: string;
  let ledger: OperationLedgerRepository;
  const roots: string[] = [];

  beforeAll(async () => {
    const created = await createTestDatabase();
    db = created.db;
    drop = created.drop;
  });

  afterAll(async () => drop());

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "generator-authority-"));
    artifacts = await mkdtemp(join(tmpdir(), "generator-artifacts-"));
    roots.push(root, artifacts);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "src", "schema.json"), '{"version":2}\n');
    await writeFile(join(root, "generated", "client.ts"), "export const version = 1;\n");
    await writeFile(join(root, "README.md"), "protected\n");
    ledger = new OperationLedgerRepository();
    await db.query(
      "TRUNCATE implementation_tool_operations, workspaces, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
    );
    await new OwnerRepository().insert(db, { ownerId: "owner-g", displayName: "owner-g" });
    await new ConnectionRepository().insert(db, {
      connectionId: "conn-g",
      ownerId: "owner-g",
      provider: "gitlab",
      alias: "private",
      displayName: "conn-g",
    });
    await new CaseRepository().insert(db, {
      caseId: identity.case_id,
      ownerId: "owner-g",
      status: "IMPLEMENTING",
      integrationScope: { providers: ["gitlab"], connection_ids: ["conn-g"] },
      discordThreadId: "thread-generator",
    });
    await new WorkspaceRepository().recordIntent(db, {
      workspaceId: identity.workspace_id,
      caseId: identity.case_id,
      repo: "git@example.com:acme/generator.git",
      baseSha: "0".repeat(40),
      branchName: "ra/generator",
    });
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  const inTx = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => db.withTransaction(fn);

  async function catalog(
    script = "require('node:fs').writeFileSync('generated/client.ts','export const version = 2;\\n')",
  ): Promise<CodeOwnedGeneratorCatalog> {
    return CodeOwnedGeneratorCatalog.create({
      executable_allowlist: [NODE],
      definitions: [
        {
          generator_id: "client_codegen",
          trigger_paths: ["src/schema.json"],
          output_paths: ["generated/client.ts"],
          command: { executable: NODE, args: ["-e", script], cwd: ".", timeoutMs: 5_000 },
        },
      ],
    });
  }

  function execute(input: {
    catalog: CodeOwnedGeneratorCatalog;
    allowedPaths?: readonly string[];
    changedPaths?: readonly string[];
    ids?: string;
  }) {
    return executeCodeOwnedGenerators({
      authoritativeRoot: root,
      artifactRoot: artifacts,
      identity,
      ledger,
      runTransaction: inTx,
      catalog: input.catalog,
      implementationChangedPaths: input.changedPaths ?? ["src/schema.json"],
      allowedPaths: input.allowedPaths ?? ["src", "generated"],
      beforeMutation: async () => undefined,
      operationIdFor: (_generator, phase) => `${input.ids ?? "generator"}-${phase}`,
    });
  }

  it("runs outside the authority tree and materializes the exact declared output with receipts", async () => {
    const selected = await catalog();
    expect(selected.selectedForScope(["src"]).map((entry) => entry.generator_id)).toEqual([
      "client_codegen",
    ]);
    expect(selected.selectedForScope(["src2"])).toEqual([]);
    const result = await execute({ catalog: selected });

    expect(await readFile(join(root, "generated", "client.ts"), "utf8")).toBe(
      "export const version = 2;\n",
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("protected\n");
    expect(result.changedFiles).toEqual(["generated/client.ts"]);
    expect(result.operationResults.map((entry) => entry.outcome)).toEqual([
      ToolOutcome.SUCCEEDED,
      ToolOutcome.SUCCEEDED,
    ]);
    expect(await ledger.find(db, "generator-command", identity)).not.toBeNull();
    expect(await ledger.find(db, "generator-materialize", identity)).not.toBeNull();
  });

  it("refuses an output outside the selected slice before launching a process", async () => {
    const selected = await catalog();
    await expect(execute({ catalog: selected, allowedPaths: ["src"] })).rejects.toMatchObject({
      code: GeneratorBoundaryErrorCode.OUTPUT_OUTSIDE_SLICE,
    });
    expect(await ledger.find(db, "generator-command", identity)).toBeNull();
    expect(await readFile(join(root, "generated", "client.ts"), "utf8")).toContain("version = 1");
  });

  it("rejects a disposable write outside declared outputs without touching authority", async () => {
    const selected = await catalog(
      "const fs=require('node:fs');fs.writeFileSync('generated/client.ts','ok\\n');fs.writeFileSync('README.md','bad\\n')",
    );
    await expect(execute({ catalog: selected })).rejects.toMatchObject({
      code: DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
    });
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("protected\n");
    expect(await readFile(join(root, "generated", "client.ts"), "utf8")).toContain("version = 1");
    expect(await ledger.find(db, "generator-materialize", identity)).toBeNull();
  });

  it("fails closed when an old disposable command receipt is replayed against different bytes", async () => {
    const selected = await catalog();
    await execute({ catalog: selected, ids: "stable" });
    await writeFile(join(root, "generated", "client.ts"), "export const version = 1;\n");

    await expect(execute({ catalog: selected, ids: "stable" })).rejects.toMatchObject({
      code: GeneratorBoundaryErrorCode.STALE_RECEIPT,
    });
    expect(await readFile(join(root, "generated", "client.ts"), "utf8")).toContain("version = 1");
  });

  it("re-checks the writer fence after generation and before authoritative materialization", async () => {
    const selected = await catalog();
    await expect(
      executeCodeOwnedGenerators({
        authoritativeRoot: root,
        artifactRoot: artifacts,
        identity,
        ledger,
        runTransaction: inTx,
        catalog: selected,
        implementationChangedPaths: ["src/schema.json"],
        allowedPaths: ["src", "generated"],
        beforeMutation: () => Promise.reject(new Error("stale generator writer")),
        operationIdFor: (_generator, phase) => `fenced-${phase}`,
      }),
    ).rejects.toMatchObject({ code: GeneratorBoundaryErrorCode.MATERIALIZATION_FAILED });
    expect(await ledger.find(db, "fenced-command", identity)).not.toBeNull();
    expect(await ledger.find(db, "fenced-materialize", identity)).not.toBeNull();
    expect(await readFile(join(root, "generated", "client.ts"), "utf8")).toContain("version = 1");
  });

  it("does nothing when no changed implementation path triggers a generator", async () => {
    const selected = await catalog();
    const result = await execute({ catalog: selected, changedPaths: ["README.md"] });
    expect(result.operationResults).toEqual([]);
    expect(result.changedFiles).toEqual([]);
    expect(await ledger.find(db, "generator-command", identity)).toBeNull();
  });
});
