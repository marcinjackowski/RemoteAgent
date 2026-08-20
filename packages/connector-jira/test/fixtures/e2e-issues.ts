/**
 * Deterministic Jira REST issue fixtures for the end-to-end connector proof.
 *
 * Every value here is an obvious test value: no real hosts, tenants, tokens,
 * account ids or personal data. Jira-authored text is UNTRUSTED_DATA and is
 * therefore always wrapped in the trust marker, exactly as the real REST client
 * marks it. The summary deliberately carries mass-mention syntax so the
 * end-to-end assertions can prove untrusted content is neutralized before it
 * reaches a Discord payload.
 */
import type { JiraIssueResponse } from "../../src/rest/client.js";

export const E2E_PROJECT_KEY = "PROJ";
export const E2E_OTHER_PROJECT_KEY = "OTHER";

/** Fixed "issue was last updated" instants; no wall clock in fixtures. */
export const E2E_ISSUE_UPDATED = "2026-06-01T00:00:00.000Z";
export const E2E_ISSUE_UPDATED_NEWER = "2027-06-01T00:00:00.000Z";

/** UNTRUSTED_DATA test text; the `@everyone` is the injection canary. */
export const E2E_REST_SUMMARY = "rest summary @everyone <@1234567890> (untrusted test text)";
export const E2E_REST_STATUS = "In Progress";
export const E2E_REST_LABEL = "test-label";

export interface E2EIssueOptions {
  key?: string;
  projectKey?: string;
  summary?: string;
  status?: string;
  labels?: readonly string[];
  updated?: string;
  id?: string;
}

const untrusted = (value: string) => ({ trust: "UNTRUSTED_DATA" as const, value });

/** A single REST issue response as the real client would hand it to enrichment. */
export function e2eIssue(options: E2EIssueOptions = {}): JiraIssueResponse {
  const key = options.key ?? `${E2E_PROJECT_KEY}-1`;
  return {
    id: options.id ?? `10000-${key}`,
    key,
    fields: {
      project: { key: options.projectKey ?? E2E_PROJECT_KEY },
      summary: untrusted(options.summary ?? E2E_REST_SUMMARY),
      status: untrusted(options.status ?? E2E_REST_STATUS),
      labels: [...(options.labels ?? [E2E_REST_LABEL])],
      updated: options.updated ?? E2E_ISSUE_UPDATED,
    },
  };
}
