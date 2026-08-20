import { createHash } from "node:crypto";
import { ExternalEntityKind, Provider } from "@remoteagent/contracts";
import { Database, EventRepository, JiraReconciliationRepository } from "@remoteagent/database";
import type { Transaction } from "@remoteagent/database";
import type { ChannelRegistry } from "@remoteagent/discord";
import * as z from "zod";
import { adaptJiraSnapshotRepository, buildJiraIssueSnapshot } from "./enrichment.js";
import {
  correlateJiraIssueInTransaction,
  replayJiraCorrelationInTransaction,
} from "./correlation.js";
import { jiraConnectorConfig } from "./contracts.js";
import { normalizeJiraPayload } from "./normalize.js";
import type { JiraRestClient } from "./rest/client.js";
import { readVerifiedJiraPayloadWithMetadata } from "./webhook/payload.js";
import type { RawPayloadReader } from "./webhook/payload.js";

const requestSchema = z.strictObject({ rawEventId: z.string().trim().min(1).max(512) });
const idSchema = z.string().trim().min(1).max(512);

export class JiraRuntimeError extends Error {
  public readonly code = "JIRA_RUNTIME_REJECTED" as const;
  public constructor(
    public readonly reason:
      | "input"
      | "payload_encoding"
      | "payload_json"
      | "payload_rejected"
      | "response_scope"
      | "event_conflict"
      | "rest_failure",
  ) {
    super("jira runtime request rejected");
    this.name = "JiraRuntimeError";
  }
}

export interface JiraRuntimeOptions {
  db: Database;
  ownerId: string;
  connectionId: string;
  reader: RawPayloadReader;
  config: unknown;
  restClient: JiraRestClient;
  channelRegistry: Pick<ChannelRegistry, "routeChannelId">;
  ids: { caseId(): string; entityId(): string; outboxId(): string };
  fault?: (
    stage:
      | "event"
      | "snapshot"
      | "correlation"
      | "case"
      | "entity"
      | "binding"
      | "sequence"
      | "outbox"
      | "receipt",
  ) => void;
}

export interface JiraRuntimeResult {
  status: "APPLIED" | "REPLAYED" | "STALE";
  eventId: string;
  issueKey: string;
  correlation?: Awaited<ReturnType<typeof correlateJiraIssueInTransaction>>;
}

function untrusted(value: { value: string } | undefined): string | undefined {
  return value?.value;
}

function eventMatches(
  row: Awaited<ReturnType<EventRepository["insertEvent"]>>["event"],
  event: ReturnType<typeof normalizeJiraPayload>["envelope"],
  ownerId: string,
  connectionId: string,
  rawEventId: string,
): boolean {
  return (
    row.event_id === event.event_id &&
    row.provider === Provider.JIRA &&
    row.owner_id === ownerId &&
    row.connection_id === connectionId &&
    row.external_event_id === event.external_event_id &&
    row.event_type === event.event_type &&
    row.dedupe_key === event.dedupe_key &&
    row.raw_event_id === rawEventId &&
    row.entity_provider === Provider.JIRA &&
    row.entity_kind === ExternalEntityKind.JIRA_ISSUE &&
    row.entity_external_id === event.entity_ref.external_id &&
    row.trace_id === event.trace_id &&
    row.sensitivity === event.sensitivity &&
    row.occurred_at.toISOString() === event.occurred_at
  );
}

/**
 * Deterministic per-event advisory-lock key.
 *
 * `event_id` is an opaque string, so it is namespaced and hashed into the signed
 * 64-bit space that `pg_advisory_xact_lock` accepts. Distinct `event_id`s map to
 * distinct keys (modulo negligible 64-bit hash collision, which would only cost
 * unnecessary serialization, never correctness), so concurrent processing of
 * different events never contends.
 */
function eventLockKey(eventId: string): bigint {
  return createHash("sha256").update(`jira-runtime-event:${eventId}`).digest().readBigInt64BE(0);
}

export async function processJiraWebhook(
  request: unknown,
  options: JiraRuntimeOptions,
): Promise<JiraRuntimeResult> {
  const parsedRequest = requestSchema.safeParse(request);
  const owner = idSchema.safeParse(options.ownerId);
  const connection = idSchema.safeParse(options.connectionId);
  const config = jiraConnectorConfig.safeParse(options.config);
  if (
    !parsedRequest.success ||
    !owner.success ||
    !connection.success ||
    !config.success ||
    config.data.owner_id !== options.ownerId ||
    config.data.connection_id !== options.connectionId
  )
    throw new JiraRuntimeError("input");
  const rawEventId = parsedRequest.data.rawEventId;
  const metadataResult = await readVerifiedJiraPayloadWithMetadata({
    db: options.db,
    ownerId: options.ownerId,
    connectionId: options.connectionId,
    rawEventId,
    reader: options.reader,
  });
  let rawText: string;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(metadataResult.bytes);
  } catch {
    throw new JiraRuntimeError("payload_encoding");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch {
    throw new JiraRuntimeError("payload_json");
  }
  let normalized: ReturnType<typeof normalizeJiraPayload>;
  try {
    normalized = normalizeJiraPayload(raw, {
      rawEventId,
      ownerId: metadataResult.metadata.ownerId,
      connectionId: metadataResult.metadata.connectionId,
      receivedAt: metadataResult.metadata.receivedAt,
      traceId: metadataResult.metadata.traceId,
      payloadRef: metadataResult.metadata.payloadRef,
      projectAllowlist: config.data.project_allowlist,
    });
  } catch {
    throw new JiraRuntimeError("payload_rejected");
  }
  const { envelope, jiraEvent } = normalized;
  const isDeleted = jiraEvent.event_type === "issue_deleted";

  // Single critical section per `event_id`: the replay probe, the enriching REST
  // GET, response-scope validation, snapshot construction and every write share
  // one transaction guarded by `pg_advisory_xact_lock`. Taking the lock BEFORE the
  // GET is what makes "exact replay is recognized before another REST call" hold
  // for concurrent deliveries; with the lock after the GET, N racing deliveries
  // each issued their own GET and only the write was serialized.
  //
  // The lock lives on the transaction's own connection (`pg_advisory_xact_lock`,
  // released by COMMIT/ROLLBACK) rather than on a second session-level lock
  // connection, so processing one event occupies exactly ONE pooled connection.
  // A session lock plus a nested transaction would need two, and N concurrent
  // deliveries would deadlock the default 10-connection pool at N > 5.
  return options.db.withTransaction(async (tx: Transaction) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [
      eventLockKey(envelope.event_id).toString(),
    ]);
    const existing = await replayJiraCorrelationInTransaction(
      tx,
      { eventId: envelope.event_id, issueKey: jiraEvent.issue_key },
      {
        ownerId: options.ownerId,
        connectionId: options.connectionId,
        channelRegistry: options.channelRegistry,
      },
    );
    if (existing)
      return {
        status: "REPLAYED",
        eventId: envelope.event_id,
        issueKey: jiraEvent.issue_key,
        correlation: existing,
      };
    let issue: Awaited<ReturnType<JiraRestClient["getIssue"]>> | undefined;
    if (!isDeleted) {
      try {
        issue = await options.restClient.getIssue(jiraEvent.issue_key);
      } catch {
        throw new JiraRuntimeError("rest_failure");
      }
    }
    let snapshot: ReturnType<typeof buildJiraIssueSnapshot> | undefined;
    if (issue) {
      if (
        issue.key !== jiraEvent.issue_key ||
        issue.fields.project.key !== jiraEvent.project_key ||
        !config.data.project_allowlist.includes(issue.fields.project.key)
      )
        throw new JiraRuntimeError("response_scope");
      snapshot = buildJiraIssueSnapshot(
        issue,
        options.connectionId,
        options.ownerId,
        metadataResult.metadata.receivedAt,
      );
    }
    const eventRepository = new EventRepository();
    const inserted = await eventRepository.insertEvent(tx, {
      eventId: envelope.event_id,
      provider: Provider.JIRA,
      connectionId: options.connectionId,
      ownerId: options.ownerId,
      externalEventId: envelope.external_event_id,
      eventType: envelope.event_type,
      dedupeKey: envelope.dedupe_key,
      rawEventId,
      entityProvider: Provider.JIRA,
      entityKind: ExternalEntityKind.JIRA_ISSUE,
      entityExternalId: envelope.entity_ref.external_id,
      correlationKeys: envelope.correlation_keys,
      actor: envelope.actor,
      traceId: envelope.trace_id,
      sensitivity: envelope.sensitivity,
      occurredAt: new Date(envelope.occurred_at),
    });
    if (
      !inserted.event ||
      !eventMatches(inserted.event, envelope, options.ownerId, options.connectionId, rawEventId)
    )
      throw new JiraRuntimeError("event_conflict");
    options.fault?.("event");
    if (snapshot) {
      const store = adaptJiraSnapshotRepository(new JiraReconciliationRepository(), tx);
      const disposition = await store.putIfNewer(snapshot);
      options.fault?.("snapshot");
      if (disposition === "stale") {
        const lateReplay = await replayJiraCorrelationInTransaction(
          tx,
          { eventId: envelope.event_id, issueKey: jiraEvent.issue_key },
          {
            ownerId: options.ownerId,
            connectionId: options.connectionId,
            channelRegistry: options.channelRegistry,
          },
        );
        return lateReplay
          ? {
              status: "REPLAYED",
              eventId: envelope.event_id,
              issueKey: jiraEvent.issue_key,
              correlation: lateReplay,
            }
          : { status: "STALE", eventId: envelope.event_id, issueKey: jiraEvent.issue_key };
      }
    }
    const correlation = await correlateJiraIssueInTransaction(
      tx,
      {
        eventId: envelope.event_id,
        issueKey: jiraEvent.issue_key,
        status: snapshot?.status.value ?? untrusted(jiraEvent.status),
        summary: snapshot?.summary.value ?? untrusted(jiraEvent.summary),
      },
      {
        ownerId: options.ownerId,
        connectionId: options.connectionId,
        channelRegistry: options.channelRegistry,
        ids: options.ids,
        fault: (stage) => options.fault?.(stage),
      },
    );
    options.fault?.("correlation");
    return {
      status: "APPLIED",
      eventId: envelope.event_id,
      issueKey: jiraEvent.issue_key,
      correlation,
    };
  });
}
