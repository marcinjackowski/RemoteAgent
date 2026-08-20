import { describe, expect, it } from "vitest";
import { parseJiraPayload } from "../src/parser.js";
import { normalizeJiraPayload } from "../src/normalize.js";
import { TrustLevel } from "@remoteagent/contracts";
import adfFixture from "./fixtures/comment-adf.json";

const context = {
  rawEventId: "raw-1",
  ownerId: "owner-1",
  connectionId: "conn-1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  traceId: "trace-1",
  payloadRef: { ref: "vault-ref", digest: `sha256:${"a".repeat(64)}` },
  projectAllowlist: ["PROJ"],
};
const issue = {
  key: "PROJ-1",
  fields: { project: { key: "PROJ" }, summary: "safe", status: { name: "Open" } },
};

describe("Jira parser", () => {
  it.each([
    "jira:issue_created",
    "jira:issue_updated",
    "jira:issue_deleted",
    "comment_created",
    "comment_updated",
    "comment_deleted",
  ])("accepts %s", (webhookEvent) => {
    const result = normalizeJiraPayload(
      { webhookEvent, timestamp: 1_700_000_000_000, issue, comment: { body: "comment" } },
      context,
    );
    expect(result.jiraEvent.event_type).toBe(
      webhookEvent.startsWith("jira:") ? webhookEvent.slice(5) : webhookEvent,
    );
    expect(result.envelope.payload_ref.ref).toBe("vault-ref");
    expect(result.envelope.connection_id).toBe("conn-1");
  });

  it("bounds and retains only changelog fields for issue updates", () => {
    const result = parseJiraPayload({
      webhookEvent: "jira:issue_updated",
      timestamp: 1_700_000_000_000,
      issue,
      changelog: {
        items: [{ field: "status", fromString: "Open", toString: "Done" }],
      },
    });
    expect(result.changes).toEqual([{ field: "status", from: "Open", to: "Done" }]);
    const normalized = normalizeJiraPayload(
      {
        webhookEvent: "jira:issue_updated",
        timestamp: 1_700_000_000_000,
        issue,
        changelog: { items: [{ field: "status", fromString: "Open", toString: "Done" }] },
      },
      context,
    );
    expect(normalized.jiraEvent.changes?.[0]?.field.trust).toBe(TrustLevel.UNTRUSTED_DATA);
  });

  it("accepts official provider extensions while ignoring spoofed routing", () => {
    const result = normalizeJiraPayload(
      {
        webhookEvent: "jira:issue_updated",
        timestamp: 1_700_000_000_000,
        issue_event_type_name: "issue_updated",
        owner_id: "spoof",
        connection_id: "spoof",
        payload_ref: "spoof",
        issue: {
          ...issue,
          id: "10001",
          self: "https://example.invalid/rest/api/3/issue/10001",
          fields: { ...issue.fields, customfield_10000: "ignored" },
        },
        user: {
          accountId: "acct",
          displayName: "User",
          emailAddress: "hidden@example.invalid",
          active: true,
        },
        transition: { id: "4" },
      },
      context,
    );
    expect(result.envelope.connection_id).toBe(context.connectionId);
    expect(result.envelope.payload_ref.ref).toBe(context.payloadRef.ref);
  });

  it("accepts ADF comment bodies and defers extraction", () => {
    expect(normalizeJiraPayload(adfFixture, context).jiraEvent.comment).toBeUndefined();
  });

  it("rejects changelog on non-update events", () => {
    expect(() =>
      parseJiraPayload({ ...adfFixture, changelog: { items: [{ field: "status" }] } }),
    ).toThrow();
  });

  it("rejects unknown events", () =>
    expect(() => parseJiraPayload({ webhookEvent: "jira:worklog_created", issue })).toThrow());
});
