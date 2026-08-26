/**
 * RA-006 env composition contract test (AUDIT-02 MEDIUM-11).
 *
 * Validates the deployment env contract and that a runnable bot composes from it
 * WITHOUT a real token, network or database: the REST transport and gateway socket
 * are stubbed, so `session.start()` connects to the fake socket and the outbound
 * sink is wired. Also proves the env parser fails closed on a missing variable and
 * never echoes the token.
 */
import { Database } from "@remoteagent/database";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DiscordEnvError,
  createDiscordBotFromEnv,
  createOwnerOutcomeSink,
  discordConfigFromEnv,
  engineeringWritePolicyFromEnv,
  runFromEnv,
} from "../src/env.js";
import type { DiscordBot } from "../src/index.js";
import type { GatewaySocket, GatewaySocketHandlers } from "../src/gateway-session.js";
import type { RestResponse } from "../src/rest-gateway.js";

const TOKEN = "REDACTED-TEST-TOKEN";

function fullEnv(): Record<string, string> {
  return {
    DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_OWNER_ID: "owner-1",
    DISCORD_BOT_USER_ID: "bot-1",
    DISCORD_CHANNEL_JIRA: "c-jira",
    DISCORD_CHANNEL_GMAIL_PRIVATE: "c-gmail-priv",
    DISCORD_CHANNEL_GMAIL_SONDERMIND: "c-gmail-sm",
    DISCORD_CHANNEL_CALENDAR_PRIVATE: "c-cal-priv",
    DISCORD_CHANNEL_CALENDAR_SONDERMIND: "c-cal-sm",
    DISCORD_CHANNEL_GITLAB: "c-gitlab",
    DISCORD_CHANNEL_SYSTEM: "c-system",
  };
}

describe("discordConfigFromEnv (RA-006 composition)", () => {
  it("reads the canonical engineering deployment policy from the shared execution config", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "ra-discord-engineering-")));
    try {
      const path = join(directory, "engineering.json");
      const document = {
        schema_version: 2,
        workspace_root: "/worker/workspaces",
        baseline_root: "/worker/baselines",
        artifact_root: "/worker/artifacts",
        repository: {
          repository_id: "remote-agent",
          source_path: "/worker/source",
          base_branch: "main",
          write_path_allowlist: ["packages/contracts", "apps/agent-worker"],
        },
        gates: [],
        executable_allowlist: [],
      };
      await writeFile(path, JSON.stringify(document), "utf8");
      await expect(
        engineeringWritePolicyFromEnv({ RA_ENGINEERING_CONFIG_PATH: path }),
      ).resolves.toEqual({
        schema_version: 1,
        purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
        repository_id: "remote-agent",
        write_path_allowlist: ["apps/agent-worker", "packages/contracts"],
      });
      await expect(engineeringWritePolicyFromEnv({})).resolves.toBeNull();
      await writeFile(
        path,
        JSON.stringify({ ...document, caller_digest: "sha256:opaque" }),
        "utf8",
      );
      await expect(
        engineeringWritePolicyFromEnv({ RA_ENGINEERING_CONFIG_PATH: path }),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hands the exact parsed deployment policy from runFromEnv to production bot composition", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "ra-discord-policy-handoff-")));
    const db = new Database({ connectionString: "postgres://unused/localhost" });
    try {
      const path = join(directory, "engineering.json");
      await writeFile(
        path,
        JSON.stringify({
          schema_version: 2,
          workspace_root: "/worker/workspaces",
          baseline_root: "/worker/baselines",
          artifact_root: "/worker/artifacts",
          repository: {
            repository_id: "remote-agent",
            source_path: "/worker/source",
            base_branch: "main",
            write_path_allowlist: ["packages/contracts", "apps/agent-worker"],
          },
          gates: [],
          executable_allowlist: [],
        }),
        "utf8",
      );
      let started = false;
      let capturedPolicy: unknown;
      const fakeBot: DiscordBot = {
        outboxSink: () => Promise.resolve(),
        session: {
          start: () => {
            started = true;
          },
        } as DiscordBot["session"],
      };
      const result = await runFromEnv(
        { ...fullEnv(), RA_ENGINEERING_CONFIG_PATH: path },
        {
          db,
          composeBot: (_config, composedDb, options) => {
            expect(composedDb).toBe(db);
            expect(options).toBeDefined();
            capturedPolicy = options?.deploymentPolicy;
            return fakeBot;
          },
        },
      );
      expect(result).toEqual({ bot: fakeBot, db });
      expect(started).toBe(true);
      expect(capturedPolicy).toEqual({
        schema_version: 1,
        purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
        repository_id: "remote-agent",
        write_path_allowlist: ["apps/agent-worker", "packages/contracts"],
      });
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes only dedicated engineering outcomes and keeps STOP active without policy", async () => {
    const db = new Database({ connectionString: "postgres://unused/localhost" });
    const calls: Array<{ kind: string; value: unknown }> = [];
    const logs: string[] = [];
    const stopIngress = {
      stop: (_db: Database, value: unknown) => {
        calls.push({ kind: "stop", value });
        return Promise.resolve({ status: "stopped" as const, stoppedProposalIds: [] });
      },
    };
    const disabled = createOwnerOutcomeSink({
      db,
      engineeringIngress: null,
      stopIngress,
      logger: (event) => logs.push(event),
    });
    await disabled({
      kind: "engineering_proposal",
      caseId: "case-1",
      actorId: "discord-snowflake",
      interactionId: "interaction-propose-disabled",
    });
    await disabled({
      kind: "stop",
      caseId: "case-1",
      actorId: "discord-snowflake",
      interactionId: "interaction-stop",
    });
    expect(calls).toEqual([
      {
        kind: "stop",
        value: {
          caseId: "case-1",
          actorId: "discord-snowflake",
          interactionId: "interaction-stop",
        },
      },
    ]);
    expect(logs).toContain("engineering.ingress_disabled");

    const engineeringIngress = {
      propose: (_db: Database, value: unknown) => {
        calls.push({ kind: "propose", value });
        return Promise.resolve({ status: "ignored" as const, reason: "test" });
      },
      respond: (_db: Database, value: unknown) => {
        calls.push({ kind: "respond", value });
        return Promise.resolve({
          status: "denied" as const,
          proposalId: "proposal-1",
          proposalStatus: "DENIED" as const,
        });
      },
    };
    const enabled = createOwnerOutcomeSink({ db, engineeringIngress, stopIngress });
    await enabled({
      kind: "engineering_proposal",
      caseId: "case-1",
      actorId: "discord-snowflake",
      interactionId: "interaction-propose",
    });
    await enabled({
      kind: "engineering",
      caseId: "case-1",
      actorId: "discord-snowflake",
      interactionId: "interaction-grant",
      interaction: {
        kind: "engineering",
        proposalId: "proposal-1",
        checkpointRevision: 7,
        choice: "grant",
      },
    });
    await enabled({
      kind: "decision",
      caseId: "case-1",
      actorId: "discord-snowflake",
      interactionId: "generic-decision",
      interaction: {
        kind: "decision",
        decisionId: "decision-1",
        checkpointRevision: 7,
        optionId: "grant",
      },
    });
    await enabled({
      kind: "approval",
      caseId: "case-1",
      actorId: "discord-snowflake",
      interactionId: "generic-approval",
      interaction: {
        kind: "approval",
        approvalId: "approval-1",
        checkpointRevision: 7,
        choice: "grant",
      },
    });
    expect(calls.slice(1)).toEqual([
      {
        kind: "propose",
        value: {
          caseId: "case-1",
          actorId: "discord-snowflake",
          interactionId: "interaction-propose",
        },
      },
      {
        kind: "respond",
        value: {
          caseId: "case-1",
          actorId: "discord-snowflake",
          interactionId: "interaction-grant",
          proposalId: "proposal-1",
          checkpointRevision: 7,
          choice: "grant",
        },
      },
    ]);
    await db.close();
  });

  it("parses a complete environment", () => {
    const config = discordConfigFromEnv(fullEnv());
    expect(config.token).toBe(TOKEN);
    expect(config.guildId).toBe("guild-1");
    expect(config.channels.jira).toBe("c-jira");
    expect(config.gatewayUrl).toBe("wss://gateway.discord.gg");
  });

  it("fails closed with the missing variable name (never echoing the token)", () => {
    const env = fullEnv();
    delete env.DISCORD_CHANNEL_SYSTEM;
    let thrown: unknown;
    try {
      discordConfigFromEnv(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DiscordEnvError);
    expect((thrown as Error).message).toContain("DISCORD_CHANNEL_SYSTEM");
    expect((thrown as Error).message).not.toContain(TOKEN);
  });

  it("composes a runnable bot with injected transports (no network, no secret)", () => {
    const config = discordConfigFromEnv(fullEnv());
    // A Database instance is constructed but never queried in this test (no
    // gateway/outbox traffic is driven), so no PostgreSQL is required.
    const db = new Database({ connectionString: "postgres://unused/localhost" });

    const restCalls: string[] = [];
    const restTransport = (req: { method: string; path: string }): Promise<RestResponse> => {
      restCalls.push(`${req.method} ${req.path}`);
      return Promise.resolve({ status: 200, headers: {}, body: { id: "x" } });
    };
    const sockets: { closed: boolean }[] = [];
    const socketFactory = (_url: string, handlers: GatewaySocketHandlers): GatewaySocket => {
      const socket = { closed: false, sent: [] as string[] };
      sockets.push(socket);
      return {
        send: () => {},
        close: () => {
          socket.closed = true;
          handlers.onClose(1000);
        },
      };
    };
    const logs: string[] = [];

    const bot = createDiscordBotFromEnv(config, db, {
      restTransport,
      socketFactory,
      logger: (event) => logs.push(event),
    });
    expect(typeof bot.outboxSink).toBe("function");
    bot.session.start();
    expect(sockets.length).toBe(1);
    bot.session.stop();
    // The token never reached the logger.
    expect(logs.join("|")).not.toContain(TOKEN);
    void db.close();
  });
});
