import { describe, expect, it } from "vitest";
import { projectJiraIssue } from "../src/projection.js";
describe("Jira projection", () => {
  it("emits sanitized bounded root/thread contracts", () => {
    const result = projectJiraIssue({
      caseId: "case-1",
      ownerId: "owner-1",
      seq: 1,
      provider: "jira",
      alias: "private",
      issueKey: "PROJ-1",
      status: "Open",
      summary: "@everyone safe",
    });
    expect(result.root.body).toContain("UNTRUSTED Jira");
    expect(result.root.body).not.toContain("description");
    expect(result.root.body).not.toContain("comment");
    expect(result.root.body).toContain("@\u200beveryone");
  });
  it("handles sparse and oversize text without leaking fields", () => {
    const result = projectJiraIssue({
      caseId: "case-1",
      ownerId: "owner-1",
      seq: 2,
      provider: "jira",
      alias: "sondermind",
      issueKey: "PROJ-1",
      summary: "x".repeat(60_000),
    });
    expect(result.thread.body.length).toBeLessThanOrEqual(2000);
  });
  it("rejects extra, empty, and oversized identity fields", () => {
    const valid = {
      caseId: "case-1",
      ownerId: "owner-1",
      seq: 1,
      provider: "jira",
      alias: "private",
      issueKey: "PROJ-1",
    };
    expect(() => projectJiraIssue({ ...valid, description: "secret" })).toThrow();
    expect(() => projectJiraIssue({ ...valid, issueKey: "" })).toThrow();
    expect(() => projectJiraIssue({ ...valid, issueKey: "x".repeat(129) })).toThrow();
  });
  it("keeps output bounded and free of secret markers", () => {
    const result = projectJiraIssue({
      caseId: "case-1",
      ownerId: "owner-1",
      seq: 1,
      provider: "jira",
      alias: "private",
      issueKey: "PROJ-1",
      summary: "@everyone",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.root.title.length).toBeLessThanOrEqual(100);
    expect(result.root.body.length).toBeLessThanOrEqual(2000);
  });
});
