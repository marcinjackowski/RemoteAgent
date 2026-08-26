import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AgentRole, engineeringWriteDeploymentPolicyV1Digest } from "@remoteagent/contracts";

import { Database } from "../src/client.js";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  DiscordBindingRepository,
  ApprovalRepository,
  EngineeringApprovalIngressError,
  EngineeringApprovalIngressRepository,
  EngineeringGrantedProposalRepository,
  EngineeringStopIngressRepository,
  OwnerRepository,
  WorkUnitRepository,
} from "../src/repositories/index.js";
import { JobStore, JobType, ManualClock, SequentialIdGenerator } from "../src/queue/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();
const NOW = Date.now();
const POLICY = Object.freeze({
  schema_version: 1 as const,
  purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY" as const,
  repository_id: "remote-agent",
  write_path_allowlist: ["apps/agent-worker", "packages/contracts"],
});

type CreatedProposal = Extract<
  Awaited<ReturnType<EngineeringApprovalIngressRepository["propose"]>>,
  { status: "created" | "replayed" }
>;

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (Reflect.get(error, "code") as string | undefined)
    : undefined;
}

describeIntegration(
  "engineering approval ingress",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    let clock: ManualClock;
    let ingress: EngineeringApprovalIngressRepository;

    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();
    const checkpoints = new CheckpointRepository();
    const bindings = new DiscordBindingRepository();

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
        `TRUNCATE engineering_write_proposals, approvals, outbox, jobs, work_units,
                  case_checkpoints, agent_runs, discord_case_bindings, case_messages,
                  cases, events, raw_events, connections, owners
         RESTART IDENTITY CASCADE`,
      );
      clock = new ManualClock(NOW);
      ingress = createIngress(clock, POLICY);
      await seedCase("case-1", "owner-1", "connection-1", "thread-1");
      await seedCase("case-2", "owner-2", "connection-2", "thread-2");
    });

    function createIngress(
      runtimeClock: ManualClock,
      deploymentPolicy: unknown,
    ): EngineeringApprovalIngressRepository {
      return new EngineeringApprovalIngressRepository({
        runtime: {
          clock: runtimeClock,
          ids: new SequentialIdGenerator(),
          leaseTime: "db",
        },
        deploymentPolicy,
        proposalTtlMs: 600_000,
      });
    }

    async function seedCase(
      caseId: string,
      ownerId: string,
      connectionId: string,
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
      await db.withTransaction(async (tx) => {
        await checkpoints.ensureBaseline(tx, {
          caseId,
          updatedAt: new Date(NOW).toISOString(),
        });
        await bindings.ensure(tx, { caseId, ownerId, channelId: `channel-${ownerId}` });
        await bindings.setThread(tx, caseId, {
          threadId,
          rootMessageId: `root-${ownerId}`,
        });
      });
    }

    async function propose(
      suffix = "1",
      caseId = "case-1",
      actorId = "discord-owner-1",
    ): Promise<CreatedProposal> {
      const result = await ingress.propose(db, {
        caseId,
        actorId,
        interactionId: `proposal-interaction-${suffix}`,
      });
      expect(result.status).toBe("created");
      if (result.status !== "created") throw new Error("proposal was not created");
      return result;
    }

    async function authorityCounts(caseId = "case-1"): Promise<Record<string, number>> {
      const result = await db.query<Record<string, string>>(
        `SELECT
           (SELECT count(*) FROM approvals WHERE case_id=$1)::text AS approvals,
           (SELECT count(*) FROM work_units WHERE case_id=$1)::text AS work_units,
           (SELECT count(*) FROM agent_runs WHERE case_id=$1)::text AS runs,
           (SELECT count(*) FROM jobs WHERE case_id=$1)::text AS jobs`,
        [caseId],
      );
      const row = result.rows[0]!;
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
    }

    it("persists an immutable proposal and Discord outbox without creating runnable work", async () => {
      const created = await propose();
      const replay = await ingress.propose(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "proposal-interaction-1",
      });

      expect(replay).toEqual({ ...created, status: "replayed" });
      expect(created.proposal.authorization_scope).toMatchObject({
        case_id: "case-1",
        owner_id: "owner-1",
        checkpoint_revision: 0,
        work_unit_id: created.workUnitId,
        run_id: created.runId,
        process_class: "LARGE_OR_HIGH_RISK",
        repository_id: POLICY.repository_id,
        write_path_allowlist: POLICY.write_path_allowlist,
        authoritative_scope: {
          connection_ids: [],
          repo_allowlist: [POLICY.repository_id],
          can_write_workspace: true,
        },
      });
      expect(created.proposal.action_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const outbox = await db.query<{
        aggregate: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT aggregate, aggregate_id, event_type, payload
           FROM outbox WHERE outbox_id=$1`,
        [created.outboxId],
      );
      expect(outbox.rows[0]).toMatchObject({
        aggregate: "discord_case",
        aggregate_id: "case-1",
        event_type: "discord.thread_message",
        payload: {
          case_id: "case-1",
          seq: 1,
          engineering_proposal: {
            proposal_id: created.proposal.proposal_id,
            checkpoint_revision: 0,
          },
        },
      });
      expect(JSON.stringify(outbox.rows[0]?.payload)).not.toMatch(/token|secret|credential/i);
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
    });

    it("atomically grants the exact approval, unit, run and implementer job and replays once", async () => {
      const created = await propose();
      const granted = await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "grant-interaction-1",
        proposalId: created.proposal.proposal_id,
        checkpointRevision: 0,
        choice: "grant",
      });
      expect(granted.status).toBe("granted");
      if (granted.status !== "granted") throw new Error("grant did not materialize");

      const durable = await db.query<{
        status: string;
        approval_id: string;
        job_id: string;
        action_digest: string;
        approval_digest: string;
        granted_by: string;
        consumed: boolean;
        approval_expires_at: Date;
        proposal_expires_at: Date;
        work_status: string;
        authoritative_scope: Record<string, unknown>;
        safety_state: string;
        checkpoint_revision: number;
        job_status: string;
        job_type: string;
        serialization_key: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT p.status, p.approval_id, p.job_id, p.action_digest,
                a.action_digest AS approval_digest, a.granted_by, a.consumed,
                a.expires_at AS approval_expires_at, p.expires_at AS proposal_expires_at,
                w.status AS work_status, w.authoritative_scope,
                r.safety_state, r.checkpoint_revision,
                j.status AS job_status, j.job_type, j.serialization_key, j.payload
           FROM engineering_write_proposals p
           JOIN approvals a ON a.approval_id=p.approval_id
           JOIN work_units w ON w.work_unit_id=p.work_unit_id
           JOIN agent_runs r ON r.run_id=p.run_id
           JOIN jobs j ON j.job_id=p.job_id
          WHERE p.proposal_id=$1`,
        [created.proposal.proposal_id],
      );
      expect(durable.rows[0]).toMatchObject({
        status: "GRANTED",
        approval_id: granted.approvalId,
        job_id: granted.jobId,
        action_digest: created.proposal.action_digest,
        approval_digest: created.proposal.action_digest,
        granted_by: "discord-owner-1",
        consumed: false,
        work_status: "DISPATCHED",
        authoritative_scope: {
          connection_ids: [],
          repo_allowlist: [POLICY.repository_id],
          can_write_workspace: true,
        },
        safety_state: "PLANNED",
        checkpoint_revision: 0,
        job_status: "PENDING",
        job_type: "agent.implementer",
        serialization_key: "case-1",
        payload: {
          reason: "engineering_approval",
          caseId: "case-1",
          proposalId: created.proposal.proposal_id,
          approvalId: granted.approvalId,
          checkpointRevision: 0,
          workUnitId: created.workUnitId,
          runId: created.runId,
          repoId: POLICY.repository_id,
        },
      });

      await expect(
        new EngineeringGrantedProposalRepository().assertExact(db, {
          proposalId: created.proposal.proposal_id,
          approvalId: granted.approvalId,
          jobId: granted.jobId,
          caseId: "case-1",
          ownerId: "owner-1",
          checkpointRevision: 0,
          workUnitId: created.workUnitId,
          runId: created.runId,
          repositoryId: POLICY.repository_id,
          writePathAllowlist: POLICY.write_path_allowlist,
          deploymentPolicyDigest: engineeringWriteDeploymentPolicyV1Digest(POLICY),
          actionDigest: created.proposal.action_digest,
        }),
      ).resolves.toMatchObject({ proposal_id: created.proposal.proposal_id, status: "GRANTED" });
      await expect(
        new EngineeringGrantedProposalRepository().assertExact(db, {
          proposalId: created.proposal.proposal_id,
          approvalId: granted.approvalId,
          jobId: "foreign-job",
          caseId: "case-1",
          ownerId: "owner-1",
          checkpointRevision: 0,
          workUnitId: created.workUnitId,
          runId: created.runId,
          repositoryId: POLICY.repository_id,
          writePathAllowlist: POLICY.write_path_allowlist,
          deploymentPolicyDigest: engineeringWriteDeploymentPolicyV1Digest(POLICY),
          actionDigest: created.proposal.action_digest,
        }),
      ).rejects.toThrow(/exact worker materialization/);
      for (const mutation of [
        { writePathAllowlist: ["apps/discord-bot"] },
        {
          deploymentPolicyDigest: engineeringWriteDeploymentPolicyV1Digest({
            ...POLICY,
            write_path_allowlist: ["apps/discord-bot"],
          }),
        },
      ]) {
        await expect(
          new EngineeringGrantedProposalRepository().assertExact(db, {
            proposalId: created.proposal.proposal_id,
            approvalId: granted.approvalId,
            jobId: granted.jobId,
            caseId: "case-1",
            ownerId: "owner-1",
            checkpointRevision: 0,
            workUnitId: created.workUnitId,
            runId: created.runId,
            repositoryId: POLICY.repository_id,
            writePathAllowlist: POLICY.write_path_allowlist,
            deploymentPolicyDigest: engineeringWriteDeploymentPolicyV1Digest(POLICY),
            actionDigest: created.proposal.action_digest,
            ...mutation,
          }),
        ).rejects.toThrow(/exact worker materialization/);
      }
      expect(durable.rows[0]?.approval_expires_at).toEqual(durable.rows[0]?.proposal_expires_at);
      expect(Object.keys(durable.rows[0]!.payload).sort()).toEqual(
        [
          "approvalId",
          "caseId",
          "checkpointRevision",
          "proposalId",
          "reason",
          "repoId",
          "runId",
          "workUnitId",
        ].sort(),
      );
      const interactions = await db.query<{
        interaction_id: string;
        case_id: string;
        owner_id: string;
        proposal_id: string;
        checkpoint_revision: number;
        interaction_kind: string;
      }>(
        `SELECT interaction_id, case_id, owner_id, proposal_id,
                checkpoint_revision, interaction_kind
           FROM engineering_ingress_interactions
          ORDER BY interaction_kind`,
      );
      expect(interactions.rows).toEqual([
        {
          interaction_id: "grant-interaction-1",
          case_id: "case-1",
          owner_id: "owner-1",
          proposal_id: created.proposal.proposal_id,
          checkpoint_revision: 0,
          interaction_kind: "GRANT",
        },
        {
          interaction_id: "proposal-interaction-1",
          case_id: "case-1",
          owner_id: "owner-1",
          proposal_id: created.proposal.proposal_id,
          checkpoint_revision: 0,
          interaction_kind: "PROPOSE",
        },
      ]);

      const replay = await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "grant-interaction-1",
        proposalId: created.proposal.proposal_id,
        checkpointRevision: 0,
        choice: "grant",
      });
      expect(replay).toEqual({ ...granted, status: "replayed" });
      expect(await authorityCounts()).toEqual({ approvals: 1, work_units: 1, runs: 1, jobs: 1 });
    });

    it("keeps STOP available without constructing deployment write policy", async () => {
      const created = await propose("policy-independent-stop");
      const stop = new EngineeringStopIngressRepository({ runtime: { clock } });
      await expect(
        stop.stop(db, {
          caseId: "case-1",
          actorId: "discord-snowflake-distinct-from-owner",
          interactionId: "policy-independent-stop",
        }),
      ).resolves.toEqual({
        status: "stopped",
        stoppedProposalIds: [created.proposal.proposal_id],
      });
      expect((await ingress.findById(db, created.proposal.proposal_id))?.status).toBe("STOPPED");
      expect((await cases.findById(db, "case-1"))?.owner_id).toBe("owner-1");
      expect((await cases.findById(db, "case-1"))?.status).toBe("CANCELLED");
    });

    it.each([
      ["deny", false],
      ["expire", true],
    ] as const)("%s terminalizes without authority", async (_scenario, expire) => {
      const created = await propose();
      if (expire) clock.advance(600_001);
      const response = await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: `${expire ? "expire" : "deny"}-interaction-1`,
        proposalId: created.proposal.proposal_id,
        checkpointRevision: 0,
        choice: expire ? "grant" : "deny",
      });
      expect(response.status).toBe(expire ? "expired" : "denied");
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });

      const exactReplay = await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: `${expire ? "expire" : "deny"}-interaction-1`,
        proposalId: created.proposal.proposal_id,
        checkpointRevision: 0,
        choice: expire ? "grant" : "deny",
      });
      expect(exactReplay).toMatchObject({
        status: expire ? "expired" : "denied",
        proposalStatus: expire ? "EXPIRED" : "DENIED",
      });

      const terminalReplay = await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "later-interaction",
        proposalId: created.proposal.proposal_id,
        checkpointRevision: 0,
        choice: "grant",
      });
      expect(terminalReplay).toMatchObject({
        status: "already_terminal",
        proposalStatus: expire ? "EXPIRED" : "DENIED",
      });
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
    });

    it("atomically expires an unattended pending proposal before creating its successor", async () => {
      const expired = await propose("unattended");
      clock.advance(600_001);
      const successor = await ingress.propose(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "proposal-interaction-successor",
      });
      expect(successor.status).toBe("created");
      expect((await ingress.findById(db, expired.proposal.proposal_id))?.status).toBe("EXPIRED");
      const expiry = await db.query<{
        interaction_id: string;
        interaction_kind: string;
        owner_id: string;
      }>(
        `SELECT interaction_id, interaction_kind, owner_id
           FROM engineering_ingress_interactions
          WHERE proposal_id=$1 AND interaction_kind='EXPIRE'`,
        [expired.proposal.proposal_id],
      );
      expect(expiry.rows).toEqual([
        {
          interaction_id: `system:engineering-expire:${expired.proposal.proposal_id}`,
          interaction_kind: "EXPIRE",
          owner_id: "owner-1",
        },
      ]);
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
    });

    it("rejects stale, foreign and interaction-colliding responses before authority", async () => {
      const first = await propose("first");
      const second = await propose("second", "case-2", "discord-owner-2");

      await expect(
        ingress.respond(db, {
          caseId: "case-2",
          actorId: "discord-owner-2",
          interactionId: "foreign-case",
          proposalId: first.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "grant",
        }),
      ).rejects.toThrow(EngineeringApprovalIngressError);
      await expect(
        ingress.respond(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "stale-button",
          proposalId: first.proposal.proposal_id,
          checkpointRevision: 1,
          choice: "grant",
        }),
      ).rejects.toThrow(/stale/);

      await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "shared-terminal-interaction",
        proposalId: first.proposal.proposal_id,
        checkpointRevision: 0,
        choice: "deny",
      });
      await expect(
        ingress.respond(db, {
          caseId: "case-2",
          actorId: "discord-owner-2",
          interactionId: "shared-terminal-interaction",
          proposalId: second.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "deny",
        }),
      ).rejects.toThrow(/interaction id/i);

      await expect(
        ingress.respond(db, {
          caseId: "case-2",
          actorId: "discord-owner-2",
          interactionId: "proposal-interaction-first",
          proposalId: second.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "deny",
        }),
      ).rejects.toThrow(/interaction id/i);
      expect(await authorityCounts("case-1")).toEqual({
        approvals: 0,
        work_units: 0,
        runs: 0,
        jobs: 0,
      });
      expect(await authorityCounts("case-2")).toEqual({
        approvals: 0,
        work_units: 0,
        runs: 0,
        jobs: 0,
      });
    });

    it("rejects a moved case checkpoint and deployment-policy drift", async () => {
      const stale = await propose("stale");
      await db.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id='case-1'");
      await expect(
        ingress.respond(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "stale-case-revision",
          proposalId: stale.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "grant",
        }),
      ).rejects.toThrow(/revision moved/);
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });

      await db.query("UPDATE cases SET checkpoint_revision=0 WHERE case_id='case-1'");
      const drifted = createIngress(clock, {
        ...POLICY,
        write_path_allowlist: ["apps/discord-bot"],
      });
      await expect(
        drifted.respond(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "policy-drift",
          proposalId: stale.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "grant",
        }),
      ).rejects.toThrow(/engineering proposal authority is corrupt|write ceiling changed/);
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
    });

    it("serializes duplicate grants and creates exactly one writer", async () => {
      const created = await propose();
      const responses = await Promise.all([
        ingress.respond(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "grant-winner-a",
          proposalId: created.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "grant",
        }),
        ingress.respond(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "grant-winner-b",
          proposalId: created.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "grant",
        }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        "already_terminal",
        "granted",
      ]);
      expect(await authorityCounts()).toEqual({ approvals: 1, work_units: 1, runs: 1, jobs: 1 });
      expect(
        await ingress.propose(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "proposal-after-grant",
        }),
      ).toEqual({ status: "ignored", reason: "writer_active" });
      expect(await authorityCounts()).toEqual({ approvals: 1, work_units: 1, runs: 1, jobs: 1 });
    });

    it("serializes concurrent proposals to one outbox row and no work", async () => {
      const results = await Promise.all([
        ingress.propose(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "proposal-race-a",
        }),
        ingress.propose(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "proposal-race-b",
        }),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["created", "ignored"]);
      expect(results.find((result) => result.status === "ignored")).toEqual({
        status: "ignored",
        reason: "proposal_pending",
      });
      const rows = await db.query<{ proposals: string; outbox: string }>(
        `SELECT (SELECT count(*) FROM engineering_write_proposals WHERE case_id='case-1')::text
                  AS proposals,
                (SELECT count(*) FROM outbox WHERE aggregate_id='case-1')::text AS outbox`,
      );
      expect(rows.rows[0]).toEqual({ proposals: "1", outbox: "1" });
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
    });

    it("keeps a stop-first proposal authority-free when a late grant arrives", async () => {
      const created = await propose();
      expect(
        await ingress.stop(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "stop-before-grant",
        }),
      ).toEqual({ status: "stopped", stoppedProposalIds: [created.proposal.proposal_id] });
      expect(
        await ingress.respond(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "grant-after-stop",
          proposalId: created.proposal.proposal_id,
          checkpointRevision: 0,
          choice: "grant",
        }),
      ).toEqual({
        status: "already_terminal",
        proposalId: created.proposal.proposal_id,
        proposalStatus: "STOPPED",
      });
      expect((await ingress.findById(db, created.proposal.proposal_id))?.status).toBe("STOPPED");
      expect((await cases.findById(db, "case-1"))?.status).toBe("CANCELLED");
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
    });

    it("preserves an exact grant but cancels its case when stop arrives second", async () => {
      const created = await propose();
      const granted = await ingress.respond(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "grant-before-stop",
        proposalId: created.proposal.proposal_id,
        checkpointRevision: 0,
        choice: "grant",
      });
      expect(granted.status).toBe("granted");
      expect(
        await ingress.stop(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "stop-after-grant",
        }),
      ).toEqual({ status: "stopped", stoppedProposalIds: [] });
      expect((await ingress.findById(db, created.proposal.proposal_id))?.status).toBe("GRANTED");
      expect((await cases.findById(db, "case-1"))?.status).toBe("CANCELLED");
      expect(await authorityCounts()).toEqual({ approvals: 1, work_units: 1, runs: 1, jobs: 1 });
    });

    it("stops pending authority idempotently and refuses later work", async () => {
      const created = await propose();
      const stopped = await ingress.stop(db, {
        caseId: "case-1",
        actorId: "discord-owner-1",
        interactionId: "stop-1",
      });
      expect(stopped).toEqual({
        status: "stopped",
        stoppedProposalIds: [created.proposal.proposal_id],
      });
      expect(
        await ingress.stop(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "stop-1",
        }),
      ).toEqual({
        status: "replayed",
        stoppedProposalIds: [created.proposal.proposal_id],
      });
      expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
      expect(
        await ingress.propose(db, {
          caseId: "case-1",
          actorId: "discord-owner-1",
          interactionId: "after-stop",
        }),
      ).toEqual({ status: "ignored", reason: "case_CANCELLED" });
    });

    describe("database authority guards", () => {
      it("rejects proposal authority mutation, deletion and grant without materialization", async () => {
        const created = await propose();
        const proposalId = created.proposal.proposal_id;

        const mutationError = await db
          .query(
            "UPDATE engineering_write_proposals SET repository_id='foreign-repo' WHERE proposal_id=$1",
            [proposalId],
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgCode(mutationError)).toBe("P0103");

        const grantError = await db
          .query(
            `UPDATE engineering_write_proposals
                SET status='GRANTED', terminal_interaction_id='direct-grant',
                    terminal_choice='GRANT', terminal_actor_id='discord-owner-1', terminal_at=now(),
                    approval_id='missing-approval', job_id='missing-job'
              WHERE proposal_id=$1`,
            [proposalId],
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgCode(grantError)).toBeDefined();

        const deleteError = await db
          .query("DELETE FROM engineering_write_proposals WHERE proposal_id=$1", [proposalId])
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgCode(deleteError)).toBe("P0100");
        expect((await ingress.findById(db, proposalId))?.status).toBe("PENDING");
        expect(await authorityCounts()).toEqual({ approvals: 0, work_units: 0, runs: 0, jobs: 0 });
      });

      it("keeps the global interaction identity ledger append-only", async () => {
        await propose();
        const updateError = await db
          .query(
            `UPDATE engineering_ingress_interactions
                SET owner_id='owner-2'
              WHERE interaction_id='proposal-interaction-1'`,
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgCode(updateError)).toBe("P0100");

        const deleteError = await db
          .query(
            "DELETE FROM engineering_ingress_interactions WHERE interaction_id='proposal-interaction-1'",
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(pgCode(deleteError)).toBe("P0100");
        const ledger = await db.query<{ interaction_kind: string }>(
          `SELECT interaction_kind FROM engineering_ingress_interactions
            WHERE interaction_id='proposal-interaction-1'`,
        );
        expect(ledger.rows).toEqual([{ interaction_kind: "PROPOSE" }]);
      });

      it.each([
        "consumed",
        "wrong-granter",
        "expiry-drift",
        "stale-case",
        "terminal-case",
        "extra-job-key",
      ] as const)(
        "rejects direct GRANTED materialization with a %s approval/case fence",
        async (tamper) => {
          const created = await propose();
          const proposal = await ingress.findById(db, created.proposal.proposal_id);
          expect(proposal).not.toBeNull();
          if (proposal === null) throw new Error("proposal disappeared");
          const approvals = new ApprovalRepository();
          const units = new WorkUnitRepository();
          const jobs = new JobStore({
            clock,
            ids: new SequentialIdGenerator(),
            leaseTime: "db",
          });

          const direct = db.withTransaction(async (tx) => {
            const approvalId = "direct-approval";
            const expiresAt =
              tamper === "expiry-drift"
                ? new Date(proposal.expires_at.getTime() + 1_000)
                : proposal.expires_at;
            const grant = await approvals.grant(tx, {
              approvalId,
              caseId: proposal.case_id,
              grantedBy: tamper === "wrong-granter" ? "discord-owner-2" : "discord-owner-1",
              actionDigest: proposal.action_digest,
              checkpointRevision: proposal.checkpoint_revision,
              expiresAt,
            });
            expect(grant.outcome).toBe("GRANTED");
            await units.insert(tx, {
              workUnitId: proposal.work_unit_id,
              caseId: proposal.case_id,
              role: AgentRole.IMPLEMENTER,
              objective: proposal.objective,
              authoritativeScope: {
                can_write_workspace: true,
                connection_ids: [...proposal.authoritative_scope.connection_ids],
                repo_allowlist: [...proposal.authoritative_scope.repo_allowlist],
              },
            });
            await units.claimInTransaction(tx, {
              workUnitId: proposal.work_unit_id,
              runId: proposal.run_id,
              checkpointRevision: proposal.checkpoint_revision,
            });
            const job = await jobs.enqueue(tx, {
              jobType: JobType.AGENT_IMPLEMENTER,
              caseId: proposal.case_id,
              payload: {
                reason: "engineering_approval",
                caseId: proposal.case_id,
                proposalId: proposal.proposal_id,
                approvalId,
                checkpointRevision: proposal.checkpoint_revision,
                workUnitId: proposal.work_unit_id,
                runId: proposal.run_id,
                repoId: proposal.repository_id,
                ...(tamper === "extra-job-key" ? { spoofedAuthority: true } : {}),
              },
            });
            await tx.query(
              `INSERT INTO engineering_ingress_interactions (
                 interaction_id, case_id, owner_id, proposal_id, checkpoint_revision,
                 interaction_kind, recorded_at)
               VALUES ('direct-grant', $1, $2, $3, $4, 'GRANT', $5)`,
              [
                proposal.case_id,
                proposal.owner_id,
                proposal.proposal_id,
                proposal.checkpoint_revision,
                new Date(clock.now()).toISOString(),
              ],
            );
            if (tamper === "consumed") {
              const consumed = await approvals.consume(tx, {
                approvalId,
                caseId: proposal.case_id,
                ownerId: proposal.owner_id,
                actionDigest: proposal.action_digest,
              });
              expect(consumed.outcome).toBe("CONSUMED");
            }
            if (tamper === "stale-case") {
              await tx.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id=$1", [
                proposal.case_id,
              ]);
            }
            if (tamper === "terminal-case") {
              await tx.query("UPDATE cases SET status='CANCELLED' WHERE case_id=$1", [
                proposal.case_id,
              ]);
            }
            await tx.query(
              `UPDATE engineering_write_proposals
                  SET status='GRANTED', terminal_interaction_id='direct-grant',
                      terminal_choice='GRANT', terminal_actor_id='discord-owner-1', terminal_at=$2,
                      approval_id=$3, job_id=$4
                WHERE proposal_id=$1`,
              [proposal.proposal_id, new Date(clock.now()).toISOString(), approvalId, job.job_id],
            );
          });
          const error = await direct.then(
            () => null,
            (caught: unknown) => caught,
          );
          expect(pgCode(error)).toBe("P0103");
          expect((await ingress.findById(db, proposal.proposal_id))?.status).toBe("PENDING");
          expect(await authorityCounts()).toEqual({
            approvals: 0,
            work_units: 0,
            runs: 0,
            jobs: 0,
          });
        },
      );
    });
  },
  available,
);
