import { describe, expect, it } from "vitest";

import {
  ConnectionAlias,
  ConnectionHealth,
  ConnectionScopeKind,
  connectionContract,
} from "../src/connection.js";

const validConnection = {
  schema_version: 1,
  connection_id: "gmail-private",
  owner_id: "owner-1",
  provider: "gmail",
  alias: ConnectionAlias.PRIVATE,
  display_name: "Private Gmail",
  capabilities: ["mail.read", "mail.draft"],
  oauth: {
    expires_at: "2026-08-20T12:00:00Z",
    refresh_after: "2026-08-20T11:00:00Z",
    revoked_at: null,
    last_health_check_at: "2026-08-19T12:00:00Z",
    health: ConnectionHealth.HEALTHY,
    credential_revision: 3,
  },
  scopes: [{ kind: ConnectionScopeKind.ACCOUNT, value: "me@example.test" }],
  created_at: "2026-08-19T10:00:00Z",
  updated_at: "2026-08-19T12:00:00Z",
} as const;

describe("Connection contract", () => {
  it("contains safe metadata but no token, secret value or vault reference", () => {
    const parsed = connectionContract.parse(validConnection);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/access_token|refresh_token|secret_ref|secret_value/i);
  });

  it("rejects credential fields at the public boundary", () => {
    expect(
      connectionContract.safeParse({ ...validConnection, access_token: "forbidden" }).success,
    ).toBe(false);
    expect(
      connectionContract.safeParse({ ...validConnection, secret_ref: "vault/path" }).success,
    ).toBe(false);
  });

  it("requires revoked lifecycle state to carry revoked_at", () => {
    expect(
      connectionContract.safeParse({
        ...validConnection,
        oauth: { ...validConnection.oauth, health: ConnectionHealth.REVOKED },
      }).success,
    ).toBe(false);
  });

  it("keeps private and SonderMind aliases as distinct values", () => {
    const privateConnection = connectionContract.parse(validConnection);
    const workConnection = connectionContract.parse({
      ...validConnection,
      connection_id: "gmail-work",
      alias: ConnectionAlias.SONDERMIND,
    });
    expect(privateConnection.connection_id).not.toBe(workConnection.connection_id);
    expect(privateConnection.alias).not.toBe(workConnection.alias);
  });
});
