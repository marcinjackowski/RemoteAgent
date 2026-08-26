import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  CaseMessageRepository,
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  OwnerRepository,
  WorkUnitRepository,
  type Database,
} from "@remoteagent/database";

import { createEngineeringRoleContextReader } from "../../apps/agent-worker/src/context.js";
import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();
const cutoff = "2026-08-26T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

describeIntegration(
  "RA-040 reply-loop footprint baseline",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    beforeAll(async () => {
      const created = await createTestDatabase();
      // The root suite deliberately combines source test infrastructure with package exports.
      // They share one runtime Database, but source and dist private fields are nominal in TS.
      db = created.db as unknown as Database;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(`TRUNCATE jira_projection_receipts, engineering_run_projections,
      engineering_stage_events, engineering_artifact_revisions, engineering_operations,
      job_reconciliations, job_completions, job_intents, job_attempts, jobs, outbox_dispatch,
      outbox, external_entities, case_checkpoints, agent_runs, work_units, case_messages,
      cases, events, raw_events, connections, owners RESTART IDENTITY CASCADE`);
      const owners = new OwnerRepository();
      const connections = new ConnectionRepository();
      const cases = new CaseRepository();
      await owners.insert(db, { ownerId: "owner-1", displayName: "Owner" });
      await connections.insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "Jira",
      });
      await cases.insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await db.withTransaction((tx) =>
        new CheckpointRepository().ensureBaseline(tx, { caseId: "case-1", updatedAt: cutoff }),
      );
      await new WorkUnitRepository().insert(db, {
        workUnitId: "unit-1",
        caseId: "case-1",
        role: "SUPERVISOR",
        objective: "investigate memoryleak",
        authoritativeScope: {
          connection_ids: ["connection-1"],
          repo_allowlist: [],
          can_write_workspace: false,
        },
      });
      await new WorkUnitRepository().claim(db, {
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
      });
      await db.query("UPDATE agent_runs SET created_at=$2 WHERE run_id=$1", ["run-1", cutoff]);
      await db.query(
        `INSERT INTO case_messages (message_id,case_id,role,trust,body,created_at)
      SELECT 'filler-'||lpad(n::text,2,'0'),'case-1','OWNER','UNTRUSTED_DATA',repeat('ordinary filler '||n||' ',8),$1::timestamptz-make_interval(mins=>30-n) FROM generate_series(1,25) n`,
        [cutoff],
      );
      await db.query(
        `INSERT INTO case_messages (message_id,case_id,role,trust,body,created_at) VALUES
      ('old-relevant','case-1','OWNER','UNTRUSTED_DATA','memoryleak evidence from the beginning',$1::timestamptz-interval '2 days'),
      ('latest-steering','case-1','OWNER','UNTRUSTED_DATA','latest owner steering',$1::timestamptz-interval '1 second'),
      ('late','case-1','OWNER','UNTRUSTED_DATA','memoryleak late',$1::timestamptz+interval '1 second')`,
        [cutoff],
      );
      await db.query(
        `INSERT INTO external_entities (entity_id,case_id,owner_id,connection_id,provider,kind,external_id,url) VALUES ('entity-1','case-1','owner-1','connection-1','jira','jira_issue','RA-040','https://jira.example/RA-040')`,
      );
      await db.query(
        `INSERT INTO outbox (outbox_id,aggregate,aggregate_id,event_type,payload,created_at) VALUES ('outbox-1','jira','case-1','jira.issue.projected','{"body":"RA-040 issue context"}'::jsonb,$1::timestamptz-interval '1 minute')`,
        [cutoff],
      );
      await db.query(
        `INSERT INTO jira_projection_receipts (event_id,owner_id,connection_id,issue_key,case_id,entity_id,outbox_id,canonical_digest,created_at) VALUES ('receipt-1','owner-1','connection-1','RA-040','case-1','entity-1','outbox-1',$2,$1::timestamptz-interval '1 minute')`,
        [cutoff, digest],
      );
    });

    it("beats full-history and legacy-20 footprints while retaining steering and evidence", async () => {
      const all = await db.query<{ role: string; body: string }>(
        "SELECT role,body FROM case_messages WHERE case_id='case-1' ORDER BY created_at,message_id",
      );
      const legacy = await new CaseMessageRepository().listRecent(db, "case-1", 20);
      const render = (rows: readonly { role: string; body: string }[]) =>
        rows.map((row) => `[${row.role}] ${row.body}`).join("\n");
      const fullBytes = Buffer.byteLength(render(all.rows), "utf8");
      const legacyBytes = Buffer.byteLength(render(legacy), "utf8");
      const result = await createEngineeringRoleContextReader({
        db,
        packetBudgetBytes: 3_000,
        recentScanBytes: 500,
        relevantScanBytes: 500,
      })({ caseId: "case-1", runId: "run-1", workUnitId: "unit-1" });
      expect(all.rows.length).toBeGreaterThan(20);
      expect(result.packet).toContain("latest owner steering");
      expect(result.packet).toContain("old-relevant");
      expect(result.packet).toContain("memoryleak evidence from the beginning");
      expect(result.packet).toContain("RA-040 issue context");
      expect(result.packet).not.toContain("memoryleak late");
      expect(result.packet).not.toContain("filler-01");
      expect(result.packetBytes).toBeLessThan(fullBytes);
      expect(result.packetBytes).toBeLessThan(legacyBytes);
      expect(result.estimatedInputTokens).toBe(Math.ceil(result.packetBytes / 4));
      process.stdout.write(
        `RA040_BASELINE full_bytes=${fullBytes} legacy20_bytes=${legacyBytes} new_bytes=${result.packetBytes} full_est=${Math.ceil(fullBytes / 4)} legacy_est=${Math.ceil(legacyBytes / 4)} new_est=${result.estimatedInputTokens}\n`,
      );
    });
  },
  available,
);
