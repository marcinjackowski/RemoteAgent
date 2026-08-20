import { createHash } from "node:crypto";
import {
  ConnectionRepository,
  Database,
  JiraWebhookRegistrationRepository,
  type JobStore,
  type JiraWebhookRegistrationRow,
} from "@remoteagent/database";
import * as z from "zod";
import { JiraContractError } from "../errors.js";

export interface JiraWebhookHttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}
export interface JiraWebhookHttpResponse {
  status: number;
  json(): Promise<unknown>;
  headers?: Readonly<Record<string, string | undefined>>;
  finalUrl: string;
  redirected: boolean;
}
export type JiraWebhookTransport = (
  request: JiraWebhookHttpRequest,
) => Promise<JiraWebhookHttpResponse>;
const webhook = z.strictObject({
  id: z.union([z.string(), z.number()]),
  url: z.string().url().max(2048),
  events: z.array(z.string().min(1).max(128)).max(64),
  jqlFilter: z.string().max(4096),
  expirationDate: z.string().max(64),
});
const page = z.strictObject({
  values: z.array(webhook).max(100),
  isLast: z.boolean().optional(),
  startAt: z.number().int().nonnegative().optional(),
  maxResults: z.number().int().positive().max(100).optional(),
  total: z.number().int().nonnegative().max(10_000).optional(),
});
const callbackUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  }, "callback URL must be HTTPS without credentials/query/fragment");
const configSchema = z.strictObject({
  callbackUrl: callbackUrlSchema,
  events: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(64)
    .refine((events) => new Set(events).size === events.length, "events must be unique"),
  jqlFilter: z.string().min(1).max(4096),
});
export type JiraWebhookConfig = z.infer<typeof configSchema>;
export interface JiraWebhookRegistrationClientOptions {
  origin: string;
  getAccessToken: () => Promise<Uint8Array>;
  transport: JiraWebhookTransport;
}
export interface JiraWebhookDetails extends z.infer<typeof webhook> {
  id: string;
}
export class JiraWebhookRegistrationClient {
  public constructor(private readonly options: JiraWebhookRegistrationClientOptions) {}
  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(this.options.origin);
    } catch {
      throw new JiraContractError("invalid jira origin");
    }
    if (
      parsedOrigin.protocol !== "https:" ||
      parsedOrigin.username ||
      parsedOrigin.password ||
      parsedOrigin.search ||
      parsedOrigin.hash ||
      parsedOrigin.pathname !== "/"
    )
      throw new JiraContractError("invalid jira origin");
    const origin = parsedOrigin.origin;
    const pathname = path.split("?", 1)[0];
    if (
      !origin.startsWith("https://") ||
      (pathname !== "/rest/api/3/webhook" && pathname !== "/rest/api/3/webhook/refresh")
    )
      throw new JiraContractError("jira webhook path rejected");
    const leased = await this.options.getAccessToken();
    const token = new Uint8Array(leased);
    try {
      const response = await this.options.transport({
        method,
        url: `${origin}${path}`,
        headers: {
          Authorization: `Bearer ${new TextDecoder().decode(token)}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.redirected || response.finalUrl !== `${origin}${path}`)
        throw new JiraContractError("jira webhook redirect rejected");
      if (response.status < 200 || response.status >= 300)
        throw new JiraContractError("jira webhook request failed");
      return response.json();
    } finally {
      token.fill(0);
    }
  }
  public async list(): Promise<JiraWebhookDetails[]> {
    const values: JiraWebhookDetails[] = [];
    let startAt = 0;
    let completed = false;
    for (let pageNo = 0; pageNo < 100; pageNo += 1) {
      const requestedStartAt = startAt;
      const parsed = page.safeParse(
        await this.request("GET", `/rest/api/3/webhook?startAt=${requestedStartAt}&maxResults=100`),
      );
      if (!parsed.success) throw new JiraContractError("invalid jira webhook list");
      if (parsed.data.startAt !== undefined && parsed.data.startAt !== requestedStartAt)
        throw new JiraContractError("jira webhook pagination cycle");
      values.push(...parsed.data.values.map((item) => ({ ...item, id: String(item.id) })));
      if (parsed.data.isLast !== false && parsed.data.values.length < 100) {
        completed = true;
        break;
      }
      if (parsed.data.values.length === 0)
        throw new JiraContractError("jira webhook pagination no progress");
      startAt += parsed.data.values.length;
      if (startAt > 10_000) throw new JiraContractError("jira webhook list limit");
    }
    if (!completed) throw new JiraContractError("jira webhook pagination limit");
    return values;
  }
  public async register(config: JiraWebhookConfig): Promise<string[]> {
    const valid = configSchema.safeParse(config);
    if (!valid.success) throw new JiraContractError("invalid jira webhook config");
    const value = await this.request("POST", "/rest/api/3/webhook", {
      url: valid.data.callbackUrl,
      webhooks: [{ events: valid.data.events, jqlFilter: valid.data.jqlFilter }],
    });
    const parsed = z
      .strictObject({
        webhookRegistrationResult: z
          .array(
            z.strictObject({
              createdWebhookId: z.union([z.string(), z.number()]).optional(),
              errors: z.array(z.string().max(512)).max(64).optional(),
            }),
          )
          .max(64),
      })
      .safeParse(value);
    if (!parsed.success) throw new JiraContractError("invalid jira webhook registration response");
    const errors = parsed.data.webhookRegistrationResult.flatMap((item) => item.errors ?? []);
    if (
      errors.length ||
      parsed.data.webhookRegistrationResult.some((item) => item.createdWebhookId === undefined)
    )
      throw new JiraContractError("jira webhook registration failed");
    return parsed.data.webhookRegistrationResult.map((item) => String(item.createdWebhookId));
  }
  public async refresh(ids: readonly string[]): Promise<Date> {
    if (ids.length < 1 || ids.length > 100 || ids.some((id) => !/^[0-9]+$/.test(id)))
      throw new JiraContractError("invalid jira webhook ids");
    const value = await this.request("PUT", "/rest/api/3/webhook/refresh", {
      webhookIds: ids.map(Number),
    });
    const parsed = z.strictObject({ expirationDate: z.string().max(64) }).safeParse(value);
    if (!parsed.success) throw new JiraContractError("invalid jira webhook refresh response");
    const date = new Date(parsed.data.expirationDate);
    if (!Number.isFinite(date.getTime()))
      throw new JiraContractError("invalid jira webhook expiry");
    return date;
  }
  public static digest(config: JiraWebhookConfig): string {
    const value = configSchema.parse(config);
    return `sha256:${createHash("sha256")
      .update(
        JSON.stringify({
          callbackUrl: value.callbackUrl,
          events: [...value.events].sort(),
          jqlFilter: value.jqlFilter,
        }),
      )
      .digest("hex")}`;
  }
}

export interface JiraWebhookRegistrationServiceOptions {
  db: Database;
  ownerId: string;
  connectionId: string;
  registrationId: string;
  config: JiraWebhookConfig;
  client: JiraWebhookRegistrationClient;
  jobs: JobStore;
}
export class JiraWebhookRegistrationService {
  public async ensure(
    options: JiraWebhookRegistrationServiceOptions,
  ): Promise<JiraWebhookRegistrationRow> {
    const connection = await new ConnectionRepository().findById(options.db, options.connectionId);
    if (!connection || connection.owner_id !== options.ownerId || connection.provider !== "jira")
      throw new JiraContractError("jira registration scope rejected");
    const repo = new JiraWebhookRegistrationRepository();
    const digest = JiraWebhookRegistrationClient.digest(options.config);
    return options.db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `jira-webhook:${options.connectionId}`,
      ]);
      const current = await repo.findScoped(tx, options.ownerId, options.connectionId);
      if (
        current?.status === "ACTIVE" &&
        current.config_digest === digest &&
        current.callback_url === options.config.callbackUrl
      )
        return current;
      if (current?.status === "REGISTERING" && current.config_digest === digest) {
        const existing = await tx.query<{ job_id: string }>(
          `SELECT job_id FROM jobs WHERE job_type='jira.webhook.renewal' AND status IN ('PENDING','LEASED','RECONCILING') AND payload->>'registrationId'=$1 AND payload->>'generation'=$2`,
          [current.registration_id, String(current.generation)],
        );
        if (existing.rows[0]) return current;
      }
      const row = await repo.upsert(tx, {
        registrationId: options.registrationId,
        ownerId: options.ownerId,
        connectionId: options.connectionId,
        callbackUrl: options.config.callbackUrl,
        configDigest: digest,
        status: "REGISTERING",
        generation: (current?.generation ?? 0) + 1,
        externalRegistrationId: null,
        expiresAt: null,
        renewAfter: null,
      });
      await options.jobs.enqueue(tx, {
        jobType: "jira.webhook.renewal",
        provider: "jira",
        serializationKey: `jira-webhook:${row.connection_id}`,
        payload: {
          registrationId: row.registration_id,
          ownerId: row.owner_id,
          connectionId: row.connection_id,
          generation: row.generation,
          operation: "register",
          configDigest: row.config_digest,
        },
      });
      return row;
    });
  }
}
