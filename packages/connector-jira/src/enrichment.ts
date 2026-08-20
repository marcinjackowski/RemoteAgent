import { JiraRestError, type JiraRestClient } from "./rest/client.js";
import { jiraIssueSnapshotContract, type JiraIssueSnapshot } from "./contracts.js";
import { createHash } from "node:crypto";
export type JiraEnrichedSnapshot = JiraIssueSnapshot;
export interface JiraSnapshotStore {
  get(connectionId: string, issueKey: string): Promise<JiraEnrichedSnapshot | undefined>;
  put(snapshot: JiraEnrichedSnapshot): Promise<void>;
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
  const version = Date.parse(issue.fields.updated);
  if (!Number.isFinite(version))
    throw new JiraRestError("invalid_response", "jira updated timestamp invalid");
  const current = await store.get(connectionId, issueKey);
  const snapshot = jiraIssueSnapshotContract.parse({
    schema_version: 1,
    snapshot_id: `jira_snapshot_${createHash("sha256").update(`${connectionId}:${issueKey}:${version}`).digest("hex")}`,
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
  if (current !== undefined && version <= current.issue_version) return current;
  await store.put(snapshot);
  return snapshot;
}
