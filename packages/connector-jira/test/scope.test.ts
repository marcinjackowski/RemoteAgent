import { describe, expect, it } from "vitest";
import { normalizeJiraPayload } from "../src/normalize.js";

const context = {
  rawEventId: "raw-1",
  ownerId: "owner-1",
  connectionId: "conn-1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  traceId: "trace-1",
  payloadRef: { ref: "vault-ref", digest: `sha256:${"a".repeat(64)}` },
  projectAllowlist: ["PROJ"],
};
const payload = {
  webhookEvent: "jira:issue_updated",
  timestamp: 1_700_000_000_000,
  issue: { key: "OTHER-1", fields: { project: { key: "OTHER" } } },
};

describe("Jira scope", () => {
  it("rejects foreign project before normalization", () =>
    expect(() => normalizeJiraPayload(payload, context)).toThrow());
  it("ignores spoofed routing metadata", () => {
    const result = normalizeJiraPayload(
      {
        ...payload,
        issue: {
          ...payload.issue,
          fields: { project: { key: "PROJ" } },
        },
      },
      context,
    );
    expect(result.envelope.connection_id).toBe("conn-1");
    expect(result.envelope.payload_ref.ref).toBe("vault-ref");
  });
  it("orders deterministically by provider timestamp then trusted raw id", () => {
    const scoped = {
      ...payload,
      issue: { ...payload.issue, fields: { project: { key: "PROJ" } } },
    };
    const a = normalizeJiraPayload(
      { ...scoped, timestamp: 1_700_000_000_000 },
      context,
    ).orderingKey;
    const b = normalizeJiraPayload(
      { ...scoped, timestamp: 1_700_000_000_001 },
      { ...context, rawEventId: "raw-2" },
    ).orderingKey;
    expect(a < b).toBe(true);
  });
});
