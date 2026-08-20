import { createHash } from "node:crypto";
import {
  CaseRepository,
  ConnectionRepository,
  Database,
  DiscordBindingRepository,
  ExternalEntityRepository,
  JiraCorrelationRepository,
} from "@remoteagent/database";
import {
  DISCORD_EVENT_TYPES,
  rootThreadPayload,
  threadMessagePayload,
  type ChannelRegistry,
} from "@remoteagent/discord";
import * as z from "zod";
import { JiraContractError } from "./errors.js";
import { projectJiraIssue } from "./projection.js";

export interface JiraCorrelationInput {
  eventId: string;
  issueKey: string;
  status?: string;
  summary?: string;
}
export interface JiraCorrelationOptions {
  db: Database;
  ownerId: string;
  connectionId: string;
  channelRegistry: Pick<ChannelRegistry, "routeChannelId">;
  ids: { caseId(): string; entityId(): string; outboxId(): string };
  fault?: (stage: "case" | "entity" | "binding" | "sequence" | "outbox" | "receipt") => void;
}
export interface JiraCorrelationResult {
  replay: boolean;
  eventId: string;
  caseId: string;
  entityId: string;
  outboxId: string;
  seq: number;
  eventType: "discord.root_thread" | "discord.thread_message";
}
const correlationInputSchema = z.strictObject({
  eventId: z.string().trim().min(1).max(512),
  issueKey: z.string().trim().min(1).max(128),
  status: z.string().max(65_536).optional(),
  summary: z.string().max(65_536).optional(),
});
function digestFor(event: z.infer<typeof correlationInputSchema>): string {
  const canonical = JSON.stringify({
    eventId: event.eventId,
    issueKey: event.issueKey,
    status: event.status ?? null,
    summary: event.summary ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export async function correlateJiraIssue(input: unknown, options: JiraCorrelationOptions) {
  const parsed = correlationInputSchema.safeParse(input);
  if (!parsed.success) throw new JiraContractError("invalid jira correlation input");
  const event = parsed.data;
  const digest = digestFor(event);
  return options.db.withTransaction(async (tx) => {
    const connection = await new ConnectionRepository().findById(tx, options.connectionId);
    if (!connection || connection.provider !== "jira" || connection.owner_id !== options.ownerId)
      throw new JiraContractError("jira connection scope rejected");
    const channelId = options.channelRegistry.routeChannelId("jira", connection.alias);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${options.connectionId}:${event.issueKey}`,
    ]);
    const receipts = new JiraCorrelationRepository();
    const existingReceipt = await receipts.findByEventId(tx, event.eventId);
    if (existingReceipt) {
      if (
        existingReceipt.ownerId !== options.ownerId ||
        existingReceipt.connectionId !== options.connectionId ||
        existingReceipt.issueKey !== event.issueKey ||
        existingReceipt.canonicalDigest !== digest
      )
        throw new JiraContractError("jira projection conflict");
      const outbox = await tx.query<{
        event_type: string;
        aggregate: string;
        aggregate_id: string;
        payload: unknown;
      }>("SELECT event_type, aggregate, aggregate_id, payload FROM outbox WHERE outbox_id=$1", [
        existingReceipt.outboxId,
      ]);
      const outboxRow = outbox.rows[0];
      if (
        !outboxRow ||
        outboxRow.aggregate !== "discord_case" ||
        outboxRow.aggregate_id !== existingReceipt.caseId ||
        (outboxRow.event_type !== DISCORD_EVENT_TYPES.ROOT_THREAD &&
          outboxRow.event_type !== DISCORD_EVENT_TYPES.THREAD_MESSAGE)
      )
        throw new JiraContractError("jira projection receipt conflict");
      const payload =
        outboxRow.event_type === DISCORD_EVENT_TYPES.ROOT_THREAD
          ? rootThreadPayload.safeParse(outboxRow.payload)
          : threadMessagePayload.safeParse(outboxRow.payload);
      if (!payload.success || payload.data.case_id !== existingReceipt.caseId)
        throw new JiraContractError("jira projection receipt conflict");
      if (outboxRow.event_type === DISCORD_EVENT_TYPES.ROOT_THREAD && payload.data.seq !== 1)
        throw new JiraContractError("jira projection receipt conflict");
      if (outboxRow.event_type === DISCORD_EVENT_TYPES.THREAD_MESSAGE && payload.data.seq < 2)
        throw new JiraContractError("jira projection receipt conflict");
      const expectedProjection = projectJiraIssue({
        caseId: existingReceipt.caseId,
        ownerId: options.ownerId,
        seq: payload.data.seq,
        provider: "jira",
        alias: connection.alias,
        issueKey: event.issueKey,
        status: event.status,
        summary: event.summary,
      });
      const expectedPayload =
        outboxRow.event_type === DISCORD_EVENT_TYPES.ROOT_THREAD
          ? expectedProjection.root
          : expectedProjection.thread;
      if (canonicalJson(payload.data) !== canonicalJson(expectedPayload))
        throw new JiraContractError("jira projection receipt conflict");
      return {
        replay: true,
        eventId: existingReceipt.eventId,
        caseId: existingReceipt.caseId,
        entityId: existingReceipt.entityId,
        outboxId: existingReceipt.outboxId,
        seq: payload.data.seq,
        eventType: outboxRow.event_type,
      } satisfies JiraCorrelationResult;
    }
    const entities = new ExternalEntityRepository();
    const cases = new CaseRepository();
    const bindings = new DiscordBindingRepository();
    const found = await receipts.findScoped(
      tx,
      options.ownerId,
      options.connectionId,
      event.issueKey,
    );
    let caseId: string;
    let entityId: string;
    let seq: number;
    let eventType: string;
    if (found) {
      caseId = found.case_id;
      entityId = found.entity_id;
      const binding = await bindings.lockForUpdate(tx, caseId);
      if (!binding || binding.owner_id !== options.ownerId || binding.channel_id !== channelId)
        throw new JiraContractError("jira binding scope rejected");
      seq = await bindings.reserveSeq(tx, caseId);
      options.fault?.("sequence");
      eventType = DISCORD_EVENT_TYPES.THREAD_MESSAGE;
    } else {
      caseId = options.ids.caseId();
      entityId = options.ids.entityId();
      await cases.insert(tx, {
        caseId,
        ownerId: options.ownerId,
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: [options.connectionId] },
        discordThreadId: `pending_${caseId}`,
      });
      options.fault?.("case");
      await entities.insert(tx, {
        entityId,
        caseId,
        ownerId: options.ownerId,
        connectionId: options.connectionId,
        provider: "jira",
        kind: "jira_issue",
        externalId: event.issueKey,
      });
      options.fault?.("entity");
      const binding = await bindings.ensure(tx, { caseId, ownerId: options.ownerId, channelId });
      if (binding.owner_id !== options.ownerId || binding.channel_id !== channelId)
        throw new JiraContractError("jira binding scope rejected");
      options.fault?.("binding");
      seq = await bindings.reserveSeq(tx, caseId);
      options.fault?.("sequence");
      eventType = DISCORD_EVENT_TYPES.ROOT_THREAD;
    }
    const projection = projectJiraIssue({
      caseId,
      ownerId: options.ownerId,
      seq,
      provider: "jira",
      alias: connection.alias,
      issueKey: event.issueKey,
      status: event.status,
      summary: event.summary,
    });
    const payload =
      eventType === DISCORD_EVENT_TYPES.ROOT_THREAD ? projection.root : projection.thread;
    const outboxId = options.ids.outboxId();
    await tx.query(
      "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES($1,'discord_case',$2,$3,$4::jsonb)",
      [outboxId, caseId, eventType, JSON.stringify(payload)],
    );
    await tx.query("INSERT INTO outbox_dispatch(outbox_id) VALUES($1)", [outboxId]);
    options.fault?.("outbox");
    await receipts.record(tx, {
      eventId: event.eventId,
      ownerId: options.ownerId,
      connectionId: options.connectionId,
      issueKey: event.issueKey,
      caseId,
      entityId,
      outboxId,
      canonicalDigest: digest,
    });
    options.fault?.("receipt");
    return {
      replay: false,
      eventId: event.eventId,
      caseId,
      entityId,
      outboxId,
      seq,
      eventType: eventType as JiraCorrelationResult["eventType"],
    } satisfies JiraCorrelationResult;
  });
}
