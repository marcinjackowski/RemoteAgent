import { JiraRestError, type JiraRestClient } from "./rest/client.js";
import { jiraIssueSnapshotContract, type JiraIssueSnapshot } from "./contracts.js";
import { createHash } from "node:crypto";
import type { Queryable } from "@remoteagent/database";
export type JiraEnrichedSnapshot = JiraIssueSnapshot;
export type JiraSnapshotIdentity = Pick<
  JiraIssueSnapshot,
  "owner_id" | "connection_id" | "project_key" | "issue_key"
>;
export interface JiraSnapshotStore {
  get(identity: JiraSnapshotIdentity): Promise<JiraEnrichedSnapshot | undefined>;
  putIfNewer(snapshot: JiraEnrichedSnapshot): Promise<"accepted" | "stale">;
}
export interface JiraSnapshotRepositoryAdapter {
  putSnapshotIfNewer(
    tx: Queryable,
    input: {
      ownerId: string;
      connectionId: string;
      projectKey: string;
      issueKey: string;
      issueVersionMs: number;
      snapshot: unknown;
    },
  ): Promise<{ disposition: "accepted" | "stale"; snapshot: unknown }>;
}
export function adaptJiraSnapshotRepository(
  repository: JiraSnapshotRepositoryAdapter,
  query: Queryable,
): JiraSnapshotStore {
  return {
    async get(identity) {
      const result = await query.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM jira_issue_snapshots WHERE owner_id=$1 AND connection_id=$2 AND project_key=$3 AND issue_key=$4",
        [identity.owner_id, identity.connection_id, identity.project_key, identity.issue_key],
      );
      return result.rows[0] === undefined
        ? undefined
        : jiraIssueSnapshotContract.parse(result.rows[0].snapshot);
    },
    async putIfNewer(snapshot) {
      const valid = jiraIssueSnapshotContract.parse(snapshot);
      const result = await repository.putSnapshotIfNewer(query, {
        ownerId: valid.owner_id,
        connectionId: valid.connection_id,
        projectKey: valid.project_key,
        issueKey: valid.issue_key,
        issueVersionMs: valid.issue_version,
        snapshot: valid,
      });
      return result.disposition;
    },
  };
}
export function buildJiraIssueSnapshot(
  issue: Awaited<ReturnType<JiraRestClient["getIssue"]>>,
  connectionId: string,
  ownerId: string,
  capturedAt: string,
): JiraEnrichedSnapshot {
  const version = Date.parse(issue.fields.updated);
  if (!Number.isFinite(version))
    throw new JiraRestError("invalid_response", "jira updated timestamp invalid");
  return jiraIssueSnapshotContract.parse({
    schema_version: 1,
    snapshot_id: `jira_snapshot_${createHash("sha256").update(`${connectionId}:${issue.key}:${version}`).digest("hex")}`,
    owner_id: ownerId,
    connection_id: connectionId,
    project_key: issue.fields.project.key,
    issue_key: issue.key,
    issue_version: version,
    captured_at: capturedAt,
    summary: issue.fields.summary ?? { trust: "UNTRUSTED_DATA", value: "" },
    description: issue.fields.description,
    status: issue.fields.status ?? { trust: "UNTRUSTED_DATA", value: "" },
    labels: issue.fields.labels.map((label) => ({ trust: "UNTRUSTED_DATA", value: label })),
  });
}
export async function enrichJiraIssue(
  client: JiraRestClient,
  store: JiraSnapshotStore,
  connectionId: string,
  issueKey: string,
  ownerId: string,
  capturedAt = new Date().toISOString(),
): Promise<JiraEnrichedSnapshot | undefined> {
  const issue = await client.getIssue(issueKey);
  const snapshot = buildJiraIssueSnapshot(issue, connectionId, ownerId, capturedAt);
  const identity = {
    owner_id: snapshot.owner_id,
    connection_id: snapshot.connection_id,
    project_key: snapshot.project_key,
    issue_key: snapshot.issue_key,
  };
  const current = await store.get(identity);
  if (current !== undefined && snapshot.issue_version <= current.issue_version) return current;
  const disposition = await store.putIfNewer(snapshot);
  return disposition === "accepted" ? snapshot : ((await store.get(identity)) ?? snapshot);
}
