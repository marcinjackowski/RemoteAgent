import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { EngineeringRuntimePort } from "@remoteagent/agent-orchestrator";
import {
  ApprovalRepository,
  DiscordBindingRepository,
  EngineeringApprovalIngressRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
  type EngineeringWriteProposalRow,
} from "@remoteagent/database";
import { afterEach, expect, it } from "vitest";

import {
  createDiscordBotFromEnv,
  type DiscordBot,
  type DiscordEnvConfig,
  type GatewaySocket,
  type GatewaySocketHandlers,
  type RestRequest,
  type RestResponse,
} from "../../apps/discord-bot/src/index.js";
import { createDiscordProcess } from "../../apps/discord-bot/src/discord.js";
import {
  EngineeringQualificationTransport,
  createEngineeringQualificationFixture,
  type EngineeringQualificationFixture,
} from "../../apps/agent-worker/test/engineering-qualification-fixture.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();
const run = promisify(execFile);
const discordActorId = "900000000000000001";
const threadId = "engineering-thread";

interface CapturedMessage {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

interface BotHarness {
  readonly bot: DiscordBot;
  readonly messages: CapturedMessage[];
  readonly acknowledgements: string[];
  dispatch(input: Record<string, unknown>): void;
  stop(): void;
}

function config(): DiscordEnvConfig {
  return {
    token: "REDACTED-ENGINEERING-E2E-TOKEN",
    guildId: "guild-engineering",
    ownerId: discordActorId,
    botUserId: "900000000000000002",
    gatewayUrl: "wss://gateway.invalid",
    channels: {
      jira: "channel-jira",
      "gmail-private": "channel-gmail-private",
      "gmail-sondermind": "channel-gmail-sondermind",
      "calendar-private": "channel-calendar-private",
      "calendar-sondermind": "channel-calendar-sondermind",
      gitlab: "channel-gitlab",
      system: "channel-system",
    },
  };
}

function createBotHarness(
  db: Database,
  fixture: EngineeringQualificationFixture,
  input: {
    readonly deploymentPolicy?:
      EngineeringQualificationFixture["config"]["writeDeploymentPolicy"] | null;
    readonly startProcess?: boolean;
  } = {},
): BotHarness {
  let handlers: GatewaySocketHandlers | null = null;
  let sequence = 1;
  let messageSequence = 0;
  const messages: CapturedMessage[] = [];
  const acknowledgements: string[] = [];
  const restTransport = async (request: RestRequest): Promise<RestResponse> => {
    if (request.path.includes("/interactions/")) {
      acknowledgements.push(request.path);
      return { status: 204, headers: {}, body: null };
    }
    if (request.method === "GET" && request.path === `/api/v10/channels/${threadId}`) {
      return {
        status: 200,
        headers: {},
        body: { id: threadId, thread_metadata: { archived: false } },
      };
    }
    if (request.method === "POST" && request.path === `/api/v10/channels/${threadId}/messages`) {
      messages.push({ path: request.path, body: request.body as Record<string, unknown> });
      messageSequence += 1;
      return { status: 200, headers: {}, body: { id: `discord-message-${messageSequence}` } };
    }
    throw new Error(`unexpected Discord REST request ${request.method} ${request.path}`);
  };
  const socketFactory = (_url: string, socketHandlers: GatewaySocketHandlers): GatewaySocket => {
    handlers = socketHandlers;
    return {
      send: () => undefined,
      close: () => socketHandlers.onClose(1000),
    };
  };
  const bot = createDiscordBotFromEnv(config(), db, {
    restTransport,
    socketFactory,
    deploymentPolicy:
      input.deploymentPolicy === undefined
        ? fixture.config.writeDeploymentPolicy
        : input.deploymentPolicy,
  });
  bot.session.start();
  const gatewayHandlers = handlers as GatewaySocketHandlers | null;
  if (gatewayHandlers === null) throw new Error("Discord gateway socket was not composed");
  gatewayHandlers.onOpen();
  gatewayHandlers.onMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  gatewayHandlers.onMessage(
    JSON.stringify({
      op: 0,
      s: sequence,
      t: "READY",
      d: { session_id: "engineering-session", resume_gateway_url: "wss://gateway.invalid" },
    }),
  );
  const process =
    input.startProcess === true ? createDiscordProcess({ bot, db, relayIntervalMs: 5 }) : null;
  process?.start();
  let stopped = false;
  return {
    bot,
    messages,
    acknowledgements,
    dispatch: (input) => {
      sequence += 1;
      gatewayHandlers.onMessage(
        JSON.stringify({ op: 0, s: sequence, t: "INTERACTION_CREATE", d: input }),
      );
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (process === null) bot.session.stop();
      else void process.stopAcceptingWork();
    },
  };
}

function slash(id: string, name: "engineering" | "stop", actorId = discordActorId) {
  return {
    id,
    token: `interaction-token-${id}`,
    type: 2,
    guild_id: "guild-engineering",
    channel_id: threadId,
    member: { user: { id: actorId } },
    data: { name },
  };
}

function button(id: string, customId: string, actorId = discordActorId) {
  return {
    id,
    token: `interaction-token-${id}`,
    type: 3,
    guild_id: "guild-engineering",
    channel_id: threadId,
    member: { user: { id: actorId } },
    data: { custom_id: customId },
  };
}

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for durable engineering ingress state");
}

async function proposalForCase(db: Database, caseId: string): Promise<EngineeringWriteProposalRow> {
  const proposal = await eventually(
    async () => {
      const result = await db.query<EngineeringWriteProposalRow>(
        `SELECT * FROM engineering_write_proposals WHERE case_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [caseId],
      );
      return result.rows[0] ?? null;
    },
    (row) => row !== null,
  );
  if (proposal === null) throw new Error("proposal disappeared after durable observation");
  return proposal;
}

function customId(messages: readonly CapturedMessage[], choice: "grant" | "deny"): string {
  const ids = messages.flatMap(({ body }) => {
    const rows = body.components as
      | ReadonlyArray<{ readonly components?: ReadonlyArray<{ readonly custom_id?: string }> }>
      | undefined;
    return (rows ?? [])
      .flatMap((row) => row.components ?? [])
      .flatMap((item) => item.custom_id ?? []);
  });
  const match = ids.find((id) => id.startsWith("v1:engineering:") && id.endsWith(`:${choice}`));
  if (match === undefined) {
    throw new Error(
      `dedicated engineering ${choice} button was not sent: ${JSON.stringify(messages)}`,
    );
  }
  return match;
}

async function bindDiscord(fixture: EngineeringQualificationFixture): Promise<void> {
  const bindings = new DiscordBindingRepository();
  await fixture.db.withTransaction(async (tx) => {
    await bindings.ensure(tx, {
      caseId: fixture.ids.caseId,
      ownerId: fixture.ids.ownerId,
      channelId: "channel-system",
    });
    await bindings.setThread(tx, fixture.ids.caseId, {
      threadId,
      rootMessageId: "root-message",
    });
  });
}

async function awaitProposalPublished(
  fixture: EngineeringQualificationFixture,
  bot: BotHarness,
  proposal: EngineeringWriteProposalRow,
): Promise<void> {
  await eventually(
    async () => {
      const dispatch = await fixture.db.query<{ status: string }>(
        "SELECT status FROM outbox_dispatch WHERE outbox_id=$1",
        [proposal.discord_outbox_id],
      );
      return { status: dispatch.rows[0]?.status, messages: bot.messages.length };
    },
    (observed) => observed.status === "PUBLISHED" && observed.messages === 1,
  );
  expect(bot.messages).toHaveLength(1);
}

const highRiskPolicy = {
  riskFacts: {
    authority: "SERVER_OWNED" as const,
    multi_module: false,
    security_or_policy: true,
    migration: false,
    irreversible_side_effect: false,
    broad_public_contract_change: false,
    new_architecture: false,
    deterministic_oracle: true,
    user_data: false,
    concurrency: false,
    external_side_effect: false,
  },
};

describeIntegration(
  "RA-046 production engineering approval ingress",
  () => {
    const fixtures: EngineeringQualificationFixture[] = [];
    const bots: BotHarness[] = [];

    afterEach(async () => {
      for (const bot of bots.splice(0)) bot.stop();
      for (const fixture of fixtures.splice(0)) await fixture.drop();
    });

    it("runs raw Discord proposal through durable button, exact grant job, claim and production local commit", async () => {
      const fixture = await createEngineeringQualificationFixture({
        id: "approval-ingress-golden",
        preallocateWriter: false,
      });
      fixtures.push(fixture);
      await bindDiscord(fixture);

      const first = createBotHarness(fixture.db, fixture);
      bots.push(first);
      first.dispatch(slash("interaction-propose-golden", "engineering"));
      const proposal = await proposalForCase(fixture.db, fixture.ids.caseId);
      expect(proposal.owner_id).toBe(fixture.ids.ownerId);
      expect(proposal.owner_id).not.toBe(discordActorId);

      // Fresh composition re-entry with the same raw interaction recovers exact preallocated IDs.
      first.stop();
      const replay = createBotHarness(fixture.db, fixture, { startProcess: true });
      bots.push(replay);
      replay.dispatch(slash("interaction-propose-golden", "engineering"));
      await eventually(
        () =>
          fixture.db.query<{ count: string }>("SELECT count(*) FROM engineering_write_proposals"),
        (result) => result.rows[0]?.count === "1",
      );
      const recovered = await new EngineeringApprovalIngressRepository({
        runtime: productionRuntime(),
        deploymentPolicy: fixture.config.writeDeploymentPolicy,
      }).findById(fixture.db, proposal.proposal_id);
      expect(recovered).toMatchObject({
        proposal_id: proposal.proposal_id,
        work_unit_id: proposal.work_unit_id,
        run_id: proposal.run_id,
        discord_outbox_id: proposal.discord_outbox_id,
      });

      await awaitProposalPublished(fixture, replay, proposal);
      const grantButton = customId(replay.messages, "grant");
      replay.dispatch(button("interaction-grant-golden", grantButton));
      const granted = await eventually(
        () =>
          new EngineeringApprovalIngressRepository({
            runtime: productionRuntime(),
            deploymentPolicy: fixture.config.writeDeploymentPolicy,
          }).findById(fixture.db, proposal.proposal_id),
        (row) => row?.status === "GRANTED",
      );
      expect(granted).not.toBeNull();
      expect(granted!.terminal_actor_id).toBe(discordActorId);
      expect(granted!.approval_id).not.toBeNull();
      expect(granted!.job_id).not.toBeNull();

      // Simulate losing the Discord response after the transaction committed. Fresh composition
      // receives the identical provider interaction and recovers the exact materialization.
      replay.stop();
      const grantReplay = createBotHarness(fixture.db, fixture);
      bots.push(grantReplay);
      grantReplay.dispatch(button("interaction-grant-golden", grantButton));
      await eventually(
        async () => grantReplay.acknowledgements.length,
        (count) => count === 1,
      );
      const afterGrantReplay = await new EngineeringApprovalIngressRepository({
        runtime: productionRuntime(),
        deploymentPolicy: fixture.config.writeDeploymentPolicy,
      }).findById(fixture.db, proposal.proposal_id);
      expect(afterGrantReplay).toMatchObject({
        status: "GRANTED",
        approval_id: granted!.approval_id,
        job_id: granted!.job_id,
        work_unit_id: proposal.work_unit_id,
        run_id: proposal.run_id,
      });
      const replayCounts = await fixture.db.query<{
        approvals: string;
        units: string;
        runs: string;
        jobs: string;
      }>(
        `SELECT
         (SELECT count(*) FROM approvals)::text approvals,
         (SELECT count(*) FROM work_units)::text units,
         (SELECT count(*) FROM agent_runs)::text runs,
         (SELECT count(*) FROM jobs WHERE job_type='agent.implementer')::text jobs`,
      );
      expect(replayCounts.rows[0]).toEqual({ approvals: "1", units: "1", runs: "1", jobs: "1" });

      const unit = await new WorkUnitRepository().findById(fixture.db, proposal.work_unit_id);
      const job = await fixture.jobs.findById(fixture.db, granted!.job_id!);
      const approval = await new ApprovalRepository().findById(fixture.db, granted!.approval_id!);
      expect(unit).toMatchObject({
        work_unit_id: proposal.work_unit_id,
        case_id: fixture.ids.caseId,
        run_id: proposal.run_id,
        status: "DISPATCHED",
      });
      expect(approval).toMatchObject({
        approval_id: granted!.approval_id,
        case_id: fixture.ids.caseId,
        owner_id: fixture.ids.ownerId,
        granted_by: discordActorId,
        consumed: false,
      });
      expect(Object.keys(job!.payload).sort()).toEqual(
        [
          "reason",
          "caseId",
          "proposalId",
          "approvalId",
          "checkpointRevision",
          "workUnitId",
          "runId",
          "repoId",
        ].sort(),
      );
      expect(job!.payload).toEqual({
        reason: "engineering_approval",
        caseId: fixture.ids.caseId,
        proposalId: proposal.proposal_id,
        approvalId: granted!.approval_id,
        checkpointRevision: 0,
        workUnitId: proposal.work_unit_id,
        runId: proposal.run_id,
        repoId: fixture.ids.repositoryId,
      });

      const lease = await fixture.jobs.claim(fixture.db, {
        owner: "production-ingress-worker",
        leaseMs: 300_000,
      });
      expect(lease).not.toBeNull();
      const transport = new EngineeringQualificationTransport({
        caseId: fixture.ids.caseId,
        runId: proposal.run_id,
        sliceIds: ["slice-1", "slice-2", "slice-3"],
        implementationPaths: ["src/ingress-1.ts", "src/ingress-2.ts", "src/ingress-3.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const identity = {
        unit: { workUnit: unit! },
        run: { runId: proposal.run_id, checkpointRevision: 0 },
      } as unknown as Parameters<EngineeringRuntimePort["open"]>[0];

      const missingProposalLease = {
        ...lease!,
        payload: Object.fromEntries(
          Object.entries(lease!.payload).filter(([key]) => key !== "proposalId"),
        ),
      };
      expect(() =>
        fixture.makeProduction(missingProposalLease, { transport, policy: highRiskPolicy }),
      ).toThrow(/bounded approval binding/);

      for (const refusedLease of [
        { ...lease!, jobId: "foreign-job" },
        { ...lease!, fencingToken: lease!.fencingToken + 1 },
        { ...lease!, payload: { ...lease!.payload, proposalId: "foreign-proposal" } },
      ]) {
        const refused = fixture.makeProduction(refusedLease, {
          transport,
          policy: highRiskPolicy,
        });
        await expect(refused.port.open(identity)).rejects.toThrow();
      }

      const driftedPolicy = {
        ...fixture.config,
        writePathAllowlist: ["foreign-path"],
        testPathAllowlist: ["foreign-path"],
        writeDeploymentPolicy: {
          ...fixture.config.writeDeploymentPolicy,
          write_path_allowlist: ["foreign-path"],
        },
      };
      const drifted = fixture.makeProduction(lease!, {
        transport,
        policy: highRiskPolicy,
        executionConfig: driftedPolicy,
      });
      await expect(drifted.port.open(identity)).rejects.toThrow(/exact worker materialization/);
      expect(transport.requests).toHaveLength(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [fixture.ids.caseId]))
          .rowCount,
      ).toBe(0);
      expect(
        (await new ApprovalRepository().findById(fixture.db, granted!.approval_id!))?.consumed,
      ).toBe(false);

      const production = fixture.makeProduction(lease!, { transport, policy: highRiskPolicy });
      await production.handler(lease!, async () => undefined);

      const consumed = await new ApprovalRepository().findById(fixture.db, granted!.approval_id!);
      expect(consumed?.consumed).toBe(true);
      const artifacts = await fixture.db.query<{
        artifact_kind: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT artifact_kind,payload FROM engineering_artifact_revisions
        WHERE run_id=$1 ORDER BY revision`,
        [proposal.run_id],
      );
      expect(artifacts.rows.some((row) => row.artifact_kind === "EvidenceBundle")).toBe(true);
      expect(
        artifacts.rows.filter((row) => row.artifact_kind === "LocalCommitReceipt"),
      ).toHaveLength(1);
      const head = (
        await run("git", ["-C", fixture.sourcePath, "rev-parse", "main"])
      ).stdout.trim();
      const remotes = (await run("git", ["-C", fixture.sourcePath, "remote"])).stdout.trim();
      expect(head).toBe(fixture.baseSha);
      expect(remotes).toBe("");
    });

    it("keeps deny and policy-independent stop authority-free and generic buttons inert", async () => {
      const fixture = await createEngineeringQualificationFixture({
        id: "approval-ingress-controls",
        preallocateWriter: false,
      });
      fixtures.push(fixture);
      await bindDiscord(fixture);
      const bot = createBotHarness(fixture.db, fixture, { startProcess: true });
      bots.push(bot);

      bot.dispatch(button("generic-decision", "v1:decision:not-engineering:0:grant"));
      bot.dispatch(button("generic-approval", "v1:approval:not-engineering:0:grant"));
      bot.dispatch(slash("foreign-proposal", "engineering", "900000000000009999"));
      await eventually(
        async () => bot.acknowledgements.length,
        (count) => count === 3,
      );
      expect((await fixture.db.query("SELECT 1 FROM approvals")).rowCount).toBe(0);
      expect((await fixture.db.query("SELECT 1 FROM external_actions")).rowCount).toBe(0);
      expect((await fixture.db.query("SELECT 1 FROM engineering_write_proposals")).rowCount).toBe(
        0,
      );

      bot.dispatch(slash("interaction-propose-deny", "engineering"));
      const proposal = await proposalForCase(fixture.db, fixture.ids.caseId);
      await awaitProposalPublished(fixture, bot, proposal);
      bot.dispatch(
        button(
          "interaction-generic-exact-proposal",
          `v1:approval:${proposal.proposal_id}:${proposal.checkpoint_revision}:grant`,
        ),
      );
      await eventually(
        async () => bot.acknowledgements.length,
        (count) => count === 5,
      );
      expect(
        (
          await fixture.db.query<{ status: string }>(
            "SELECT status FROM engineering_write_proposals WHERE proposal_id=$1",
            [proposal.proposal_id],
          )
        ).rows[0]?.status,
      ).toBe("PENDING");
      expect(
        (
          await fixture.db.query<{ approvals: string; units: string; runs: string; jobs: string }>(
            `SELECT
               (SELECT count(*) FROM approvals)::text approvals,
               (SELECT count(*) FROM work_units)::text units,
               (SELECT count(*) FROM agent_runs)::text runs,
               (SELECT count(*) FROM jobs WHERE job_type='agent.implementer')::text jobs`,
          )
        ).rows[0],
      ).toEqual({ approvals: "0", units: "0", runs: "0", jobs: "0" });
      bot.dispatch(
        button("interaction-foreign-proposal", "v1:engineering:foreign-proposal:0:grant"),
      );
      bot.dispatch(
        button("interaction-stale-proposal", `v1:engineering:${proposal.proposal_id}:1:grant`),
      );
      await eventually(
        async () => bot.acknowledgements.length,
        (count) => count === 7,
      );
      expect(
        (
          await fixture.db.query<{ status: string }>(
            "SELECT status FROM engineering_write_proposals WHERE proposal_id=$1",
            [proposal.proposal_id],
          )
        ).rows[0]?.status,
      ).toBe("PENDING");
      expect((await fixture.db.query("SELECT 1 FROM approvals")).rowCount).toBe(0);
      bot.dispatch(button("interaction-deny", customId(bot.messages, "deny")));
      await eventually(
        () =>
          fixture.db.query<{ status: string }>(
            "SELECT status FROM engineering_write_proposals WHERE proposal_id=$1",
            [proposal.proposal_id],
          ),
        (result) => result.rows[0]?.status === "DENIED",
      );
      expect((await fixture.db.query("SELECT 1 FROM approvals")).rowCount).toBe(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM jobs WHERE job_type='agent.implementer'")).rowCount,
      ).toBe(0);

      bot.dispatch(slash("interaction-propose-stop", "engineering"));
      await eventually(
        () =>
          fixture.db.query<{ pending: string; total: string }>(
            `SELECT
               count(*) FILTER (WHERE status='PENDING')::text pending,
               count(*)::text total
               FROM engineering_write_proposals`,
          ),
        (result) => result.rows[0]?.pending === "1" && result.rows[0]?.total === "2",
      );

      const disabled = createBotHarness(fixture.db, fixture, { deploymentPolicy: null });
      bots.push(disabled);
      disabled.dispatch(slash("interaction-disabled-propose", "engineering"));
      disabled.dispatch(slash("interaction-stop", "stop"));
      await eventually(
        () =>
          fixture.db.query<{ status: string }>("SELECT status FROM cases WHERE case_id=$1", [
            fixture.ids.caseId,
          ]),
        (result) => result.rows[0]?.status === "CANCELLED",
      );
      expect((await fixture.db.query("SELECT 1 FROM approvals")).rowCount).toBe(0);
      expect(
        (
          await fixture.db.query<{ stopped: string; total: string }>(
            `SELECT
               count(*) FILTER (WHERE status='STOPPED')::text stopped,
               count(*)::text total
               FROM engineering_write_proposals`,
          )
        ).rows[0],
      ).toEqual({ stopped: "1", total: "2" });
    });

    it("cancels a granted job before the production worker reaches model, workspace or write", async () => {
      const fixture = await createEngineeringQualificationFixture({
        id: "approval-ingress-grant-stop",
        preallocateWriter: false,
      });
      fixtures.push(fixture);
      await bindDiscord(fixture);
      const bot = createBotHarness(fixture.db, fixture, { startProcess: true });
      bots.push(bot);

      bot.dispatch(slash("interaction-propose-grant-stop", "engineering"));
      const proposal = await proposalForCase(fixture.db, fixture.ids.caseId);
      await awaitProposalPublished(fixture, bot, proposal);
      bot.dispatch(button("interaction-grant-before-stop", customId(bot.messages, "grant")));
      const granted = await eventually(
        () =>
          new EngineeringApprovalIngressRepository({
            runtime: productionRuntime(),
            deploymentPolicy: fixture.config.writeDeploymentPolicy,
          }).findById(fixture.db, proposal.proposal_id),
        (row) => row?.status === "GRANTED",
      );
      expect(granted?.job_id).not.toBeNull();

      bot.dispatch(slash("interaction-stop-after-grant", "stop"));
      await eventually(
        () =>
          fixture.db.query<{ status: string }>("SELECT status FROM cases WHERE case_id=$1", [
            fixture.ids.caseId,
          ]),
        (result) => result.rows[0]?.status === "CANCELLED",
      );
      expect(
        (
          await fixture.db.query<{ status: string }>(
            "SELECT status FROM engineering_write_proposals WHERE proposal_id=$1",
            [proposal.proposal_id],
          )
        ).rows[0]?.status,
      ).toBe("GRANTED");

      const lease = await fixture.jobs.claim(fixture.db, {
        owner: "production-ingress-cancelled-worker",
        leaseMs: 300_000,
      });
      expect(lease?.jobId).toBe(granted?.job_id);
      const transport = new EngineeringQualificationTransport({
        caseId: fixture.ids.caseId,
        runId: proposal.run_id,
        sliceIds: ["slice-1"],
        implementationPaths: ["src/ingress.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const production = fixture.makeProduction(lease!, {
        transport,
        policy: highRiskPolicy,
      });
      await production.handler(lease!, async () => undefined);

      expect(transport.requests).toHaveLength(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [fixture.ids.caseId]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await fixture.db.query("SELECT 1 FROM engineering_operations WHERE run_id=$1", [
            proposal.run_id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await fixture.db.query("SELECT 1 FROM engineering_artifact_revisions WHERE run_id=$1", [
            proposal.run_id,
          ])
        ).rowCount,
      ).toBe(0);
      const head = (
        await run("git", ["-C", fixture.sourcePath, "rev-parse", "main"])
      ).stdout.trim();
      expect(head).toBe(fixture.baseSha);
    });

    it("allows only one proposal and one grant winner across concurrent production bot instances", async () => {
      const fixture = await createEngineeringQualificationFixture({
        id: "approval-ingress-concurrency",
        preallocateWriter: false,
      });
      fixtures.push(fixture);
      await bindDiscord(fixture);
      const left = createBotHarness(fixture.db, fixture, { startProcess: true });
      const right = createBotHarness(fixture.db, fixture);
      bots.push(left, right);
      left.dispatch(slash("interaction-propose-left", "engineering"));
      right.dispatch(slash("interaction-propose-right", "engineering"));
      await eventually(
        async () => [left.acknowledgements.length, right.acknowledgements.length] as const,
        ([leftCount, rightCount]) => leftCount === 1 && rightCount === 1,
      );
      const proposal = await proposalForCase(fixture.db, fixture.ids.caseId);
      await eventually(
        () =>
          fixture.db.query<{ count: string }>("SELECT count(*) FROM engineering_write_proposals"),
        (result) => result.rows[0]?.count === "1",
      );
      await awaitProposalPublished(fixture, left, proposal);
      const grant = customId(left.messages, "grant");
      left.dispatch(button("interaction-grant-left", grant));
      right.dispatch(button("interaction-grant-right", grant));
      await eventually(
        async () => {
          const durable = await fixture.db.query<{ interaction_id: string }>(
            `SELECT interaction_id FROM engineering_ingress_interactions
              WHERE interaction_id=ANY($1::text[]) ORDER BY interaction_id`,
            [["interaction-grant-left", "interaction-grant-right"]],
          );
          return {
            acknowledgements: [left.acknowledgements.length, right.acknowledgements.length],
            interactionIds: durable.rows.map((row) => row.interaction_id),
          };
        },
        (observed) =>
          observed.acknowledgements[0] === 2 &&
          observed.acknowledgements[1] === 2 &&
          observed.interactionIds.join(",") === "interaction-grant-left,interaction-grant-right",
      );
      const counts = await fixture.db.query<{
        approvals: string;
        units: string;
        runs: string;
        jobs: string;
      }>(
        `SELECT
         (SELECT count(*) FROM approvals)::text approvals,
         (SELECT count(*) FROM work_units)::text units,
         (SELECT count(*) FROM agent_runs)::text runs,
         (SELECT count(*) FROM jobs WHERE job_type='agent.implementer')::text jobs`,
      );
      expect(counts.rows[0]).toEqual({ approvals: "1", units: "1", runs: "1", jobs: "1" });
    });
  },
  available,
);
