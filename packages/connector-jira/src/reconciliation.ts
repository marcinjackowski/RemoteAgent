import { createHash } from "node:crypto";
import {
  ConnectionRepository,
  Database,
  JiraReconciliationRepository,
  type Transaction,
} from "@remoteagent/database";
import type { JiraIssueResponse } from "./rest/client.js";
import { JiraContractError } from "./errors.js";
import { adaptJiraSnapshotRepository, buildJiraIssueSnapshot } from "./enrichment.js";
import * as z from "zod";

const inputSchema = z.strictObject({
  ownerId: z.string().trim().min(1).max(512),
  connectionId: z.string().trim().min(1).max(512),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
});
export interface JiraReconciliationInput {
  ownerId: string;
  connectionId: string;
  projectKey: string;
}
export interface JiraReconciliationSearch {
  searchJql(jql: string, maxPages: number, maxIssues: number): Promise<unknown>;
}
export interface JiraReconciliationIssueContext {
  eventId: string;
  ownerId: string;
  connectionId: string;
  projectKey: string;
  issue: JiraIssueResponse;
}
export interface JiraReconciliationOptions {
  db: Database;
  search: JiraReconciliationSearch;
  applyIssue: (tx: Transaction, context: JiraReconciliationIssueContext) => Promise<void>;
  fault?: "before_commit" | "after_commit";
  capturedAt: string;
}
export interface JiraReconciliationResult {
  applied: number;
  watermarkMs: number;
  revision: number;
  replay: boolean;
}

function eventId(
  ownerId: string,
  connectionId: string,
  projectKey: string,
  issue: JiraIssueResponse,
): string {
  return `reconcile-${createHash("sha256")
    .update(`${ownerId}\0${connectionId}\0${projectKey}\0${issue.key}\0${issueUpdatedMs(issue)}`)
    .digest("hex")}`;
}
function issueUpdatedMs(issue: JiraIssueResponse): number {
  const ms = Date.parse(issue.fields.updated);
  if (!Number.isFinite(ms) || ms < 0)
    throw new JiraContractError("invalid jira reconciliation timestamp");
  return ms;
}
function compareIssueKey(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
const issueSchema = z.strictObject({
  id: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
  fields: z.strictObject({
    project: z.strictObject({ key: z.string().min(1).max(128) }),
    summary: z
      .strictObject({ trust: z.literal("UNTRUSTED_DATA"), value: z.string().max(65_536) })
      .optional(),
    description: z
      .strictObject({ trust: z.literal("UNTRUSTED_DATA"), value: z.string().max(65_536) })
      .optional(),
    status: z
      .strictObject({ trust: z.literal("UNTRUSTED_DATA"), value: z.string().max(256) })
      .optional(),
    labels: z.array(z.string().max(256)).max(128),
    updated: z.string().min(1).max(64),
  }),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function validateIssues(value: unknown, projectKey: string): JiraIssueResponse[] {
  if (!Array.isArray(value)) throw new JiraContractError("jira reconciliation response rejected");
  if (value.length > 10_000)
    throw new JiraContractError("jira reconciliation result limit exceeded");
  const parsed = value.map((issue) => {
    const result = issueSchema.safeParse(issue);
    if (!result.success || result.data.fields.project.key !== projectKey)
      throw new JiraContractError("jira reconciliation response rejected");
    issueUpdatedMs(result.data as JiraIssueResponse);
    return result.data as JiraIssueResponse;
  });
  const byKey = new Map<string, JiraIssueResponse>();
  for (const issue of parsed) {
    const previous = byKey.get(issue.key);
    if (previous !== undefined && canonical(previous) !== canonical(issue))
      throw new JiraContractError("jira reconciliation duplicate conflict");
    byKey.set(issue.key, issue);
  }
  parsed.splice(0, parsed.length, ...byKey.values());
  parsed.sort(
    (a, b) =>
      issueUpdatedMs(a) - issueUpdatedMs(b) || Buffer.from(a.key).compare(Buffer.from(b.key)),
  );
  const unique: JiraIssueResponse[] = [];
  for (const issue of parsed) {
    const previous = unique[unique.length - 1];
    if (previous?.key === issue.key) continue;
    unique.push(issue);
  }
  return unique;
}
const MAX_PAGES = 100;
const MAX_ISSUES = 10_000;
const BOOTSTRAP_MS = 0;
export async function reconcileJiraIssues(
  input: JiraReconciliationInput,
  options: JiraReconciliationOptions,
): Promise<JiraReconciliationResult> {
  const valid = inputSchema.safeParse(input);
  if (!valid.success) throw new JiraContractError("invalid jira reconciliation input");
  const connection = await new ConnectionRepository().findById(options.db, valid.data.connectionId);
  if (!connection || connection.owner_id !== valid.data.ownerId || connection.provider !== "jira")
    throw new JiraContractError("jira reconciliation scope rejected");
  const cursor = await new JiraReconciliationRepository().find(
    options.db,
    valid.data.ownerId,
    valid.data.connectionId,
    valid.data.projectKey,
  );
  const cursorMs = cursor ? Number(cursor.watermark_ms) : BOOTSTRAP_MS;
  const issues = validateIssues(
    await options.search.searchJql(
      // Jira JQL rejects ISO 8601 (`...T..:..Z`) for date fields and, worse, answers a malformed
      // date bound with HTTP 200 and zero rows instead of an error — so `new Date().toISOString()`
      // silently matched nothing and the watermark never advanced. Epoch milliseconds ARE accepted.
      // JQL date comparison is minute-granular, but the exact ms + key filter below (`eligible`)
      // re-narrows the result, so a coarser bound only over-includes; it never drops a change.
      `project = ${valid.data.projectKey} AND updated >= ${cursorMs} ORDER BY updated ASC, key ASC`,
      MAX_PAGES,
      MAX_ISSUES,
    ),
    valid.data.projectKey,
  );
  const repo = new JiraReconciliationRepository();
  let result: JiraReconciliationResult | undefined;
  let applied = 0;
  await options.db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `jira-reconciliation:${valid.data.connectionId}:${valid.data.projectKey}`,
    ]);
    const current = await repo.find(
      tx,
      valid.data.ownerId,
      valid.data.connectionId,
      valid.data.projectKey,
      true,
    );
    const currentWatermark = current ? Number(current.watermark_ms) : BOOTSTRAP_MS;
    const currentIssueKey = current?.last_issue_key ?? "";
    const currentRevision = current ? Number(current.revision) : 0;
    const eligible = issues.filter((issue) => {
      const updated = issueUpdatedMs(issue);
      return (
        updated > currentWatermark ||
        (updated === currentWatermark && compareIssueKey(issue.key, currentIssueKey) > 0)
      );
    });
    if (current && eligible.length === 0) {
      result = {
        applied: 0,
        watermarkMs: currentWatermark,
        revision: currentRevision,
        replay: true,
      };
      return;
    }
    let watermarkMs = currentWatermark;
    let lastIssueKey = currentIssueKey;
    for (const issue of eligible) {
      const updated = issueUpdatedMs(issue);
      watermarkMs = Math.max(watermarkMs, updated);
      if (updated === watermarkMs) lastIssueKey = issue.key;
      const snapshot = buildJiraIssueSnapshot(
        issue,
        valid.data.connectionId,
        valid.data.ownerId,
        options.capturedAt,
      );
      const store = adaptJiraSnapshotRepository(repo, tx);
      const claim = await store.putIfNewer(snapshot);
      if (claim === "stale") continue;
      await options.applyIssue(tx, {
        eventId: eventId(valid.data.ownerId, valid.data.connectionId, valid.data.projectKey, issue),
        ownerId: valid.data.ownerId,
        connectionId: valid.data.connectionId,
        projectKey: valid.data.projectKey,
        issue,
      });
      applied += 1;
    }
    const advanced = await repo.advance(tx, {
      ownerId: valid.data.ownerId,
      connectionId: valid.data.connectionId,
      projectKey: valid.data.projectKey,
      watermarkMs,
      lastIssueKey,
      expectedRevision: currentRevision,
    });
    if (options.fault === "before_commit")
      throw new JiraContractError("jira reconciliation rollback");
    result = {
      applied,
      watermarkMs: Number(advanced.watermark_ms),
      revision: Number(advanced.revision),
      replay: false,
    };
  });
  if (options.fault === "after_commit")
    throw new JiraContractError("jira reconciliation committed");
  return result!;
}
