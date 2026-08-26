import {
  engineeringArtifactDigest,
  TrustLevel,
  type EngineeringArtifact,
} from "@remoteagent/contracts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database, type Transaction } from "../src/client.js";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  EngineeringContextRepository,
  EngineeringContextSnapshotError,
  OwnerRepository,
  WorkUnitRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();
const DIGEST = `sha256:${"a".repeat(64)}`;
const RUN_CUTOFF = "2026-08-26T12:00:00.000Z";

describeIntegration(
  "engineering context snapshot",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;

    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();
    const checkpoints = new CheckpointRepository();
    const workUnits = new WorkUnitRepository();
    const context = new EngineeringContextRepository();

    const request = {
      caseId: "case-1",
      runId: "run-1",
      workUnitId: "unit-1",
      recentScanBytes: 700,
      relevantScanBytes: 700,
    };

    const artifact: EngineeringArtifact = {
      schema_version: 1,
      artifact_kind: "SliceContract",
      case_id: "case-1",
      run_id: "run-1",
      revision: 1,
      slice_id: "slice-1",
      objective: "bounded objective",
      observable_result: "bounded result",
      allowed_paths: ["packages/database/src"],
      gate_ids: ["gate-1"],
      inspection_method: "inspect snapshot",
      stop_condition: "snapshot compiled",
    };

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

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

      await seedCase("owner-1", "connection-1", "case-1", "thread-1");
      await seedCase("owner-2", "connection-2", "case-2", "thread-2");
      await workUnits.insert(db, {
        workUnitId: "unit-1",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "memoryleak",
        authoritativeScope: {
          connection_ids: ["connection-1"],
          repo_allowlist: [],
          can_write_workspace: true,
        },
      });
      await workUnits.claim(db, {
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
      });
      await db.query("UPDATE agent_runs SET created_at = $2 WHERE run_id = $1", [
        "run-1",
        RUN_CUTOFF,
      ]);

      await db.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body, created_at)
         SELECT 'message-' || n, 'case-1', 'OWNER', 'UNTRUSTED_DATA',
                repeat('filler-' || n || '-', 10),
                $1::timestamptz - make_interval(mins => 30 - n)
           FROM generate_series(1, 25) AS n`,
        [RUN_CUTOFF],
      );
      await db.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body, created_at)
         VALUES
           ('old-relevant', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
            'memoryleak evidence from the beginning of the thread', $1::timestamptz - interval '2 days'),
           ('A', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
            'memoryleak binary tie upper', $1::timestamptz - interval '1 day'),
           ('a', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
            'memoryleak binary tie lower', $1::timestamptz - interval '1 day'),
           ('newer-agent', 'case-1', 'AGENT', 'TRUSTED',
            'newer agent response must not replace owner steering', $1::timestamptz - interval '500 milliseconds'),
           ('late-message', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
            'memoryleak arrived after the pinned run', $1::timestamptz + interval '1 second'),
           ('foreign-message', 'case-2', 'OWNER', 'UNTRUSTED_DATA',
            'memoryleak belongs to another owner and case', $1::timestamptz - interval '1 minute')`,
        [RUN_CUTOFF],
      );

      await seedIssue();
      await seedArtifact(artifact, engineeringArtifactDigest(artifact));
    });

    async function seedCase(
      ownerId: string,
      connectionId: string,
      caseId: string,
      threadId: string,
    ): Promise<void> {
      await owners.insert(db, { ownerId, displayName: ownerId });
      await connections.insert(db, {
        connectionId,
        ownerId,
        provider: "jira",
        displayName: connectionId,
      });
      await cases.insert(db, {
        caseId,
        ownerId,
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: [connectionId] },
        discordThreadId: threadId,
      });
      await db.withTransaction((tx) =>
        checkpoints.ensureBaseline(tx, { caseId, updatedAt: "2026-08-26T10:00:00.000Z" }),
      );
    }

    async function seedIssue(): Promise<void> {
      await db.query(
        `INSERT INTO external_entities
           (entity_id, case_id, owner_id, connection_id, provider, kind, external_id, url)
         VALUES ('entity-1', 'case-1', 'owner-1', 'connection-1', 'jira',
                 'jira_issue', 'RA-040', 'https://jira.example/RA-040')`,
      );
      await db.query(
        `INSERT INTO outbox (outbox_id, aggregate, aggregate_id, event_type, payload, created_at)
         VALUES ('outbox-1', 'jira', 'case-1', 'jira.issue.projected',
                 '{"body":"RA-040 | IN_PROGRESS | compile bounded context"}'::jsonb,
                 $1::timestamptz - interval '1 minute')`,
        [RUN_CUTOFF],
      );
      await db.query(
        `INSERT INTO jira_projection_receipts
           (event_id, owner_id, connection_id, issue_key, case_id, entity_id,
            outbox_id, canonical_digest, created_at)
         VALUES ('receipt-1', 'owner-1', 'connection-1', 'RA-040', 'case-1',
                 'entity-1', 'outbox-1', $2, $1::timestamptz - interval '1 minute')`,
        [RUN_CUTOFF, DIGEST],
      );
    }

    async function seedArtifact(
      payload: EngineeringArtifact,
      payloadDigest: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO jobs
           (job_id, case_id, job_type, status, payload, lease_owner,
            lease_expires_at, fencing_token, attempts, serialization_key)
         VALUES ('job-1', 'case-1', 'engineering', 'LEASED', '{}'::jsonb, 'worker-1',
                 now() + interval '1 hour', 1, 1, 'case-1')`,
      );
      await db.query(
        `INSERT INTO job_intents
           (intent_id, job_id, case_id, fencing_token, kind, descriptor, idempotency_key)
         VALUES ('intent-1', 'job-1', 'case-1', 1, 'MODEL_CALL',
                 '{"prompt":"bounded"}'::jsonb, 'operation-1')`,
      );
      await db.query(
        `INSERT INTO engineering_operations
           (operation_id, intent_id, idempotency_key, job_id, case_id, owner_id,
            run_id, stage, stage_attempt, checkpoint_revision, operation_kind,
            effect_class, integration_scope_digest, input_digest, config_digest,
            schema_digest, deadline_at, recorded_at)
         VALUES ('operation-1', 'intent-1', 'operation-1', 'job-1', 'case-1',
                 'owner-1', 'run-1', 'SLICE_IMPLEMENTATION', 1, 0, 'MODEL_CALL',
                 'MODEL_CALL', $1, $1, $1, $1, $2::timestamptz + interval '1 hour',
                 $2::timestamptz - interval '1 minute')`,
        [DIGEST, RUN_CUTOFF],
      );
      await db.query(
        `INSERT INTO engineering_artifact_revisions
           (artifact_revision_id, artifact_key, revision, artifact_kind, payload,
            payload_digest, operation_id, intent_id, job_id, case_id, owner_id,
            run_id, stage, stage_attempt, checkpoint_revision, recorded_at)
         VALUES ('artifact-1', 'slice-1/contract', 1, 'SliceContract', $1::jsonb,
                 $2, 'operation-1', 'intent-1', 'job-1', 'case-1', 'owner-1',
                 'run-1', 'SLICE_IMPLEMENTATION', 1, 0,
                 $3::timestamptz - interval '1 minute')`,
        [JSON.stringify(payload), payloadDigest, RUN_CUTOFF],
      );
    }

    it("derives one deterministic, cutoff-pinned snapshot from all three layers", async () => {
      const first = await context.readSnapshot(db, request);
      await db.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body, created_at)
         VALUES ('restart-late', 'case-1', 'OWNER', 'UNTRUSTED_DATA',
                 'memoryleak appended between restart reads',
                 $1::timestamptz + interval '2 seconds')`,
        [RUN_CUTOFF],
      );
      const replay = await new EngineeringContextRepository().readSnapshot(db, request);

      expect(replay).toEqual(first);
      expect(first.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.authority).toMatchObject({
        caseId: "case-1",
        ownerId: "owner-1",
        runId: "run-1",
        workUnitId: "unit-1",
        checkpointRevision: 0,
        objective: "memoryleak",
      });
      expect(first.authority.integrationScope).toEqual([
        { provider: "jira", connectionId: "connection-1" },
      ]);

      const issue = first.sources.find((source) => source.sourceType === "ISSUE_CONTEXT");
      expect(issue?.content).toContain("compile bounded context");
      expect(issue?.digest).toBe(DIGEST);
      expect(issue?.ref).toBe("jira-receipt:receipt-1");
      expect(issue?.fullArtifactRef).toBe("jira-receipt:receipt-1");
      expect(issue?.connection).toEqual({ provider: "jira", connectionId: "connection-1" });
      expect(first.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: "case-message:old-relevant",
            selection: expect.objectContaining({ class: "LEXICAL_RELEVANCE" }),
          }),
          expect.objectContaining({
            sourceId: "case-message:message-25",
            selection: expect.objectContaining({ class: "LATEST_OWNER" }),
          }),
          expect.objectContaining({
            sourceType: "SLICE_CONTRACT",
            revision: 1,
            fullArtifactRef: "engineering-artifact:artifact-1",
            selection: expect.objectContaining({ class: "PRIORITY" }),
          }),
        ]),
      );
      expect(
        first.sources.find(({ sourceType }) => sourceType === "WORK_UNIT_OBJECTIVE"),
      ).toHaveProperty("selection.class", "MANDATORY");
      expect(
        first.sources.find(({ sourceType }) => sourceType === "CASE_CHECKPOINT"),
      ).toHaveProperty("selection.class", "MANDATORY");
      expect(first.sources.some(({ content }) => content.includes("late-message"))).toBe(false);
      expect(first.sources.some(({ content }) => content.includes("arrived after"))).toBe(false);
      expect(first.sources.some(({ content }) => content.includes("another owner"))).toBe(false);

      const selectedTranscript = first.sources.filter(
        ({ sourceType }) => sourceType === "CASE_MESSAGE",
      );
      expect(selectedTranscript.length).toBeLessThan(20);
      expect(
        selectedTranscript.some(({ sourceId }) => sourceId === "case-message:old-relevant"),
      ).toBe(true);
      expect(selectedTranscript.map(({ sourceId }) => sourceId)).toEqual(
        expect.arrayContaining(["case-message:A", "case-message:a"]),
      );
      expect(
        selectedTranscript.findIndex(({ sourceId }) => sourceId === "case-message:A"),
      ).toBeLessThan(selectedTranscript.findIndex(({ sourceId }) => sourceId === "case-message:a"));
    });

    it("rejects caller-supplied authority and cross-case bindings", async () => {
      await expect(
        context.readSnapshot(db, { ...request, ownerId: "owner-2" }),
      ).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_INPUT_INVALID",
      });
      await expect(
        context.readSnapshot(db, { ...request, relevanceQuery: "foreign-message" }),
      ).rejects.toMatchObject({ code: "ENGINEERING_CONTEXT_INPUT_INVALID" });
      await expect(
        context.readSnapshot(db, { ...request, caseId: "case-2" }),
      ).rejects.toMatchObject({ code: "ENGINEERING_CONTEXT_SCOPE_MISMATCH" });
    });

    it("executes the complete read in a repeatable-read, read-only transaction", async () => {
      const statements: string[] = [];
      const wrapped = {
        withTransaction: <T>(fn: (tx: Transaction) => Promise<T>) =>
          db.withTransaction((tx) =>
            fn({
              query: async <R extends Record<string, unknown> = Record<string, unknown>>(
                text: string,
                values?: readonly unknown[],
              ) => {
                statements.push(text);
                return tx.query<R>(text, values);
              },
            } as Transaction),
          ),
      };

      await context.readSnapshot(wrapped, request);
      expect(statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    });

    it("skips exact durable discovery ContextManifest provenance but rejects an unknown kind", async () => {
      const manifest: EngineeringArtifact = {
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "case-1",
        run_id: "run-1",
        revision: 0,
        authority: "SERVER_OWNED",
        sources: [
          {
            source_id: "discovery-source",
            kind: "RAW_EVIDENCE",
            ref: "case-message:old-relevant",
            revision: 0,
            observed_at: RUN_CUTOFF,
            digest: DIGEST,
            trust: TrustLevel.UNTRUSTED_DATA,
            freshness: "pinned",
            inclusion_reason: "discovery",
            byte_budget: 64,
            full_artifact_ref: "case-message:old-relevant",
          },
        ],
        total_byte_budget: 128,
      };
      await db.query(
        `INSERT INTO job_intents
           (intent_id, job_id, case_id, fencing_token, kind, descriptor, idempotency_key)
         VALUES ('intent-context','job-1','case-1',1,'engineering.stage.discovery',
                 '{}'::jsonb,'operation-context')`,
      );
      await db.query(
        `INSERT INTO engineering_operations
           (operation_id, intent_id, idempotency_key, job_id, case_id, owner_id,
            run_id, stage, stage_attempt, checkpoint_revision, operation_kind,
            effect_class, integration_scope_digest, input_digest, config_digest,
            schema_digest, deadline_at, recorded_at)
         SELECT 'operation-context','intent-context','operation-context',job_id,case_id,owner_id,
                run_id,'DISCOVERY',1,checkpoint_revision,'engineering.stage.discovery',
                'READ_ONLY',integration_scope_digest,input_digest,config_digest,
                schema_digest,deadline_at,recorded_at
           FROM engineering_operations WHERE operation_id='operation-1'`,
      );
      await db.query(
        `INSERT INTO engineering_artifact_revisions
           (artifact_revision_id, artifact_key, revision, artifact_kind, payload,
            payload_digest, operation_id, intent_id, job_id, case_id, owner_id,
            run_id, stage, stage_attempt, checkpoint_revision, recorded_at)
         VALUES ('artifact-context', 'discovery:1', 0, 'ContextManifest', $1::jsonb,
                 $2, 'operation-context', 'intent-context', 'job-1', 'case-1', 'owner-1',
                 'run-1', 'DISCOVERY', 1, 0, $3::timestamptz)`,
        [JSON.stringify(manifest), engineeringArtifactDigest(manifest), RUN_CUTOFF],
      );

      const snapshot = await context.readSnapshot(db, request);
      expect(snapshot.sources.some(({ sourceId }) => sourceId === "artifact-context")).toBe(false);
      expect(snapshot.sources.some(({ sourceType }) => sourceType === "SLICE_CONTRACT")).toBe(true);

      await db.query(
        "ALTER TABLE engineering_artifact_revisions DISABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await db.query(
        `UPDATE engineering_artifact_revisions
            SET artifact_kind='UnknownArtifact',
                payload=jsonb_set(payload, '{artifact_kind}', '"UnknownArtifact"'::jsonb)
          WHERE artifact_revision_id='artifact-context'`,
      );
      await db.query(
        "ALTER TABLE engineering_artifact_revisions ENABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });
    });

    it("rejects ContextManifest provenance attached to a foreign stage", async () => {
      const manifest: EngineeringArtifact = {
        schema_version: 1,
        artifact_kind: "ContextManifest",
        case_id: "case-1",
        run_id: "run-1",
        revision: 0,
        authority: "SERVER_OWNED",
        sources: [
          {
            source_id: "foreign-stage-source",
            kind: "RAW_EVIDENCE",
            ref: "foreign-stage",
            revision: 0,
            observed_at: RUN_CUTOFF,
            digest: DIGEST,
            trust: TrustLevel.UNTRUSTED_DATA,
            freshness: "pinned",
            inclusion_reason: "mutation",
            byte_budget: 64,
            full_artifact_ref: "foreign-stage",
          },
        ],
        total_byte_budget: 128,
      };
      await db.query(
        `INSERT INTO engineering_artifact_revisions
           (artifact_revision_id, artifact_key, revision, artifact_kind, payload,
            payload_digest, operation_id, intent_id, job_id, case_id, owner_id,
            run_id, stage, stage_attempt, checkpoint_revision, recorded_at)
         VALUES ('artifact-context-foreign', 'discovery-foreign:1', 0, 'ContextManifest',
                 $1::jsonb, $2, 'operation-1', 'intent-1', 'job-1', 'case-1',
                 'owner-1', 'run-1', 'SLICE_IMPLEMENTATION', 1, 0, $3::timestamptz)`,
        [JSON.stringify(manifest), engineeringArtifactDigest(manifest), RUN_CUTOFF],
      );
      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });
    });

    it("skips exact durable SliceImplementationReceipt provenance before gate context", async () => {
      const receipt: EngineeringArtifact = {
        schema_version: 1,
        artifact_kind: "SliceImplementationReceipt",
        case_id: "case-1",
        run_id: "run-1",
        revision: 0,
        authority: "SERVER_OWNED",
        receipt_id: "slice-receipt-1",
        work_unit_id: "unit-1",
        slice_id: "slice-1",
        attempt: 1,
        workspace_id: "workspace-1",
        repository_id: "repo-1",
        base_sha: "a".repeat(40),
        branch: "remoteagent/slice-1",
        baseline: {
          baseline_id: `slice-baseline-${"b".repeat(64)}`,
          tree_digest: `sha256:${"c".repeat(64)}`,
        },
        tree_digest: `sha256:${"d".repeat(64)}`,
        diff_digest: `sha256:${"e".repeat(64)}`,
        raw_patch_digest: `sha256:${"f".repeat(64)}`,
        changed_paths: ["src/one.ts"],
        cumulative_paths: ["src/one.ts"],
        files_changed: 1,
        insertions: 1,
        deletions: 0,
        tool_receipt_digests: [DIGEST],
      };
      await db.query(
        `INSERT INTO engineering_artifact_revisions
           (artifact_revision_id, artifact_key, revision, artifact_kind, payload,
            payload_digest, operation_id, intent_id, job_id, case_id, owner_id,
            run_id, stage, stage_attempt, checkpoint_revision, recorded_at)
         VALUES ('artifact-implementation', 'implementation:1', 0,
                 'SliceImplementationReceipt', $1::jsonb, $2,
                 'operation-1', 'intent-1', 'job-1', 'case-1', 'owner-1',
                 'run-1', 'SLICE_IMPLEMENTATION', 1, 0, $3::timestamptz)`,
        [JSON.stringify(receipt), engineeringArtifactDigest(receipt), RUN_CUTOFF],
      );

      const snapshot = await context.readSnapshot(db, request);
      expect(snapshot.sources.some(({ sourceId }) => sourceId === "artifact-implementation")).toBe(
        false,
      );
      expect(snapshot.sources.some(({ sourceType }) => sourceType === "SLICE_CONTRACT")).toBe(true);

      const mismatched = { ...receipt, attempt: 2 } as EngineeringArtifact;
      await db.query(
        "ALTER TABLE engineering_artifact_revisions DISABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await db.query(
        `UPDATE engineering_artifact_revisions SET payload=$1::jsonb, payload_digest=$2
          WHERE artifact_revision_id='artifact-implementation'`,
        [JSON.stringify(mismatched), engineeringArtifactDigest(mismatched)],
      );
      await db.query(
        "ALTER TABLE engineering_artifact_revisions ENABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });

      const foreignWorkUnit = { ...receipt, work_unit_id: "unit-foreign" } as EngineeringArtifact;
      await db.query(
        "ALTER TABLE engineering_artifact_revisions DISABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await db.query(
        `UPDATE engineering_artifact_revisions SET payload=$1::jsonb, payload_digest=$2
          WHERE artifact_revision_id='artifact-implementation'`,
        [JSON.stringify(foreignWorkUnit), engineeringArtifactDigest(foreignWorkUnit)],
      );
      await db.query(
        "ALTER TABLE engineering_artifact_revisions ENABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });

      const wrongCheckpointRevision = { ...receipt, revision: 1 } as EngineeringArtifact;
      await db.query(
        "ALTER TABLE engineering_artifact_revisions DISABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await db.query(
        `UPDATE engineering_artifact_revisions
            SET revision=1, payload=$1::jsonb, payload_digest=$2
          WHERE artifact_revision_id='artifact-implementation'`,
        [
          JSON.stringify(wrongCheckpointRevision),
          engineeringArtifactDigest(wrongCheckpointRevision),
        ],
      );
      await db.query(
        "ALTER TABLE engineering_artifact_revisions ENABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });
    });

    it("fails closed when a durable artifact payload or digest is corrupt", async () => {
      await db.query(
        "ALTER TABLE engineering_artifact_revisions DISABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      await db.query(
        "UPDATE engineering_artifact_revisions SET payload_digest = $1 WHERE artifact_revision_id = 'artifact-1'",
        [`sha256:${"b".repeat(64)}`],
      );
      await db.query(
        "ALTER TABLE engineering_artifact_revisions ENABLE TRIGGER engineering_artifact_revisions_append_only",
      );

      await expect(context.readSnapshot(db, request)).rejects.toBeInstanceOf(
        EngineeringContextSnapshotError,
      );
      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });
    });

    it("fails closed when the durable issue receipt has no bounded body", async () => {
      await db.query("ALTER TABLE outbox DISABLE TRIGGER outbox_append_only");
      await db.query("UPDATE outbox SET payload = '{}'::jsonb WHERE outbox_id = 'outbox-1'");
      await db.query("ALTER TABLE outbox ENABLE TRIGGER outbox_append_only");

      await expect(context.readSnapshot(db, request)).rejects.toMatchObject({
        code: "ENGINEERING_CONTEXT_DATA_INVALID",
      });
    });
  },
  available,
);
