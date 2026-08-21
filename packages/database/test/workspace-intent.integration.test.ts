import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  ConnectionRepository,
  OwnerRepository,
  WorkspaceMappingConflictError,
  WorkspaceRepository,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

/**
 * `CTF-012` — the flake the cross-task registry carried as "undiagnosed" across
 * ~15 full-repo runs, with the note that its error message could never be captured.
 *
 * Captured during the RA-024 gate:
 *
 *     duplicate key value violates unique constraint "workspaces_case_id_key"
 *       at WorkspaceRepository.recordIntent (workspace.ts:39)
 *
 * Cause: `workspaces` has TWO unique constraints — `workspace_id` (primary key) and
 * `case_id` (at most one active workspace per case, the single-writer invariant) —
 * and `recordIntent` absorbed conflicts with `ON CONFLICT (workspace_id)`, covering
 * only the first. A concurrent insert that lost the race on `case_id` therefore
 * escaped as a raw driver `23505` instead of `WorkspaceMappingConflictError`.
 *
 * It reproduced only in a full-repo run because it needs two inserts genuinely in
 * flight; the test file ran 5/5 green in isolation. So this suite forces the race
 * DETERMINISTICALLY rather than hoping to observe it — that is the whole point, since
 * a flake reproduced by luck cannot be a regression test.
 */
describeIntegration(
  "workspace intent concurrency (CTF-012)",
  () => {
    let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
    let drop: () => Promise<void>;
    const repository = new WorkspaceRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => {
      await drop();
    });

    beforeEach(async () => {
      await db.query(
        "TRUNCATE workspaces, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner-1" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        alias: "private",
        displayName: "conn-1",
      });
      for (const caseId of ["case-1", "case-2"]) {
        await db.query(
          `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
           VALUES ($1,'owner-1','IMPLEMENTING',
                   '{"providers":["jira"],"connection_ids":["conn-1"]}',$2)`,
          [caseId, `thread-${caseId}`],
        );
      }
    });

    const intent = (workspaceId: string, caseId: string) => ({
      workspaceId,
      caseId,
      repo: "repo",
      baseSha: "a".repeat(40),
      branchName: "case/branch",
    });

    it("absorbs a concurrent identical intent as an idempotent no-op", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repository.recordIntent(db, intent("ws-1", "case-1"))),
      );
      expect(results).toHaveLength(8);
      expect(new Set(results.map((row) => row.workspace_id)).size).toBe(1);
    });

    it("REJECTS a second workspace for the same case with the typed error, not a raw 23505", async () => {
      // THE `CTF-012` CASE. Two different `workspace_id`s claiming one `case_id`, so
      // the losing insert conflicts on `workspaces_case_id_key` and not on the primary
      // key. Before the fix this surfaced as a `pg` error whose `name` is `error`.
      //
      // Asserted on the ERROR TYPE, not on "it threw": the previous behaviour also
      // threw, which is exactly why the flake looked like noise rather than a bug
      // (`CTF-010` finding 1).
      await repository.recordIntent(db, intent("ws-first", "case-1"));
      await expect(repository.recordIntent(db, intent("ws-second", "case-1"))).rejects.toBeInstanceOf(
        WorkspaceMappingConflictError,
      );
    });

    it("rejects both losers when several workspaces race for one case", async () => {
      // Forced concurrency, so the race is not left to scheduling luck. Exactly one
      // may win; every other must fail with the typed error.
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_unused, index) =>
          repository.recordIntent(db, intent(`ws-race-${String(index)}`, "case-2")),
        ),
      );
      const fulfilled = attempts.filter((result) => result.status === "fulfilled");
      const rejected = attempts.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(7);
      for (const failure of rejected) {
        expect(
          failure.status === "rejected" && failure.reason,
          "a lost race must be a typed conflict, never a raw driver error",
        ).toBeInstanceOf(WorkspaceMappingConflictError);
      }
      // And the single-writer invariant held: one row for the case.
      const rows = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM workspaces WHERE case_id = 'case-2'`,
      );
      expect(rows.rows[0]!.n).toBe("1");
    });

    it("still rejects a conflicting intent for the SAME workspace id", async () => {
      // The untargeted `ON CONFLICT DO NOTHING` must not have widened absorption into
      // "any conflict is fine". A same-id intent with different content is still a
      // conflict, because the re-read verification compares every field.
      await repository.recordIntent(db, intent("ws-1", "case-1"));
      for (const conflicting of [
        { ...intent("ws-1", "case-1"), repo: "other-repo" },
        { ...intent("ws-1", "case-1"), baseSha: "b".repeat(40) },
        { ...intent("ws-1", "case-1"), branchName: "other/branch" },
        // A same-id intent naming a DIFFERENT case: the row exists under case-1, so
        // the verification rejects it rather than silently re-pointing the workspace.
        { ...intent("ws-1", "case-2") },
      ]) {
        await expect(repository.recordIntent(db, conflicting)).rejects.toBeInstanceOf(
          WorkspaceMappingConflictError,
        );
      }
    });

    it("leaves the original mapping intact after every rejection", async () => {
      const first = await repository.recordIntent(db, intent("ws-1", "case-1"));
      await expect(
        repository.recordIntent(db, { ...intent("ws-1", "case-1"), repo: "other-repo" }),
      ).rejects.toBeInstanceOf(WorkspaceMappingConflictError);
      expect(await repository.find(db, "ws-1")).toEqual(first);
    });
  },
  available,
);
