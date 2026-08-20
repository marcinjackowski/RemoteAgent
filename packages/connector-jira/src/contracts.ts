import * as z from "zod";

import {
  CURRENT_SCHEMA_VERSION,
  Provider,
  TrustLevel,
  eventEnvelope,
  externalEntityRef,
  idString,
  isoTimestamp,
  schemaVersion,
  untrustedText,
  versionedContract,
} from "@remoteagent/contracts";

const jiraText = untrustedText;

/** Configuration is server-owned metadata; credentials are kept in a vault. */
export const jiraConnectorConfig = versionedContract({
  owner_id: idString,
  connection_id: idString,
  provider: z.literal(Provider.JIRA),
  project_allowlist: z.array(idString).min(1).max(256),
});

export type JiraConnectorConfig = z.infer<typeof jiraConnectorConfig>;
export const jiraConfigContract = jiraConnectorConfig;

const jiraEventKind = z.enum([
  "issue_created",
  "issue_updated",
  "issue_deleted",
  "comment_created",
  "comment_updated",
  "comment_deleted",
]);

/** Normalized Jira event. Provider text is always explicitly untrusted. */
export const jiraEventContract = versionedContract({
  event_id: idString,
  connection_id: idString,
  owner_id: idString,
  project_key: idString,
  issue_key: idString,
  event_type: jiraEventKind,
  occurred_at: isoTimestamp,
  received_at: isoTimestamp,
  summary: jiraText.optional(),
  description: jiraText.optional(),
  comment: jiraText.optional(),
  status: jiraText.optional(),
  ordering_key: idString.max(256),
  changes: z
    .array(z.strictObject({ field: jiraText, from: jiraText.optional(), to: jiraText.optional() }))
    .max(128)
    .optional(),
}).superRefine((value, ctx) => {
  if (value.event_type !== "issue_updated" && value.changes !== undefined)
    ctx.addIssue({
      code: "custom",
      path: ["changes"],
      message: "changes are only valid for issue_updated",
    });
});

export type JiraEvent = z.infer<typeof jiraEventContract>;
export const jiraEventSchema = jiraEventContract;

/** Authoritative, versioned issue view used by enrichment and correlation. */
export const jiraIssueSnapshotContract = versionedContract({
  snapshot_id: idString,
  connection_id: idString,
  owner_id: idString,
  project_key: idString,
  issue_key: idString,
  issue_version: z.int().nonnegative(),
  captured_at: isoTimestamp,
  summary: jiraText,
  description: jiraText.optional(),
  status: jiraText,
  labels: z.array(jiraText).max(128),
});

export type JiraIssueSnapshot = z.infer<typeof jiraIssueSnapshotContract>;
export const jiraSnapshotContract = jiraIssueSnapshotContract;
export const jiraSnapshotSchema = jiraIssueSnapshotContract;

export { CURRENT_SCHEMA_VERSION, eventEnvelope, externalEntityRef, schemaVersion, TrustLevel };
