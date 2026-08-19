/**
 * Safe connection metadata exposed across application boundaries (RA-005).
 *
 * Credentials deliberately do not appear in this contract. A connection only
 * exposes stable identity, capabilities, health and an authoritative resource
 * allowlist. The persistence layer keeps an opaque vault reference separately.
 */
import * as z from "zod";

import { idString, isoTimestamp, label, valueObject, versionedContract } from "./common.js";
import { providerSchema } from "./external-entity.js";

export const ConnectionAlias = {
  PRIVATE: "private",
  SONDERMIND: "sondermind",
} as const;

export type ConnectionAlias = (typeof ConnectionAlias)[keyof typeof ConnectionAlias];

export const connectionAliasSchema = z.enum([ConnectionAlias.PRIVATE, ConnectionAlias.SONDERMIND]);

export const ConnectionHealth = {
  HEALTHY: "HEALTHY",
  EXPIRING: "EXPIRING",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  ERROR: "ERROR",
} as const;

export type ConnectionHealth = (typeof ConnectionHealth)[keyof typeof ConnectionHealth];

export const connectionHealthSchema = z.enum([
  ConnectionHealth.HEALTHY,
  ConnectionHealth.EXPIRING,
  ConnectionHealth.EXPIRED,
  ConnectionHealth.REVOKED,
  ConnectionHealth.ERROR,
]);

export const ConnectionScopeKind = {
  ACCOUNT: "account",
  REPOSITORY: "repository",
  CALENDAR: "calendar",
  PROJECT: "project",
  DISCORD_OWNER: "discord_owner",
  DISCORD_GUILD: "discord_guild",
  DISCORD_CHANNEL: "discord_channel",
} as const;

export type ConnectionScopeKind = (typeof ConnectionScopeKind)[keyof typeof ConnectionScopeKind];

export const connectionScopeKindSchema = z.enum([
  ConnectionScopeKind.ACCOUNT,
  ConnectionScopeKind.REPOSITORY,
  ConnectionScopeKind.CALENDAR,
  ConnectionScopeKind.PROJECT,
  ConnectionScopeKind.DISCORD_OWNER,
  ConnectionScopeKind.DISCORD_GUILD,
  ConnectionScopeKind.DISCORD_CHANNEL,
]);

/** A provider resource selected by trusted configuration, never by the model. */
export const connectionScopeEntry = valueObject({
  kind: connectionScopeKindSchema,
  value: idString,
});

export type ConnectionScopeEntry = z.infer<typeof connectionScopeEntry>;

/** OAuth lifecycle metadata. No access token, refresh token or secret value. */
export const oauthLifecycle = valueObject({
  expires_at: isoTimestamp.nullable(),
  refresh_after: isoTimestamp.nullable(),
  revoked_at: isoTimestamp.nullable(),
  last_health_check_at: isoTimestamp.nullable(),
  health: connectionHealthSchema,
  credential_revision: z.int().nonnegative(),
}).superRefine((value, ctx) => {
  if (value.health === ConnectionHealth.REVOKED && value.revoked_at === null) {
    ctx.addIssue({
      code: "custom",
      path: ["revoked_at"],
      message: "revoked_at is required when health=REVOKED",
    });
  }
  if (value.health !== ConnectionHealth.REVOKED && value.revoked_at !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["revoked_at"],
      message: "revoked_at is only allowed when health=REVOKED",
    });
  }
});

export type OAuthLifecycle = z.infer<typeof oauthLifecycle>;

const capability = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]*$/);

export const connectionContract = versionedContract({
  connection_id: idString,
  owner_id: idString,
  provider: providerSchema,
  alias: connectionAliasSchema,
  display_name: label,
  capabilities: z.array(capability).max(64),
  oauth: oauthLifecycle,
  scopes: z.array(connectionScopeEntry).max(512),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export type Connection = z.infer<typeof connectionContract>;
