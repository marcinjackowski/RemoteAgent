/**
 * RA-006 inbound denial audit test against a REAL PostgreSQL (AUDIT-01 MEDIUM-04).
 *
 * Proves that an unauthorized interaction is DURABLY recorded in the append-only
 * audit log and that the recorded row is CONTENT-FREE: neither the message body
 * nor any secret-looking payload leaks into the audit row (acceptance criterion 2).
 */
import { AuditLogRepository } from "@remoteagent/database";
import { expect, it } from "vitest";

import { ChannelRegistry } from "../src/channels.js";
import { processInbound } from "../src/inbound-audit.js";
import { createTestDatabase, describeIntegration, postgresAvailable } from "./pg-harness.js";

const available = await postgresAvailable();

const OWNER = "owner-1";
const CHANNELS = {
  jira: "c-jira",
  "gmail-private": "c-gmail-priv",
  "gmail-sondermind": "c-gmail-sm",
  "calendar-private": "c-cal-priv",
  "calendar-sondermind": "c-cal-sm",
  gitlab: "c-gitlab",
  system: "c-system",
} as const;

function registry(): ChannelRegistry {
  return new ChannelRegistry({ guildId: "guild-1", ownerId: OWNER, channels: { ...CHANNELS } });
}

describeIntegration(
  "inbound denial audit (RA-006)",
  () => {
    it("records a content-free denial row for an unauthorized interaction", async () => {
      const test = await createTestDatabase();
      try {
        const audit = new AuditLogRepository();
        const secret = "SECRET-TOKEN-should-never-be-audited";

        const outcome = await processInbound(
          { registry: registry(), resolveThreadCase: async () => null, audit, db: test.db },
          {
            type: "message",
            // Wrong guild → denied before any content is read.
            guildId: "intruder-guild",
            userId: "intruder",
            origin: { surface: "channel", channelId: "c-jira" },
            content: secret,
          },
        );
        expect(outcome.kind).toBe("denied");

        const rows = await test.db.query<{ action: string; outcome: string; detail: unknown }>(
          `SELECT action, outcome, detail FROM audit_log WHERE action = 'discord.inbound.denied'`,
        );
        expect(rows.rows.length).toBe(1);
        const row = rows.rows[0]!;
        expect(row.outcome).toBe("FAILURE");
        // The whole row (ids + reason only) must NOT contain the message content.
        expect(JSON.stringify(row)).not.toContain(secret);
        // The reason is preserved for the operator.
        expect(JSON.stringify(row.detail)).toContain("wrong_guild");
      } finally {
        await test.drop();
      }
    });
  },
  available,
);
