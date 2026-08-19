/**
 * `ExternalEntityRef` — a stable reference to an object living in an external
 * provider (Jira issue, GitLab MR, Gmail thread, Calendar event, …).
 *
 * A Case may link many of these. The reference itself is authoritative routing
 * metadata assigned by the system; the provider is a closed enum so a typo can
 * never widen scope.
 */
import * as z from "zod";

import { idString, schemaVersion } from "./common.js";

export const Provider = {
  JIRA: "jira",
  GMAIL: "gmail",
  CALENDAR: "calendar",
  GITLAB: "gitlab",
  DISCORD: "discord",
} as const;

export type Provider = (typeof Provider)[keyof typeof Provider];

export const providerSchema = z.enum([
  Provider.JIRA,
  Provider.GMAIL,
  Provider.CALENDAR,
  Provider.GITLAB,
  Provider.DISCORD,
]);

export const ExternalEntityKind = {
  JIRA_ISSUE: "jira_issue",
  GMAIL_THREAD: "gmail_thread",
  GMAIL_MESSAGE: "gmail_message",
  CALENDAR_EVENT: "calendar_event",
  GITLAB_PROJECT: "gitlab_project",
  GITLAB_BRANCH: "gitlab_branch",
  GITLAB_MERGE_REQUEST: "gitlab_merge_request",
  GITLAB_PIPELINE: "gitlab_pipeline",
  DISCORD_THREAD: "discord_thread",
} as const;

export type ExternalEntityKind = (typeof ExternalEntityKind)[keyof typeof ExternalEntityKind];

export const externalEntityKindSchema = z.enum([
  ExternalEntityKind.JIRA_ISSUE,
  ExternalEntityKind.GMAIL_THREAD,
  ExternalEntityKind.GMAIL_MESSAGE,
  ExternalEntityKind.CALENDAR_EVENT,
  ExternalEntityKind.GITLAB_PROJECT,
  ExternalEntityKind.GITLAB_BRANCH,
  ExternalEntityKind.GITLAB_MERGE_REQUEST,
  ExternalEntityKind.GITLAB_PIPELINE,
  ExternalEntityKind.DISCORD_THREAD,
]);

/**
 * Single source of truth for the closed provider→kind matrix. Each provider maps
 * to the Zod schema for exactly the kind(s) it may address. The discriminated
 * union below is built from this map, so the allowed pairs are declared once and
 * a cross-provider kind (e.g. `provider=jira` with `kind=gmail_thread`) is
 * impossible to represent — in the runtime schema *and* in the projected JSON
 * Schema (`z.discriminatedUnion` projects to `anyOf`/`oneOf`, so the pairing is
 * expressed there too, not only via a runtime refine).
 */
const providerKindSchema = {
  [Provider.JIRA]: z.literal(ExternalEntityKind.JIRA_ISSUE),
  [Provider.GMAIL]: z.enum([ExternalEntityKind.GMAIL_THREAD, ExternalEntityKind.GMAIL_MESSAGE]),
  [Provider.CALENDAR]: z.literal(ExternalEntityKind.CALENDAR_EVENT),
  [Provider.GITLAB]: z.enum([
    ExternalEntityKind.GITLAB_PROJECT,
    ExternalEntityKind.GITLAB_BRANCH,
    ExternalEntityKind.GITLAB_MERGE_REQUEST,
    ExternalEntityKind.GITLAB_PIPELINE,
  ]),
  [Provider.DISCORD]: z.literal(ExternalEntityKind.DISCORD_THREAD),
} as const;

/** Fields shared by every entity-ref variant (raw addressing metadata). */
const commonEntityShape = {
  /** Authoritative connection this entity belongs to (assigned server-side). */
  connection_id: idString,
  /** Provider-native identifier (issue key, MR iid, thread id, …). */
  external_id: idString,
  /** Optional canonical URL for humans; not used for routing. */
  url: z.url().optional(),
} as const;

/**
 * Build the provider-discriminated union of entity refs. `extra` is spread into
 * every variant (empty for the nested value object; `{ schema_version }` for the
 * standalone boundary contract), so both forms share exactly one variant list
 * and the same provider→kind matrix.
 */
function buildEntityRefUnion<E extends z.ZodRawShape>(extra: E) {
  return z.discriminatedUnion("provider", [
    z.strictObject({
      ...extra,
      provider: z.literal(Provider.JIRA),
      kind: providerKindSchema[Provider.JIRA],
      ...commonEntityShape,
    }),
    z.strictObject({
      ...extra,
      provider: z.literal(Provider.GMAIL),
      kind: providerKindSchema[Provider.GMAIL],
      ...commonEntityShape,
    }),
    z.strictObject({
      ...extra,
      provider: z.literal(Provider.CALENDAR),
      kind: providerKindSchema[Provider.CALENDAR],
      ...commonEntityShape,
    }),
    z.strictObject({
      ...extra,
      provider: z.literal(Provider.GITLAB),
      kind: providerKindSchema[Provider.GITLAB],
      ...commonEntityShape,
    }),
    z.strictObject({
      ...extra,
      provider: z.literal(Provider.DISCORD),
      kind: providerKindSchema[Provider.DISCORD],
      ...commonEntityShape,
    }),
  ]);
}

/** Nested value object: the raw addressing of one external entity. */
export const externalEntityRefValue = buildEntityRefUnion({});

export type ExternalEntityRefValue = z.infer<typeof externalEntityRefValue>;

/** Boundary contract form (carries schema_version). */
export const externalEntityRef = buildEntityRefUnion({ schema_version: schemaVersion });

export type ExternalEntityRef = z.infer<typeof externalEntityRef>;
