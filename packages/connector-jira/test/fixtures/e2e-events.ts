/**
 * Deterministic Jira webhook payload fixtures for the end-to-end connector proof.
 *
 * These are the bytes a Jira dynamic webhook would POST. All values are obvious
 * test values: no real cloud id, site host, bearer token, secret or personal
 * data. Webhook text is UNTRUSTED_DATA — the fixtures never claim otherwise, and
 * the sparse variants exist to prove enrichment fills the gaps from REST instead
 * of trusting a thin webhook body.
 */
import { E2E_PROJECT_KEY } from "./e2e-issues.js";

/** Fixed webhook instant (2026-04-16T00:00:00.000Z) so events are reproducible. */
export const E2E_WEBHOOK_TIMESTAMP_MS = 1_776_211_200_000;

export const E2E_WEBHOOK_SUMMARY = "webhook summary (untrusted test text)";
export const E2E_WEBHOOK_STATUS = "Open";
export const E2E_WEBHOOK_COMMENT = "webhook comment (untrusted test text)";
export const E2E_WEBHOOK_ACTOR_ID = "test-account-0001";
export const E2E_WEBHOOK_ACTOR_NAME = "Test Reporter";

export interface E2EWebhookOptions {
  issueKey?: string;
  projectKey?: string;
  timestampMs?: number;
  /** Omit summary/status/actor to model a sparse provider delivery. */
  sparse?: boolean;
}

function issue(options: E2EWebhookOptions) {
  const sparse = options.sparse ?? false;
  return {
    id: `10000-${options.issueKey ?? `${E2E_PROJECT_KEY}-1`}`,
    key: options.issueKey ?? `${E2E_PROJECT_KEY}-1`,
    fields: {
      project: { key: options.projectKey ?? E2E_PROJECT_KEY },
      ...(sparse ? {} : { summary: E2E_WEBHOOK_SUMMARY, status: { name: E2E_WEBHOOK_STATUS } }),
    },
  };
}

function base(options: E2EWebhookOptions) {
  const sparse = options.sparse ?? false;
  return {
    timestamp: options.timestampMs ?? E2E_WEBHOOK_TIMESTAMP_MS,
    issue: issue(options),
    ...(sparse
      ? {}
      : { user: { accountId: E2E_WEBHOOK_ACTOR_ID, displayName: E2E_WEBHOOK_ACTOR_NAME } }),
  };
}

/** `jira:issue_created` delivery. */
export function issueCreatedWebhook(options: E2EWebhookOptions = {}): unknown {
  return { webhookEvent: "jira:issue_created", ...base(options) };
}

/** `jira:issue_updated` delivery; `sparse` drops summary/status/actor. */
export function issueUpdatedWebhook(options: E2EWebhookOptions = {}): unknown {
  return { webhookEvent: "jira:issue_updated", ...base(options) };
}

/** `comment_created` delivery. */
export function commentCreatedWebhook(options: E2EWebhookOptions = {}): unknown {
  return {
    webhookEvent: "comment_created",
    ...base(options),
    comment: { body: E2E_WEBHOOK_COMMENT },
  };
}
