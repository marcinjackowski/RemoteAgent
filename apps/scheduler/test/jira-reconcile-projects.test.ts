import { describe, expect, it } from "vitest";

import { jiraReconcileProjectsFromEnv } from "../src/jira-reconcile-task.js";

describe("jiraReconcileProjectsFromEnv", () => {
  it("returns no projects when JIRA_PROJECT_KEY is absent (scheduler registers no task)", () => {
    expect(jiraReconcileProjectsFromEnv({})).toEqual([]);
  });

  it("builds one project with worker-matching defaults", () => {
    expect(jiraReconcileProjectsFromEnv({ JIRA_PROJECT_KEY: "KAN" })).toEqual([
      { ownerId: "owner-local", connectionId: "connection-local-jira", projectKey: "KAN" },
    ]);
  });

  it("honours explicit owner/connection ids", () => {
    expect(
      jiraReconcileProjectsFromEnv({
        JIRA_PROJECT_KEY: "MOBL",
        JIRA_OWNER_ID: "o1",
        JIRA_CONNECTION_ID: "c1",
      }),
    ).toEqual([{ ownerId: "o1", connectionId: "c1", projectKey: "MOBL" }]);
  });

  it("rejects a malformed project key (lower-case) rather than silently querying nothing", () => {
    expect(() => jiraReconcileProjectsFromEnv({ JIRA_PROJECT_KEY: "kan" })).toThrow(
      /JIRA_PROJECT_KEY/,
    );
  });
});
