import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceAdapter, adaptWorkspaceRepository } from "../src/index.js";
import { WorkspaceRepository } from "../../database/src/repositories/workspace.js";
import { Database } from "../../database/src/client.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const run = promisify(execFile);
const available = await ensurePostgres();

describeIntegration(
  "workspace public lifecycle",
  () => {
    let db: Database;
    let drop: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop?.());

    it("runs create, restart resume, destroy, and exact destroy replay", async () => {
      const parent = await mkdtemp(join("/tmp", "ra010-wu09-lifecycle-"));
      const source = join(parent, "source");
      const workspaceRoot = join(parent, "sandbox");
      await mkdir(source);
      await mkdir(workspaceRoot);
      try {
        await run("git", ["init", "--quiet", source]);
        await run("git", ["-C", source, "config", "user.email", "lifecycle@example.test"]);
        await run("git", ["-C", source, "config", "user.name", "Lifecycle"]);
        await writeFile(join(source, "README.md"), "base\n");
        await run("git", ["-C", source, "add", "README.md"]);
        await run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
        const { stdout } = await run("git", ["-C", source, "rev-parse", "HEAD"]);
        const owner = `owner-${randomUUID()}`;
        const connection = `connection-${randomUUID()}`;
        const caseId = `case-${randomUUID()}`;
        const caseIdB = `case-${randomUUID()}`;
        await db.query("INSERT INTO owners (owner_id, display_name) VALUES ($1,$2)", [
          owner,
          owner,
        ]);
        await db.query(
          "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ($1,$2,'jira',$3,$4)",
          [connection, owner, "Jira", "unconfigured://wu09-lifecycle"],
        );
        for (const id of [caseId, caseIdB]) {
          await db.query(
            "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ($1,$2,'IMPLEMENTING',$3,$4)",
            [
              id,
              owner,
              JSON.stringify({ providers: ["jira"], connection_ids: [connection] }),
              `thread-${id}`,
            ],
          );
        }
        const registry = adaptWorkspaceRepository(new WorkspaceRepository(), db, workspaceRoot);
        const fenceValidator = { assertCurrent: async () => undefined };
        const config = {
          workspaceRoot,
          repositories: { repo: { sourcePath: source } },
          workspaceRegistry: registry,
          fenceValidator,
        };
        const input = {
          identity: { caseId, workspaceId: "workspace" },
          fence: { leaseOwner: "writer", fencingToken: 1 },
          repositoryId: "repo",
          baseSha: stdout.trim(),
          branchName: `${caseId}/workspace`,
        } as const;
        const inputB = {
          ...input,
          identity: { caseId: caseIdB, workspaceId: "workspace-b" },
          fence: { leaseOwner: "writer", fencingToken: 2 },
          branchName: `${caseIdB}/workspace-b`,
        } as const;
        const createdA = await new LocalWorkspaceAdapter(config).create(input);
        const createdB = await new LocalWorkspaceAdapter(config).create(inputB);
        expect(createdA.lifecycle).toBe("CREATED");
        expect(createdB.lifecycle).toBe("CREATED");
        const restartedRegistry = adaptWorkspaceRepository(
          new WorkspaceRepository(),
          db,
          workspaceRoot,
        );
        const restartedConfig = { ...config, workspaceRegistry: restartedRegistry };
        const resumedA = await new LocalWorkspaceAdapter(restartedConfig).resume({
          identity: input.identity,
          fence: input.fence,
        });
        const resumedB = await new LocalWorkspaceAdapter(restartedConfig).resume({
          identity: inputB.identity,
          fence: inputB.fence,
        });
        expect(resumedA).toMatchObject({ lifecycle: "RESUMED", dirtyState: "CLEAN" });
        expect(resumedB).toMatchObject({ lifecycle: "RESUMED", dirtyState: "CLEAN" });
        const destroyedA = await new LocalWorkspaceAdapter(restartedConfig).destroy(input);
        const destroyedB = await new LocalWorkspaceAdapter(restartedConfig).destroy(inputB);
        expect(destroyedA).toMatchObject({
          lifecycle: "DESTROYED",
          operationId: `cleanup-${caseId}-workspace`,
        });
        expect(destroyedB).toMatchObject({
          lifecycle: "DESTROYED",
          operationId: `cleanup-${caseIdB}-workspace-b`,
        });
        await expect(
          readFile(join(workspaceRoot, caseId, "workspace", "README.md")),
        ).rejects.toThrow();
        await expect(
          readFile(join(workspaceRoot, caseIdB, "workspace-b", "README.md")),
        ).rejects.toThrow();
        await expect(
          new LocalWorkspaceAdapter(restartedConfig).destroy(input),
        ).resolves.toMatchObject({
          lifecycle: "DESTROYED",
          operationId: `cleanup-${caseId}-workspace`,
        });
        await expect(
          new LocalWorkspaceAdapter(restartedConfig).destroy(inputB),
        ).resolves.toMatchObject({
          lifecycle: "DESTROYED",
          operationId: `cleanup-${caseIdB}-workspace-b`,
        });
        await expect(readFile(join(source, "README.md"), "utf8")).resolves.toBe("base\n");
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  },
  available,
);
