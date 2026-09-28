import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { compileEngineeringContext } from "@remoteagent/agent-orchestrator";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  WorkUnitRepository,
  resolvePoolConfig,
} from "@remoteagent/database";
import { ContextCacheState, MetricName, MetricRegistry } from "@remoteagent/observability";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { createEngineeringRoleContextReader } from "../src/context.js";

const available = await ensurePostgres();
const CUTOFF = "2026-08-26T12:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

const isolatedDatabaseConfig = (database: string) => {
  const base = resolvePoolConfig();
  if (base.connectionString !== undefined) {
    const url = new URL(base.connectionString);
    url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }
  return { ...base, database };
};

describeIntegration(
  "production engineering reply context",
  () => {
    let db: Database;
    let drop: () => Promise<void>;

    beforeAll(async () => {
      const created = await createTestDatabase();
      // Reopen the isolated database through the package identity used by production
      // repositories; the source test harness intentionally owns only setup/teardown.
      const packageDb = new Database(isolatedDatabaseConfig(created.name));
      try {
        const identity = await packageDb.query<{ database_name: string }>(
          "SELECT current_database() AS database_name",
        );
        expect(identity.rows[0]?.database_name).toBe(created.name);
        db = packageDb;
      } catch (error) {
        await packageDb.close();
        await created.drop();
        throw error;
      }
      drop = async () => {
        await db.close();
        await created.drop();
      };
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      await db.query(
        `TRUNCATE jira_projection_receipts, engineering_run_projections,
                engineering_stage_events, engineering_artifact_revisions,
                engineering_operations, job_reconciliations, job_completions,
                job_intents, job_attempts, jobs, outbox_dispatch, outbox,
                external_entities, case_checkpoints, agent_runs, work_units,
                case_messages, cases, events, raw_events, connections, owners
       RESTART IDENTITY CASCADE`,
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "Owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "Jira",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await db.withTransaction((tx) =>
        new CheckpointRepository().ensureBaseline(tx, {
          caseId: "case-1",
          updatedAt: "2026-08-26T10:00:00.000Z",
        }),
      );
      await new WorkUnitRepository().insert(db, {
        workUnitId: "unit-1",
        caseId: "case-1",
        role: "SUPERVISOR",
        objective: "investigate memoryleak and reply",
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
      await db.query("UPDATE agent_runs SET created_at = $2 WHERE run_id = $1", ["run-1", CUTOFF]);

      await db.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body, created_at)
       SELECT 'message-' || lpad(n::text, 2, '0'), 'case-1', 'OWNER', 'UNTRUSTED_DATA',
              repeat('ordinary filler ' || n || ' ', 6),
              $1::timestamptz - make_interval(mins => 30 - n)
         FROM generate_series(1, 25) AS n`,
        [CUTOFF],
      );
      await db.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body, created_at)
       VALUES
         ('old-relevant', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
          'memoryleak evidence from the beginning', $1::timestamptz - interval '2 days'),
         ('latest-steering', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
          'latest owner steering', $1::timestamptz - interval '1 second'),
         ('late', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
          'memoryleak arrived too late', $1::timestamptz + interval '1 second')`,
        [CUTOFF],
      );
      await db.query(
        `INSERT INTO external_entities
         (entity_id, case_id, owner_id, connection_id, provider, kind, external_id, url)
       VALUES ('entity-1', 'case-1', 'owner-1', 'connection-1', 'jira',
               'jira_issue', 'RA-040', 'https://jira.example/RA-040')`,
      );
      await db.query(
        `INSERT INTO outbox (outbox_id, aggregate, aggregate_id, event_type, payload, created_at)
       VALUES ('outbox-1', 'jira', 'case-1', 'jira.issue.projected',
               '{"body":"RA-040 issue context"}'::jsonb,
               $1::timestamptz - interval '1 minute')`,
        [CUTOFF],
      );
      await db.query(
        `INSERT INTO jira_projection_receipts
         (event_id, owner_id, connection_id, issue_key, case_id, entity_id,
          outbox_id, canonical_digest, created_at)
       VALUES ('receipt-1', 'owner-1', 'connection-1', 'RA-040', 'case-1',
               'entity-1', 'outbox-1', $2, $1::timestamptz - interval '1 minute')`,
        [CUTOFF, DIGEST],
      );
    });

    it("rebuilds a deterministic bounded packet from projection, issue, relevant and recent lanes", async () => {
      const metrics = new MetricRegistry();
      const readContext = createEngineeringRoleContextReader({
        db,
        metrics,
        packetBudgetBytes: 3_000,
        recentScanBytes: 500,
        relevantScanBytes: 500,
      });
      const request = { caseId: "case-1", runId: "run-1", workUnitId: "unit-1" };
      const first = await readContext(request);
      const replay = await readContext(request);

      expect(replay.packet).toBe(first.packet);
      expect(replay.snapshotDigest).toBe(first.snapshotDigest);
      expect(first.packetBytes).toBeLessThanOrEqual(3_000);
      expect(first.packet).toContain("CASE_CHECKPOINT");
      expect(first.packet).toContain("RA-040 issue context");
      expect(first.packet).toContain("old-relevant");
      expect(first.packet).toContain("memoryleak evidence from the beginning");
      expect(first.packet).toContain("latest owner steering");
      expect(first.packet).not.toContain("memoryleak arrived too late");
      expect(first.packet).not.toContain("message-01");
      expect(first.compiled.context.omitted).toHaveLength(0);
      expect(first.compiled.manifest.sources.length).toBeLessThan(29);

      expect(metrics.counter(MetricName.CONTEXT_PACKET_BYTES)).toBe(first.packetBytes * 2);
      expect(metrics.counter(MetricName.CONTEXT_ESTIMATED_INPUT_TOKENS)).toBe(
        first.estimatedInputTokens * 2,
      );
      expect(
        metrics.counter(MetricName.CONTEXT_CACHE_OBSERVATIONS, {
          kind: "DISCOVERY",
          outcome: ContextCacheState.NOT_OBSERVED,
        }),
      ).toBe(2);
      expect(metrics.counter(MetricName.MODEL_INPUT_TOKENS)).toBe(0);
    });

    it("renders content and safe references from the compiler output boundary", async () => {
      const readContext = createEngineeringRoleContextReader({
        db,
        packetBudgetBytes: 3_000,
        recentScanBytes: 500,
        relevantScanBytes: 500,
        compiler: (input) => {
          const compiled = compileEngineeringContext(input);
          return {
            ...compiled,
            context: {
              ...compiled.context,
              fragments: compiled.context.fragments.map((selection) => ({
                ...selection,
                fragment: {
                  ...selection.fragment,
                  content: `compiler-boundary:${selection.fragment.provenance.reference}`,
                },
              })),
            },
            manifest: {
              ...compiled.manifest,
              sources: compiled.manifest.sources.map((source) => ({
                ...source,
                ref: `compiled:${source.source_id}`,
              })),
            },
          };
        },
      });

      const result = await readContext({
        caseId: "case-1",
        runId: "run-1",
        workUnitId: "unit-1",
      });
      expect(result.packet).toContain("compiler-boundary:work-unit:unit-1:objective");
      expect(result.packet).toContain("compiled:work-unit:unit-1:objective");
      expect(result.packet).not.toContain("investigate memoryleak and reply");
      expect(result.packet).not.toContain("latest owner steering");
    });

    it("rejects an unobserved runtime cache label outside the closed states", () => {
      expect(() =>
        createEngineeringRoleContextReader({ db, cacheState: "owner@example.test" as never }),
      ).toThrow(/cacheState must be/);
    });

    it("removes a registered opaque literal from the final packet and telemetry", async () => {
      await db.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body, created_at)
       VALUES ('opaque-message', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
               'keep request opaque-canary-no-shape private', $1::timestamptz - interval '500 milliseconds')`,
        [CUTOFF],
      );
      const metrics = new MetricRegistry(["opaque-canary-no-shape"]);
      const result = await createEngineeringRoleContextReader({
        db,
        metrics,
        packetBudgetBytes: 3_000,
        recentScanBytes: 500,
        relevantScanBytes: 500,
        knownSecrets: ["opaque-canary-no-shape"],
      })({ caseId: "case-1", runId: "run-1", workUnitId: "unit-1" });
      expect(result.packet).toContain("keep request");
      expect(result.packet).not.toContain("opaque-canary-no-shape");
      expect(JSON.stringify(metrics.snapshot())).not.toContain("opaque-canary-no-shape");
    });
  },
  available,
);
