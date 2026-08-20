import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  InMemoryWorkspaceRegistry,
  adaptWorkspaceRepository,
  recoverWorkspace,
} from "../src/index.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import type { Database } from "../../database/src/client.js";
import { computeTreeDigest } from "../src/index.js";
import { WorkspaceRepository } from "../../database/src/repositories/workspace.js";

const run = promisify(execFile);

const available = await ensurePostgres();

describeIntegration(
  "workspace recovery kill matrix",
  () => {
    let db: Database;
    let drop: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => {
      await drop?.();
    });

    it("fails closed for missing mapping, missing target, symlink target and corrupt receipt", async () => {
      const registry = new InMemoryWorkspaceRegistry();
      await expect(recoverWorkspace(registry, "missing")).rejects.toMatchObject({
        code: "MISSING_MAPPING",
      });
      const parent = await mkdtemp(join(tmpdir(), "workspace-recovery-"));
      const target = join(parent, "case", "workspace");
      await mkdir(target, { recursive: true });
      try {
        await registry.recordIntent({
          workspaceId: "workspace",
          caseId: "case",
          repo: "repo",
          baseSha: "a".repeat(40),
          branchName: "branch",
          target,
        });
        await expect(
          recoverWorkspace(registry, "workspace", join(parent, "metadata")),
        ).rejects.toMatchObject({ code: "AMBIGUOUS" });
        await mkdir(join(parent, "metadata"));
        await writeFile(join(parent, "metadata", "operations.jsonl"), "{broken\n");
        await expect(
          recoverWorkspace(registry, "workspace", join(parent, "metadata")),
        ).rejects.toMatchObject({ code: "AMBIGUOUS" });
        await rm(join(parent, "metadata", "operations.jsonl"));
        await writeFile(
          join(parent, "metadata", "operations.jsonl"),
          JSON.stringify({
            version: 1,
            operationId: "plain-worktree",
            identity: { caseId: "case", workspaceId: "workspace" },
            kind: "CREATE_WORKTREE",
            beforeDigest: null,
            afterDigest: "sha256:" + "a".repeat(64),
            outcome: "SUCCEEDED",
          }) + "\n",
        );
        await expect(
          recoverWorkspace(registry, "workspace", join(parent, "metadata")),
        ).rejects.toMatchObject({ code: "AMBIGUOUS" });
        const metadataLink = join(parent, "metadata-link");
        await symlink(join(parent, "metadata"), metadataLink);
        await expect(recoverWorkspace(registry, "workspace", metadataLink)).rejects.toMatchObject({
          code: "AMBIGUOUS",
        });
        await rm(join(parent, "metadata", "operations.jsonl"));
        await symlink(join(parent, "actual-receipt"), join(parent, "metadata", "operations.jsonl"));
        await writeFile(join(parent, "actual-receipt"), "{}\n");
        await expect(
          recoverWorkspace(registry, "workspace", join(parent, "metadata")),
        ).rejects.toMatchObject({ code: "AMBIGUOUS" });
        const actual = join(parent, "actual");
        const linked = join(parent, "linked");
        await mkdir(actual);
        await symlink(actual, linked);
        await registry.recordIntent({
          workspaceId: "linked-workspace",
          caseId: "case",
          repo: "repo",
          baseSha: "a".repeat(40),
          branchName: "branch",
          target: linked,
        });
        await expect(
          recoverWorkspace(registry, "linked-workspace", join(parent, "metadata")),
        ).rejects.toMatchObject({ code: "AMBIGUOUS" });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("keeps DB connection available for restart/kill-point matrix", async () => {
      const root = await mkdtemp(join(tmpdir(), "workspace-recovery-db-"));
      try {
        await db.query("INSERT INTO owners (owner_id, display_name) VALUES ($1,$2)", [
          "owner-recovery",
          "Recovery",
        ]);
        await db.query(
          "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ($1,$2,'jira',$3,$4)",
          ["conn-recovery", "owner-recovery", "Jira", "unconfigured://recovery"],
        );
        await db.query(
          "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ($1,$2,'IMPLEMENTING',$3,$4)",
          [
            "case-recovery",
            "owner-recovery",
            JSON.stringify({ providers: ["jira"], connection_ids: ["conn-recovery"] }),
            "thread-recovery",
          ],
        );
        await db.query(
          "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ($1,$2,'IMPLEMENTING',$3,$4)",
          [
            "case-concurrent",
            "owner-recovery",
            JSON.stringify({ providers: ["jira"], connection_ids: ["conn-recovery"] }),
            "thread-concurrent",
          ],
        );
        const repository = new WorkspaceRepository();
        const registry = adaptWorkspaceRepository(repository, db, root);
        const intent = await registry.recordIntent({
          workspaceId: "workspace-db",
          caseId: "case-recovery",
          repo: "repo",
          baseSha: "a".repeat(40),
          branchName: "branch",
          target: join(root, "case-recovery", "workspace-db"),
        });
        expect(intent.treeDigest).toBeNull();
        const found = await registry.find("workspace-db");
        expect(found?.target).toBe(join(await realpath(root), "case-recovery", "workspace-db"));
        await mkdir(found!.target, { recursive: true });
        await run("git", ["init", "--quiet", found!.target]);
        await run("git", ["-C", found!.target, "config", "user.email", "recovery@example.test"]);
        await run("git", ["-C", found!.target, "config", "user.name", "Recovery"]);
        await writeFile(join(found!.target, "tracked"), "base");
        await run("git", ["-C", found!.target, "add", "tracked"]);
        await run("git", ["-C", found!.target, "commit", "--quiet", "-m", "base"]);
        const digest = await computeTreeDigest(found!.target);
        const metadata = join(root, "metadata");
        await mkdir(metadata);
        await writeFile(
          join(metadata, "operations.jsonl"),
          JSON.stringify({
            version: 1,
            operationId: "db-op",
            identity: { caseId: "case-recovery", workspaceId: "workspace-db" },
            kind: "CREATE_WORKTREE",
            beforeDigest: null,
            afterDigest: digest,
            outcome: "SUCCEEDED",
          }) + "\n",
        );
        const recovered = await recoverWorkspace(registry, "workspace-db", metadata);
        expect(recovered.state).toBe("CLEAN");
        expect((await registry.find("workspace-db"))?.treeDigest).toBe(digest);
        const restartedRegistry = adaptWorkspaceRepository(repository, db, root);
        expect((await restartedRegistry.find("workspace-db"))?.treeDigest).toBe(digest);

        const concurrentInput = {
          workspaceId: "workspace-concurrent",
          caseId: "case-concurrent",
          repo: "repo",
          baseSha: "b".repeat(40),
          branchName: "concurrent/branch",
          target: join(root, "case-concurrent", "workspace-concurrent"),
        };
        const exact = await Promise.all(
          Array.from({ length: 8 }, () => registry.recordIntent(concurrentInput)),
        );
        expect(exact).toHaveLength(8);
        expect(new Set(exact.map((row) => row.workspaceId)).size).toBe(1);
        const conflicting = await Promise.allSettled([
          registry.recordIntent({ ...concurrentInput, repo: "different-repo" }),
          registry.recordIntent({ ...concurrentInput, baseSha: "c".repeat(40) }),
        ]);
        expect(conflicting.filter((result) => result.status === "rejected")).toHaveLength(2);
        expect(
          conflicting.every(
            (result) =>
              result.status === "rejected" &&
              result.reason.name === "WorkspaceMappingConflictError",
          ),
        ).toBe(true);
        expect((await registry.find(concurrentInput.workspaceId))?.repo).toBe("repo");
        const concurrentMapping = await registry.find(concurrentInput.workspaceId);
        const finalizeResults = await Promise.all(
          Array.from({ length: 8 }, () =>
            registry.finalize(concurrentMapping!, "sha256:" + "d".repeat(64)),
          ),
        );
        expect(finalizeResults.filter(Boolean)).toHaveLength(1);
        expect(
          (await adaptWorkspaceRepository(repository, db, root).find(concurrentInput.workspaceId))
            ?.treeDigest,
        ).toBe("sha256:" + "d".repeat(64));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("classifies finalized clean and dirty trees without reset", async () => {
      const parent = await mkdtemp(join(tmpdir(), "workspace-recovery-git-"));
      const target = join(parent, "case", "workspace");
      const metadata = join(parent, "metadata");
      await mkdir(target, { recursive: true });
      try {
        await run("git", ["init", "--quiet", target]);
        await run("git", ["-C", target, "config", "user.email", "recovery@example.test"]);
        await run("git", ["-C", target, "config", "user.name", "Recovery"]);
        await writeFile(join(target, "tracked"), "base");
        await run("git", ["-C", target, "add", "tracked"]);
        await run("git", ["-C", target, "commit", "--quiet", "-m", "base"]);
        const canonicalTarget = await realpath(target);
        const digest = await computeTreeDigest(canonicalTarget);
        const registry = new InMemoryWorkspaceRegistry();
        await registry.recordIntent({
          workspaceId: "workspace",
          caseId: "case",
          repo: "repo",
          baseSha: "a".repeat(40),
          branchName: "branch",
          target: canonicalTarget,
        });
        await mkdir(metadata);
        await writeFile(
          join(metadata, "operations.jsonl"),
          [
            {
              version: 1,
              operationId: "op",
              identity: { caseId: "case", workspaceId: "workspace" },
              kind: "CREATE_WORKTREE",
              beforeDigest: null,
              afterDigest: digest,
              outcome: "SUCCEEDED",
            },
            {
              version: 1,
              operationId: "other-op",
              identity: { caseId: "other-case", workspaceId: "other-workspace" },
              kind: "COMMAND",
              beforeDigest: "sha256:" + "e".repeat(64),
              afterDigest: null,
              outcome: "FAILED",
            },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
        );
        await registry.finalize(
          {
            workspaceId: "workspace",
            caseId: "case",
            repo: "repo",
            baseSha: "a".repeat(40),
            branchName: "branch",
            target: canonicalTarget,
            treeDigest: null,
          },
          digest,
        );
        await expect(recoverWorkspace(registry, "workspace", metadata)).resolves.toMatchObject({
          state: "CLEAN",
        });
        await writeFile(join(target, "tracked"), "changed");
        await expect(recoverWorkspace(registry, "workspace", metadata)).resolves.toMatchObject({
          state: "DIRTY",
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("conditionally finalizes an exact receipt after a restart before DB finalize", async () => {
      const parent = await mkdtemp(join(tmpdir(), "workspace-recovery-receipt-"));
      const target = join(parent, "case", "workspace");
      const metadata = join(parent, "metadata");
      await mkdir(target, { recursive: true });
      try {
        await run("git", ["init", "--quiet", target]);
        await run("git", ["-C", target, "config", "user.email", "recovery@example.test"]);
        await run("git", ["-C", target, "config", "user.name", "Recovery"]);
        await writeFile(join(target, "tracked"), "base");
        await run("git", ["-C", target, "add", "tracked"]);
        await run("git", ["-C", target, "commit", "--quiet", "-m", "base"]);
        const canonicalTarget = await realpath(target);
        const digest = await computeTreeDigest(canonicalTarget);
        const registry = new InMemoryWorkspaceRegistry();
        const mapping = await registry.recordIntent({
          workspaceId: "workspace",
          caseId: "case",
          repo: "repo",
          baseSha: "a".repeat(40),
          branchName: "branch",
          target: canonicalTarget,
        });
        await mkdir(metadata);
        await writeFile(
          join(metadata, "operations.jsonl"),
          JSON.stringify({
            version: 1,
            operationId: "op-receipt",
            identity: { caseId: "case", workspaceId: "workspace" },
            kind: "CREATE_WORKTREE",
            beforeDigest: null,
            afterDigest: digest,
            outcome: "SUCCEEDED",
          }) + "\n",
        );
        const recovered = await recoverWorkspace(registry, mapping.workspaceId, metadata);
        expect(recovered.state).toBe("CLEAN");
        expect(recovered.mapping.treeDigest).toBe(digest);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("rejects conflicting or truncated receipts without replay", async () => {
      const parent = await mkdtemp(join(tmpdir(), "workspace-recovery-receipt-invalid-"));
      const target = join(parent, "case", "workspace");
      const metadata = join(parent, "metadata");
      await mkdir(target, { recursive: true });
      try {
        const canonicalTarget = await realpath(target);
        const registry = new InMemoryWorkspaceRegistry();
        await registry.recordIntent({
          workspaceId: "workspace",
          caseId: "case",
          repo: "repo",
          baseSha: "a".repeat(40),
          branchName: "branch",
          target: canonicalTarget,
        });
        await mkdir(metadata);
        const valid = {
          version: 1,
          operationId: "op",
          identity: { caseId: "case", workspaceId: "workspace" },
          kind: "CREATE_WORKTREE",
          beforeDigest: null,
          afterDigest: "sha256:" + "a".repeat(64),
          outcome: "SUCCEEDED",
        };
        await writeFile(
          join(metadata, "operations.jsonl"),
          JSON.stringify(valid) +
            "\n" +
            JSON.stringify({
              ...valid,
              operationId: "conflict",
              afterDigest: "sha256:" + "b".repeat(64),
            }) +
            "\n",
        );
        await expect(recoverWorkspace(registry, "workspace", metadata)).rejects.toMatchObject({
          code: "AMBIGUOUS",
        });
        await writeFile(join(metadata, "operations.jsonl"), "x".repeat(8 * 1024 * 1024 + 1));
        await expect(recoverWorkspace(registry, "workspace", metadata)).rejects.toMatchObject({
          code: "AMBIGUOUS",
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  },
  available,
);
