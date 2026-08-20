import { describe, expect, it } from "vitest";
import { enrichJiraIssue, type JiraEnrichedSnapshot } from "../src/enrichment.js";
import type { JiraRestClient, JiraIssueResponse } from "../src/rest/client.js";
const issue = {
  id: "1",
  key: "PROJ-1",
  fields: { project: { key: "PROJ" }, labels: [], updated: "2026-01-01T00:00:00.000Z" },
} satisfies JiraIssueResponse;
describe("Jira enrichment", () =>
  it("does not mutate on stale response", async () => {
    let writes = 0;
    const store = {
      get: async () => ({
        connectionId: "c",
        issueKey: "PROJ-1",
        version: Date.parse("2026-01-02T00:00:00Z"),
        snapshot_id: "s",
        schema_version: 1,
        owner_id: "owner",
        connection_id: "c",
        project_key: "PROJ",
        issue_key: "PROJ-1",
        issue_version: Date.parse("2026-01-02T00:00:00Z"),
        captured_at: "2026-01-01T00:00:00Z",
        summary: { trust: "UNTRUSTED_DATA", value: "" },
        status: { trust: "UNTRUSTED_DATA", value: "" },
        labels: [],
      }),
      putIfNewer: async () => {
        writes += 1;
        return "accepted" as const;
      },
    };
    const result = await enrichJiraIssue(
      { getIssue: async () => issue } as unknown as JiraRestClient,
      store,
      "c",
      "PROJ-1",
      "owner",
    );
    expect(writes).toBe(0);
    expect(result?.issue_version).toBeGreaterThan(0);
  }));
it("handles equal and newer versions with one valid public snapshot write", async () => {
  let current: JiraEnrichedSnapshot = {
    schema_version: 1,
    snapshot_id: "old",
    owner_id: "owner",
    connection_id: "c",
    project_key: "PROJ",
    issue_key: "PROJ-1",
    issue_version: 0,
    captured_at: "2026-01-01T00:00:00Z",
    summary: { trust: "UNTRUSTED_DATA", value: "" },
    status: { trust: "UNTRUSTED_DATA", value: "" },
    labels: [],
  };
  let writes = 0;
  const store = {
    get: async () => current,
    putIfNewer: async (value: JiraEnrichedSnapshot) => {
      writes += 1;
      current = value;
      return "accepted" as const;
    },
  };
  const client = {
    getIssue: async () => ({
      ...issue,
      fields: { ...issue.fields, updated: "2026-01-02T00:00:00.000Z" },
    }),
  } as unknown as JiraRestClient;
  const first = await enrichJiraIssue(client, store, "c", "PROJ-1", "owner");
  const equal = await enrichJiraIssue(client, store, "c", "PROJ-1", "owner");
  expect(first?.issue_version).toBe(equal?.issue_version);
  expect(writes).toBe(1);
  expect(first?.summary.trust).toBe("UNTRUSTED_DATA");
});
