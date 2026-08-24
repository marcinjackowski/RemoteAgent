/**
 * Render a Jira issue into a case-transcript context turn (RA-033).
 *
 * WHY THIS EXISTS. The reconciler already HAS the issue's summary/status/description
 * (`connector-jira` parses them), but it only ever projected them to Discord — the model that
 * answers in the thread never saw them. RA-032 feeds `case_messages` to the model; RA-033 records
 * the issue itself there so the SUPERVISOR knows what the task IS, not just what the owner typed.
 *
 * TRUST. Every field is `UNTRUSTED_DATA` Jira content (`AGENTS.md` §5). This function only formats
 * text; the trust MARKING is the `trust: "UNTRUSTED_DATA"` on the `case_messages` row the caller
 * writes, and `createRole` additionally wraps the whole transcript as an untrusted turn. The
 * leading "(UNTRUSTED external data)" label is belt-and-braces for a human reading the row.
 *
 * BOUNDS. Each field is clipped so the rendered body stays well under the `case_messages` 65_536
 * limit regardless of a large description (Jira allows up to 65_536 per field). The clip is by
 * bytes-agnostic `slice` on code units — coarse on purpose: this is a context excerpt, not a
 * faithful copy, and the model does not need the tail of a 60k description to answer a question.
 */

/** Per-field character clips. Sum (plus labels) is ~10.3k << 65_536. */
export const JIRA_CONTEXT_LIMITS = Object.freeze({
  status: 256,
  summary: 2_000,
  description: 8_000,
});

export interface JiraIssueContextInput {
  readonly issueKey: string;
  readonly status?: string | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
}

function clip(value: string | undefined, limit: number): string {
  return value === undefined ? "" : value.slice(0, limit);
}

export function renderJiraIssueContext(input: JiraIssueContextInput): string {
  const status = clip(input.status, JIRA_CONTEXT_LIMITS.status);
  const summary = clip(input.summary, JIRA_CONTEXT_LIMITS.summary);
  const description = clip(input.description, JIRA_CONTEXT_LIMITS.description);
  return [
    `Jira issue ${input.issueKey} (UNTRUSTED external data)`,
    `Status: ${status || "(unknown)"}`,
    `Summary: ${summary || "(empty)"}`,
    `Description: ${description || "(empty)"}`,
  ].join("\n");
}
