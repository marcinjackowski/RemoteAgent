import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  TrustLevel,
  jiraConnectorConfig,
  jiraEventContract,
  jiraIssueSnapshotContract,
} from "../src/index.js";

const config = {
  schema_version: CURRENT_SCHEMA_VERSION,
  owner_id: "owner-1",
  connection_id: "connection-1",
  provider: "jira",
  project_allowlist: ["RA"],
} as const;

describe("Jira runtime contracts", () => {
  it("accepts server-authoritative owner, connection and non-empty project scope", () => {
    expect(jiraConnectorConfig.parse(config)).toEqual(config);
  });

  it("rejects credentials and provider-controlled scope", () => {
    expect(() => jiraConnectorConfig.parse({ ...config, access_token: "secret" })).toThrow();
    expect(() =>
      jiraConnectorConfig.parse({ ...config, credential_secret_ref: "vault/x" }),
    ).toThrow();
    expect(() => jiraConnectorConfig.parse({ ...config, projects: ["EVIL"] })).toThrow();
    expect(() => jiraConnectorConfig.parse({ ...config, project_allowlist: [] })).toThrow();
  });

  it("requires literal UNTRUSTED_DATA and schema version on every Jira text", () => {
    const event = {
      schema_version: CURRENT_SCHEMA_VERSION,
      event_id: "event-1",
      connection_id: "connection-1",
      owner_id: "owner-1",
      project_key: "RA",
      issue_key: "RA-1",
      event_type: "issue_updated",
      occurred_at: "2026-08-20T10:00:00Z",
      received_at: "2026-08-20T10:01:00Z",
      summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "Title" },
      ordering_key: "2026-01-01T00:00:00.000Z:abc",
    };
    expect(jiraEventContract.parse(event).summary?.trust).toBe(TrustLevel.UNTRUSTED_DATA);
    expect(() =>
      jiraEventContract.parse({ ...event, summary: { trust: TrustLevel.TRUSTED, value: "Title" } }),
    ).toThrow();
    expect(() => jiraEventContract.parse({ ...event, summary: { value: "Title" } })).toThrow();
  });

  it("rejects unknown fields and future contract versions", () => {
    const snapshot = {
      schema_version: CURRENT_SCHEMA_VERSION,
      snapshot_id: "snapshot-1",
      connection_id: "connection-1",
      owner_id: "owner-1",
      project_key: "RA",
      issue_key: "RA-1",
      issue_version: 1,
      captured_at: "2026-08-20T10:00:00Z",
      summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "Title" },
      status: { trust: TrustLevel.UNTRUSTED_DATA, value: "Open" },
      labels: [],
    };
    expect(jiraIssueSnapshotContract.parse(snapshot)).toEqual(snapshot);
    expect(() => jiraIssueSnapshotContract.parse({ ...snapshot, token: "secret" })).toThrow();
    expect(() => jiraIssueSnapshotContract.parse({ ...snapshot, schema_version: 2 })).toThrow();
  });
});
