import { ExternalEntityKind, Provider, TrustLevel, eventEnvelope } from "@remoteagent/contracts";
import { createHash } from "node:crypto";
import { jiraEventContract } from "./contracts.js";
import { JiraContractError } from "./errors.js";
import { parseJiraPayload } from "./parser.js";
import { assertJiraProjectInScope } from "./scope.js";
import type { JiraIngressContext, ParsedJiraEvent } from "./types.js";

export function normalizeJiraPayload(raw: unknown, context: JiraIngressContext): ParsedJiraEvent {
  const parsed = parseJiraPayload(raw);
  assertJiraProjectInScope(parsed.projectKey, context.projectAllowlist);
  const orderingKey = `${parsed.occurredAt}:${createHash("sha256").update(context.rawEventId).digest("hex")}`;
  const actor =
    parsed.actorId || parsed.actorName
      ? {
          external_actor_id: parsed.actorId,
          display_name: parsed.actorName
            ? { trust: TrustLevel.UNTRUSTED_DATA, value: parsed.actorName }
            : undefined,
        }
      : {};
  const envelope = eventEnvelope.parse({
    schema_version: 1,
    event_id: context.rawEventId,
    provider: Provider.JIRA,
    connection_id: context.connectionId,
    external_event_id: context.rawEventId,
    event_type: parsed.eventType,
    occurred_at: parsed.occurredAt,
    received_at: context.receivedAt,
    actor,
    entity_ref: {
      provider: Provider.JIRA,
      connection_id: context.connectionId,
      kind: ExternalEntityKind.JIRA_ISSUE,
      external_id: parsed.issueKey,
    },
    correlation_keys: [parsed.projectKey, parsed.issueKey],
    dedupe_key: context.rawEventId,
    payload_ref: context.payloadRef,
    trace_id: context.traceId,
    sensitivity: "restricted",
  });
  const untrusted = (value: string | undefined) =>
    value === undefined ? undefined : { trust: TrustLevel.UNTRUSTED_DATA, value };
  const changes = parsed.changes?.map((change) => ({
    field: untrusted(change.field),
    ...(change.from === undefined ? {} : { from: untrusted(change.from) }),
    ...(change.to === undefined ? {} : { to: untrusted(change.to) }),
  }));
  const jiraEvent = jiraEventContract.parse({
    schema_version: 1,
    event_id: context.rawEventId,
    connection_id: context.connectionId,
    owner_id: context.ownerId,
    project_key: parsed.projectKey,
    issue_key: parsed.issueKey,
    event_type: parsed.eventType,
    occurred_at: parsed.occurredAt,
    received_at: context.receivedAt,
    summary: untrusted(parsed.summary),
    description: untrusted(parsed.description),
    comment: untrusted(parsed.comment),
    status: untrusted(parsed.status),
    ordering_key: orderingKey,
    ...(changes === undefined ? {} : { changes }),
  });
  if (envelope.connection_id !== context.connectionId)
    throw new JiraContractError("invalid jira scope");
  return { envelope, jiraEvent, orderingKey };
}
