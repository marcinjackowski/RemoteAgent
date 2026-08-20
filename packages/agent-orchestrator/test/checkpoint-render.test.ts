import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_RENDER_MAX_LENGTH,
  CheckpointRenderError,
  renderCheckpointMarkdown,
} from "../src/checkpoint/render.js";

function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    case_id: "case-1",
    revision: 7,
    goal: "Ship widget",
    current_phase: "VERIFYING",
    summary: { trust: "UNTRUSTED_DATA", value: "Adapter ready" },
    plan_revision: 2,
    completed_work: ["Implemented adapter"],
    decisions: ["decision-1"],
    assumptions: ["API is stable"],
    evidence: [{ kind: "test", reference: "run-1", summary: "All green" }],
    open_questions: ["Which timezone?"],
    next_actions: ["Open review"],
    blockers: ["None"],
    pending_approvals: ["approval-1"],
    workspace_state: {
      tree_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      base_sha: "base-1",
    },
    branch_state: { branch_name: null, ahead: 2, behind: 1 },
    test_runs: [
      { command: "pnpm test", exit_code: 0, summary: "Passed", ran_at: "2026-01-01T00:00:00Z" },
    ],
    snapshot_changes: ["Updated snapshot"],
    review_findings: ["No findings"],
    merge_request_state: { mr_ref: "!12", status: "OPEN" },
    external_state_versions: [{ entity_ref: "JIRA-1", version: "3" }],
    last_event_id: "event-1",
    last_run_id: "run-1",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("renderCheckpointMarkdown", () => {
  it("renders all material sections deterministically", () => {
    const output = renderCheckpointMarkdown(checkpoint());
    for (const heading of [
      "Completed work",
      "Decisions",
      "Assumptions",
      "Evidence",
      "Open questions",
      "Next actions",
      "Blockers",
      "Pending approvals",
      "Workspace",
      "Branch",
      "Tests",
      "Snapshot changes",
      "Review findings",
      "Merge request",
      "External state versions",
    ])
      expect(output).toContain(`## ${heading}`);
    expect(output.indexOf("## Completed work")).toBeLessThan(output.indexOf("## Decisions"));
    expect(output).toContain("- **Ahead:** 2");
    expect(output).toContain("- **Behind:** 1");
  });

  it("matches the full golden Markdown projection", () => {
    expect(renderCheckpointMarkdown(checkpoint())).toBe(`# Case checkpoint: case-1

- **Revision:** 7
- **Schema version:** 1
- **Goal:** Ship widget
- **Phase:** VERIFYING
- **Summary trust:** UNTRUSTED\\_DATA
- **Summary:** Adapter ready
- **Plan revision:** 2

## Completed work
- Implemented adapter

## Decisions
- decision-1

## Assumptions
- API is stable

## Evidence
- **test:** run-1 — All green

## Open questions
- Which timezone?

## Next actions
- Open review

## Blockers
- None

## Pending approvals
- approval-1

## Workspace
- **Tree digest:** sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- **Base SHA:** base-1

## Branch
- **Name:** none
- **Ahead:** 2
- **Behind:** 1

## Tests
- **pnpm test** — exit 0; Passed (2026-01-01T00:00:00Z)

## Snapshot changes
- Updated snapshot

## Review findings
- No findings

## Merge request
- **Reference:** \\!12
- **Status:** OPEN

## External state versions
- JIRA-1: 3

- **Last event:** event-1
- **Last run:** run-1
- **Updated at:** 2026-01-01T00:00:00Z`);
  });

  it("is key-order independent, non-mutating, and fail-closed", () => {
    const input = checkpoint();
    const before = structuredClone(input);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(renderCheckpointMarkdown(input)).toBe(renderCheckpointMarkdown(reordered));
    expect(input).toEqual(before);
    expect(() => renderCheckpointMarkdown({ ...input, schema_version: 2 })).toThrow(
      CheckpointRenderError,
    );
    expect(() => renderCheckpointMarkdown({ ...input, extra: true })).toThrow(
      CheckpointRenderError,
    );
    try {
      renderCheckpointMarkdown({ canary: "secret" });
      throw new Error("expected invalid checkpoint");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });

  it("redacts secrets and neutralizes CRLF, Markdown, HTML, and mentions", () => {
    const output = renderCheckpointMarkdown(
      checkpoint({
        goal: "Bearer abc api_key=secret password=hunter2 https://user:pass@example.com",
        summary: {
          trust: "UNTRUSTED_DATA",
          value:
            "x\r\n# heading <script>alert(1)</script> [link](https://x) ![img](x) `code` @everyone <@123>",
        },
      }),
    );
    expect(output).toContain("\\[REDACTED\\]");
    expect(output).not.toMatch(/\r|\n# heading|<script>|@everyone|<@123>/);
    expect(output).toContain("⏎");
  });

  it("omits empty sections and truncates valid oversized output", () => {
    const minimal = renderCheckpointMarkdown(
      checkpoint({
        completed_work: [],
        decisions: [],
        assumptions: [],
        evidence: [],
        open_questions: [],
        next_actions: [],
        blockers: [],
        pending_approvals: [],
        test_runs: [],
        snapshot_changes: [],
        review_findings: [],
        external_state_versions: [],
        workspace_state: { tree_digest: null, base_sha: null },
        merge_request_state: { mr_ref: null, status: null },
      }),
    );
    expect(minimal).not.toContain("## Evidence");
    const huge = renderCheckpointMarkdown(
      checkpoint({ completed_work: Array.from({ length: 1024 }, () => "x".repeat(65_536)) }),
    );
    expect(huge.length).toBeLessThanOrEqual(CHECKPOINT_RENDER_MAX_LENGTH);
    expect(huge.endsWith("… (truncated)")).toBe(true);
  });
});
