import {
  Database,
  JiraWebhookRegistrationRepository,
  type JobLease,
  type JobStore,
  type OutboxRepository,
} from "@remoteagent/database";
import * as z from "zod";
import { JiraContractError } from "../errors.js";
import {
  JiraWebhookRegistrationClient,
  type JiraWebhookConfig,
  type JiraWebhookDetails,
} from "./registration.js";

const renewalJobSchema = z.strictObject({
  registrationId: z.string().min(1).max(512),
  ownerId: z.string().min(1).max(512),
  connectionId: z.string().min(1).max(512),
  generation: z.int().min(1),
  operation: z.enum(["register", "renew"]),
  configDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type JiraWebhookRenewalJobPayload = z.infer<typeof renewalJobSchema>;
export const JIRA_WEBHOOK_RENEWAL_FAILURE_EVENT_TYPE = "jira.webhook.renewal.failed" as const;
export interface JiraWebhookRenewalDependencies {
  db: Database;
  jobs: JobStore;
  registrations: JiraWebhookRegistrationRepository;
  client: JiraWebhookRegistrationClient;
  /** Reserved for terminal alert emission in subunit C. */
  outbox: Pick<OutboxRepository, "enqueue">;
  now: () => Date;
}
export interface JiraWebhookRenewalScheduleInput {
  ownerId: string;
  connectionId: string;
}
export interface JiraWebhookWorkerInput {
  lease: JobLease;
  config: JiraWebhookConfig;
  fault?: "after_remote" | "after_ambiguous";
}
export interface JiraWebhookTerminalFailureInput {
  jobId: string;
  registrationId: string;
  generation: number;
  ownerId: string;
  connectionId: string;
  errorCode: string;
  fault?: "after_alert";
}

export function findMatchingJiraWebhook(
  items: readonly JiraWebhookDetails[],
  config: JiraWebhookConfig,
): JiraWebhookDetails[] {
  return items.filter(
    (item) =>
      item.url === config.callbackUrl &&
      item.jqlFilter === config.jqlFilter &&
      item.events.length === config.events.length &&
      item.events.every((event) => config.events.includes(event)),
  );
}

export class JiraWebhookRenewalService {
  public constructor(private readonly deps: JiraWebhookRenewalDependencies) {}

  public async scheduleDue(input: JiraWebhookRenewalScheduleInput): Promise<string | null> {
    const now = this.deps.now();
    return this.deps.db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `jira-webhook:${input.connectionId}`,
      ]);
      const current = await this.deps.registrations.findScoped(
        tx,
        input.ownerId,
        input.connectionId,
      );
      if (current?.status === "RENEWING") {
        const existing = await tx.query<{ job_id: string }>(
          `SELECT job_id FROM jobs WHERE job_type='jira.webhook.renewal' AND status IN ('PENDING','LEASED','RECONCILING') AND payload->>'registrationId'=$1 AND payload->>'generation'=$2`,
          [current.registration_id, String(current.generation)],
        );
        return existing.rows[0]?.job_id ?? null;
      }
      const registration = await this.deps.registrations.markRenewing(
        tx,
        input.ownerId,
        input.connectionId,
        now,
      );
      if (!registration) return null;
      const existing = await tx.query<{ job_id: string }>(
        `SELECT job_id FROM jobs WHERE job_type='jira.webhook.renewal' AND status IN ('PENDING','LEASED','RECONCILING') AND payload->>'registrationId'=$1 AND payload->>'generation'=$2`,
        [registration.registration_id, String(registration.generation)],
      );
      if (existing.rows[0]) return existing.rows[0].job_id;
      const payload: JiraWebhookRenewalJobPayload = {
        registrationId: registration.registration_id,
        ownerId: registration.owner_id,
        connectionId: registration.connection_id,
        generation: registration.generation,
        operation: registration.external_registration_id ? "renew" : "register",
        configDigest: registration.config_digest,
      };
      const job = await this.deps.jobs.enqueue(tx, {
        jobType: "jira.webhook.renewal",
        provider: "jira",
        serializationKey: `jira-webhook:${registration.connection_id}`,
        payload,
      });
      return job.job_id;
    });
  }

  public async runWorker(
    input: JiraWebhookWorkerInput,
  ): Promise<{ intentId: string; externalRegistrationId: string; expiresAt: Date }> {
    const payload = renewalJobSchema.safeParse(input.lease.payload);
    if (!payload.success) throw new JiraContractError("invalid jira renewal job");
    if (JiraWebhookRegistrationClient.digest(input.config) !== payload.data.configDigest)
      throw new JiraContractError("stale jira renewal configuration");
    const registration = await this.deps.registrations.findByRegistrationId(
      this.deps.db,
      payload.data.registrationId,
    );
    if (
      !registration ||
      registration.owner_id !== payload.data.ownerId ||
      registration.connection_id !== payload.data.connectionId ||
      registration.generation !== payload.data.generation ||
      registration.config_digest !== payload.data.configDigest
    )
      throw new JiraContractError("stale jira renewal generation");
    const intentId = await this.deps.jobs.recordIntent(this.deps.db, input.lease, {
      kind: `jira.webhook.${payload.data.operation}`,
      idempotencyKey: `jira-webhook:${payload.data.registrationId}:${payload.data.generation}:${payload.data.operation}`,
      descriptor: payload.data,
    });
    let externalRegistrationId = registration.external_registration_id;
    let expiresAt: Date;
    if (payload.data.operation === "renew" && externalRegistrationId) {
      expiresAt = await this.deps.client.refresh([externalRegistrationId]);
    } else {
      const ids = await this.deps.client.register(input.config);
      if (ids.length !== 1) throw new JiraContractError("jira webhook registration cardinality");
      externalRegistrationId = ids[0]!;
      const matches = findMatchingJiraWebhook(await this.deps.client.list(), input.config).filter(
        (item) => item.id === externalRegistrationId,
      );
      if (matches.length !== 1)
        throw new JiraContractError("jira webhook registration reconciliation failed");
      expiresAt = new Date(matches[0]!.expirationDate);
    }
    await this.deps.db.withTransaction((tx) =>
      this.deps.registrations.markReconciling(
        tx,
        registration.registration_id,
        registration.generation,
      ),
    );
    await this.deps.jobs.recordCompletion(this.deps.db, {
      intentId,
      jobId: input.lease.jobId,
      outcome: "AMBIGUOUS",
      receipt: { externalRegistrationId, expiresAt: expiresAt.toISOString() },
      lease: input.lease,
    });
    if (input.fault === "after_remote" || input.fault === "after_ambiguous")
      throw new JiraContractError("jira renewal remote side effect unresolved");
    await this.reconcile({
      jobId: input.lease.jobId,
      intentId,
      attemptKey: `remote:${payload.data.generation}:${externalRegistrationId}`,
      payload: payload.data,
      config: input.config,
    });
    return { intentId, externalRegistrationId: externalRegistrationId!, expiresAt };
  }

  public async reconcile(input: {
    jobId: string;
    intentId: string;
    attemptKey: string;
    payload: JiraWebhookRenewalJobPayload;
    config: JiraWebhookConfig;
  }): Promise<void> {
    const parsedPayload = renewalJobSchema.safeParse(input.payload);
    if (
      !parsedPayload.success ||
      parsedPayload.data.configDigest !== JiraWebhookRegistrationClient.digest(input.config) ||
      parsedPayload.data.ownerId.length < 1
    )
      throw new JiraContractError("invalid jira renewal reconciliation payload");
    const registration = await this.deps.registrations.findByRegistrationId(
      this.deps.db,
      parsedPayload.data.registrationId,
    );
    if (
      !registration ||
      registration.owner_id !== parsedPayload.data.ownerId ||
      registration.connection_id !== parsedPayload.data.connectionId ||
      registration.generation !== parsedPayload.data.generation ||
      registration.config_digest !== parsedPayload.data.configDigest
    )
      throw new JiraContractError("stale jira renewal generation");
    const matches = findMatchingJiraWebhook(await this.deps.client.list(), input.config);
    if (matches.length === 1) {
      const expiry = new Date(matches[0]!.expirationDate);
      await this.deps.db.withTransaction((tx) =>
        this.deps.registrations.markActive(
          tx,
          registration.registration_id,
          registration.generation,
          matches[0]!.id,
          expiry,
          new Date(expiry.getTime() - 7 * 24 * 60 * 60 * 1000),
        ),
      );
      await this.deps.jobs.reconcile(this.deps.db, {
        intentId: input.intentId,
        jobId: input.jobId,
        resolution: "CONFIRMED",
        attemptKey: input.attemptKey,
        evidence: {
          externalRegistrationId: matches[0]!.id,
          expirationDate: matches[0]!.expirationDate,
        },
      });
      return;
    }
    if (matches.length === 0) {
      await this.deps.db.withTransaction((tx) =>
        this.deps.registrations.markRegistering(
          tx,
          registration.registration_id,
          registration.generation,
        ),
      );
      await this.deps.jobs.reconcile(this.deps.db, {
        intentId: input.intentId,
        jobId: input.jobId,
        resolution: "ABSENT",
        attemptKey: input.attemptKey,
      });
      return;
    }
    throw new JiraContractError("jira webhook reconciliation ambiguous");
  }

  public async recordTerminalFailure(input: JiraWebhookTerminalFailureInput): Promise<boolean> {
    const errorCode = input.errorCode.trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(errorCode))
      throw new JiraContractError("invalid jira renewal error code");
    return this.deps.db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `jira-webhook-alert:${input.registrationId}:${input.generation}`,
      ]);
      const registration = await this.deps.registrations.findByRegistrationId(
        tx,
        input.registrationId,
      );
      if (
        !registration ||
        registration.owner_id !== input.ownerId ||
        registration.connection_id !== input.connectionId ||
        registration.generation !== input.generation
      )
        throw new JiraContractError("stale jira renewal generation");
      const job = await tx.query<{
        status: string;
        attempts: number;
        max_attempts: number;
        registration_id: string;
        generation: string;
      }>(
        "SELECT status, attempts, max_attempts, payload->>'registrationId' registration_id, payload->>'generation' generation FROM jobs WHERE job_id=$1",
        [input.jobId],
      );
      const jobRow = job.rows[0];
      if (
        !jobRow ||
        jobRow.status !== "DEAD_LETTER" ||
        jobRow.attempts < jobRow.max_attempts ||
        jobRow.registration_id !== input.registrationId ||
        jobRow.generation !== String(input.generation)
      )
        throw new JiraContractError("jira renewal retry not exhausted");
      const claimed = await this.deps.registrations.markTerminalFailed(
        tx,
        input.registrationId,
        input.generation,
        errorCode,
      );
      if (!claimed) return false;
      await this.deps.outbox.enqueue(tx, {
        aggregate: "jira_webhook",
        aggregateId: input.registrationId,
        eventType: JIRA_WEBHOOK_RENEWAL_FAILURE_EVENT_TYPE,
        payload: {
          registrationId: input.registrationId,
          connectionId: input.connectionId,
          status: "FAILED",
          errorCode,
        },
      });
      if (input.fault === "after_alert")
        throw new JiraContractError("jira terminal alert rollback");
      return true;
    });
  }
}

export async function reconcileJiraWebhook(
  client: JiraWebhookRegistrationClient,
  config: JiraWebhookConfig,
): Promise<string> {
  const matches = findMatchingJiraWebhook(await client.list(), config);
  if (matches.length !== 1)
    throw new JiraContractError(
      matches.length === 0 ? "jira webhook absent" : "jira webhook ambiguous",
    );
  return matches[0]!.id;
}
