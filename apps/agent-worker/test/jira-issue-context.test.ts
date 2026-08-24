/**
 * RA-033: `renderJiraIssueContext` formats a Jira issue into a case-transcript context turn.
 * Pure function; the trust MARKING is on the `case_messages` row (see the integration test), so
 * this only exercises formatting, bounds, and empty-field handling.
 */
import { describe, expect, it } from "vitest";

import { JIRA_CONTEXT_LIMITS, renderJiraIssueContext } from "../src/jira-issue-context.js";

describe("renderJiraIssueContext", () => {
  it("labels the fields and marks the block as untrusted", () => {
    const body = renderJiraIssueContext({
      issueKey: "KAN-74",
      status: "In Progress",
      summary: "Login button broken on mobile",
      description: "Steps: open app, tap login, nothing happens.",
    });
    expect(body).toBe(
      [
        "Jira issue KAN-74 (UNTRUSTED external data)",
        "Status: In Progress",
        "Summary: Login button broken on mobile",
        "Description: Steps: open app, tap login, nothing happens.",
      ].join("\n"),
    );
  });

  it("renders explicit placeholders for absent fields rather than blanks", () => {
    const body = renderJiraIssueContext({ issueKey: "KAN-1" });
    expect(body).toContain("Status: (unknown)");
    expect(body).toContain("Summary: (empty)");
    expect(body).toContain("Description: (empty)");
  });

  it("clips each field to its limit so a huge description cannot blow the row bound", () => {
    const huge = "d".repeat(JIRA_CONTEXT_LIMITS.description + 5_000);
    const body = renderJiraIssueContext({
      issueKey: "KAN-2",
      summary: "s".repeat(JIRA_CONTEXT_LIMITS.summary + 500),
      status: "x".repeat(JIRA_CONTEXT_LIMITS.status + 100),
      description: huge,
    });
    expect(body).toContain(
      `Description: ${"d".repeat(JIRA_CONTEXT_LIMITS.description)}\n`.trimEnd(),
    );
    // The whole body stays far below the case_messages 65_536 limit.
    expect(body.length).toBeLessThan(20_000);
    expect(body).not.toContain("d".repeat(JIRA_CONTEXT_LIMITS.description + 1));
  });
});
