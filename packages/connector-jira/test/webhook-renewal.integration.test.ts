import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  ConnectionRepository,
  Database,
  JobStore,
  JiraWebhookRegistrationRepository,
  OwnerRepository,
  OutboxRepository,
  productionRuntime,
} from "@remoteagent/database";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  JiraWebhookRegistrationClient,
  JiraWebhookRegistrationService,
  JiraWebhookRenewalService,
  type JiraWebhookRenewalJobPayload,
  reconcileJiraWebhook,
} from "../src/index.js";

const available = await ensurePostgres();
describeIntegration(
  "jira webhook registration lifecycle",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const config = {
      callbackUrl: "https://remoteagent.example/webhook",
      events: ["jira:issue_updated"],
      jqlFilter: "project = PROJ",
    };
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE jira_webhook_registrations, jobs, outbox_dispatch, outbox, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
    });
    const client = (response: unknown, seen: { method?: string } = {}) =>
      new JiraWebhookRegistrationClient({
        origin: "https://tenant.atlassian.net",
        getAccessToken: async () => new TextEncoder().encode("opaque-token"),
        transport: async (request) => {
          seen.method = request.method;
          return {
            status: 200,
            finalUrl: request.url,
            redirected: false,
            json: async () => response,
          };
        },
      });
    it("persists bounded registration health and is idempotent when active", async () => {
      const service = new JiraWebhookRegistrationService();
      const jobs = new JobStore(productionRuntime());
      const first = await service.ensure({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        registrationId: "registration-1",
        config,
        client: client({}),
        jobs,
      });
      expect(first.status).toBe("REGISTERING");
      const second = await service.ensure({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        registrationId: "registration-2",
        config,
        client: client({}),
        jobs,
      });
      expect(second.generation).toBe(1);
    });
    it("runs the initial registration job through intent, reconciliation and completion", async () => {
      const jobs = new JobStore(productionRuntime());
      const registrationClient = new JiraWebhookRegistrationClient({
        origin: "https://tenant.atlassian.net",
        getAccessToken: async () => new TextEncoder().encode("opaque-token"),
        transport: async (request) => ({
          status: 200,
          finalUrl: request.url,
          redirected: false,
          json: async () =>
            request.method === "POST"
              ? { webhookRegistrationResult: [{ createdWebhookId: 77 }] }
              : {
                  values: [
                    {
                      id: 77,
                      url: config.callbackUrl,
                      events: config.events,
                      jqlFilter: config.jqlFilter,
                      expirationDate: "2030-01-01T00:00:00Z",
                    },
                  ],
                  isLast: true,
                },
        }),
      });
      const registration = await new JiraWebhookRegistrationService().ensure({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        registrationId: "initial-registration",
        config,
        client: registrationClient,
        jobs,
      });
      const lease = await jobs.claim(db, { owner: "initial-worker", leaseMs: 60_000 });
      expect(lease).not.toBeNull();
      const service = new JiraWebhookRenewalService({
        db,
        jobs,
        registrations: new JiraWebhookRegistrationRepository(),
        client: registrationClient,
        outbox: new OutboxRepository(productionRuntime()),
        now: () => new Date("2025-01-01T00:00:00Z"),
      });
      await service.runWorker({ lease: lease!, config });
      expect(
        (
          await new JiraWebhookRegistrationRepository().findByRegistrationId(
            db,
            registration.registration_id,
          )
        )?.status,
      ).toBe("ACTIVE");
      expect(
        (await db.query("SELECT status FROM jobs WHERE job_id=$1", [lease!.jobId])).rows[0]?.status,
      ).toBe("SUCCEEDED");
    });
    it("lists and reconciles one exact provider registration", async () => {
      const seen: { method?: string } = {};
      const id = await reconcileJiraWebhook(
        client(
          {
            values: [
              {
                id: 42,
                url: config.callbackUrl,
                events: config.events,
                jqlFilter: config.jqlFilter,
                expirationDate: "2030-01-01T00:00:00Z",
              },
            ],
            isLast: true,
          },
          seen,
        ),
        config,
      );
      expect(id).toBe("42");
      expect(seen.method).toBe("GET");
    });
    it("rejects absent or ambiguous provider registrations", async () => {
      let called = false;
      const invalidOrigin = new JiraWebhookRegistrationClient({
        origin: "https://tenant.atlassian.net/base?token=bad",
        getAccessToken: async () => new TextEncoder().encode("opaque-token"),
        transport: async () => {
          called = true;
          return { status: 200, finalUrl: "", redirected: false, json: async () => ({}) };
        },
      });
      await expect(invalidOrigin.list()).rejects.toThrow("origin");
      expect(called).toBe(false);
      await expect(
        reconcileJiraWebhook(client({ values: [], isLast: false }), config),
      ).rejects.toThrow("no progress");
      let pageCalls = 0;
      const exhausting = new JiraWebhookRegistrationClient({
        origin: "https://tenant.atlassian.net",
        getAccessToken: async () => new TextEncoder().encode("opaque-token"),
        transport: async (request) => {
          pageCalls += 1;
          return {
            status: 200,
            finalUrl: request.url,
            redirected: false,
            json: async () => ({
              values: [
                {
                  id: pageCalls,
                  url: config.callbackUrl,
                  events: config.events,
                  jqlFilter: config.jqlFilter,
                  expirationDate: "2030-01-01T00:00:00Z",
                },
              ],
              isLast: false,
            }),
          };
        },
      });
      await expect(exhausting.list()).rejects.toThrow("pagination limit");
      expect(pageCalls).toBe(100);
      await expect(
        reconcileJiraWebhook(client({ values: [], isLast: true }), config),
      ).rejects.toThrow("absent");
      const item = {
        id: 1,
        url: config.callbackUrl,
        events: config.events,
        jqlFilter: config.jqlFilter,
        expirationDate: "2030-01-01T00:00:00Z",
      };
      await expect(
        reconcileJiraWebhook(client({ values: [item, { ...item, id: 2 }], isLast: true }), config),
      ).rejects.toThrow("ambiguous");
    });
    it("rejects wrong provider scope and stores no token", async () => {
      await expect(
        new JiraWebhookRegistrationService().ensure({
          db,
          ownerId: "owner-2",
          connectionId: "conn-1",
          registrationId: "bad",
          config,
          client: client({}),
          jobs: new JobStore(productionRuntime()),
        }),
      ).rejects.toThrow("scope");
      const row = await new JiraWebhookRegistrationRepository().findScoped(db, "owner-1", "conn-1");
      expect(row).toBeNull();
    });
    it("transitions due registration once and deduplicates the renewal job", async () => {
      const repo = new JiraWebhookRegistrationRepository();
      await db.withTransaction((tx) =>
        repo.upsert(tx, {
          registrationId: "registration-due",
          ownerId: "owner-1",
          connectionId: "conn-1",
          callbackUrl: config.callbackUrl,
          configDigest: JiraWebhookRegistrationClient.digest(config),
          status: "ACTIVE",
          generation: 1,
          externalRegistrationId: "42",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
          renewAfter: new Date("2020-01-01T00:00:00Z"),
        }),
      );
      const runtime = productionRuntime();
      const jobs = new JobStore(runtime);
      const service = new JiraWebhookRenewalService({
        db,
        jobs,
        registrations: repo,
        client: client({}),
        outbox: new OutboxRepository(runtime),
        now: () => new Date("2025-01-01T00:00:00Z"),
      });
      const first = await service.scheduleDue({ ownerId: "owner-1", connectionId: "conn-1" });
      const second = await service.scheduleDue({ ownerId: "owner-1", connectionId: "conn-1" });
      expect(first).toBeTruthy();
      expect(second).toBe(first);
      expect((await db.query("SELECT count(*) FROM jobs")).rows[0].count).toBe("1");
    });
    it("records worker completion and moves remote-side-effect faults to reconciliation", async () => {
      const repo = new JiraWebhookRegistrationRepository();
      await db.withTransaction((tx) =>
        repo.upsert(tx, {
          registrationId: "registration-worker",
          ownerId: "owner-1",
          connectionId: "conn-1",
          callbackUrl: config.callbackUrl,
          configDigest: JiraWebhookRegistrationClient.digest(config),
          status: "ACTIVE",
          generation: 1,
          externalRegistrationId: "42",
          expiresAt: new Date("2025-01-01T00:00:00Z"),
          renewAfter: new Date("2024-01-01T00:00:00Z"),
        }),
      );
      const runtime = productionRuntime();
      const jobs = new JobStore(runtime);
      const service = new JiraWebhookRenewalService({
        db,
        jobs,
        registrations: repo,
        client: client({ expirationDate: "2030-01-01T00:00:00Z" }),
        outbox: new OutboxRepository(runtime),
        now: () => new Date("2025-01-01T00:00:00Z"),
      });
      await service.scheduleDue({ ownerId: "owner-1", connectionId: "conn-1" });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 60_000 });
      expect(lease).not.toBeNull();
      await expect(
        service.runWorker({ lease: lease!, config, fault: "after_remote" }),
      ).rejects.toThrow("unresolved");
      const state = await db.query<{ status: string }>("SELECT status FROM jobs WHERE job_id=$1", [
        lease!.jobId,
      ]);
      expect(state.rows[0]?.status).toBe("RECONCILING");
      const intent = await db.query<{ intent_id: string }>(
        "SELECT intent_id FROM job_intents WHERE job_id=$1",
        [lease!.jobId],
      );
      expect(intent.rows).toHaveLength(1);
      const reconciler = new JiraWebhookRenewalService({
        db,
        jobs,
        registrations: repo,
        client: client({
          values: [
            {
              id: 42,
              url: config.callbackUrl,
              events: config.events,
              jqlFilter: config.jqlFilter,
              expirationDate: "2030-01-01T00:00:00Z",
            },
          ],
          isLast: true,
        }),
        outbox: new OutboxRepository(runtime),
        now: () => new Date("2025-01-01T00:00:00Z"),
      });
      await reconciler.reconcile({
        jobId: lease!.jobId,
        intentId: intent.rows[0]!.intent_id,
        attemptKey: "attempt-1",
        payload: lease!.payload as JiraWebhookRenewalJobPayload,
        config,
      });
      expect(
        (await db.query("SELECT status FROM jobs WHERE job_id=$1", [lease!.jobId])).rows[0]?.status,
      ).toBe("SUCCEEDED");
    });
    it("emits one bounded terminal alert under concurrent retry and rolls back atomically", async () => {
      const repo = new JiraWebhookRegistrationRepository();
      await db.withTransaction((tx) =>
        repo.upsert(tx, {
          registrationId: "registration-alert",
          ownerId: "owner-1",
          connectionId: "conn-1",
          callbackUrl: config.callbackUrl,
          configDigest: JiraWebhookRegistrationClient.digest(config),
          status: "RECONCILING",
          generation: 3,
          externalRegistrationId: "42",
        }),
      );
      const runtime = productionRuntime();
      const deps = {
        db,
        jobs: new JobStore(runtime),
        registrations: repo,
        client: client({}),
        outbox: new OutboxRepository(runtime),
        now: () => new Date("2025-01-01T00:00:00Z"),
      };
      const service = new JiraWebhookRenewalService(deps);
      const terminalJob = await deps.jobs.enqueue(db, {
        jobType: "jira.webhook.renewal",
        provider: "jira",
        payload: {
          registrationId: "registration-alert",
          ownerId: "owner-1",
          connectionId: "conn-1",
          generation: 3,
          operation: "renew",
          configDigest: JiraWebhookRegistrationClient.digest(config),
        },
        maxAttempts: 1,
      });
      await db.query(
        "UPDATE jobs SET status='DEAD_LETTER', attempts=max_attempts WHERE job_id=$1",
        [terminalJob.job_id],
      );
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          service.recordTerminalFailure({
            jobId: terminalJob.job_id,
            registrationId: "registration-alert",
            generation: 3,
            ownerId: "owner-1",
            connectionId: "conn-1",
            errorCode: "retry_exhausted",
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT count(*) FROM outbox WHERE event_type='jira.webhook.renewal.failed'",
          )
        ).rows[0].count,
      ).toBe("1");
      const payload = JSON.stringify(
        (
          await db.query(
            "SELECT payload FROM outbox WHERE event_type='jira.webhook.renewal.failed'",
          )
        ).rows[0],
      );
      expect(payload).not.toMatch(/url|jql|token|body|secret|response/i);
      await db.query(
        "TRUNCATE jira_webhook_registrations, outbox_dispatch, outbox RESTART IDENTITY CASCADE",
      );
      await db.withTransaction((tx) =>
        repo.upsert(tx, {
          registrationId: "registration-rollback",
          ownerId: "owner-1",
          connectionId: "conn-1",
          callbackUrl: config.callbackUrl,
          configDigest: JiraWebhookRegistrationClient.digest(config),
          status: "RECONCILING",
          generation: 1,
          externalRegistrationId: "43",
        }),
      );
      const rollbackJob = await deps.jobs.enqueue(db, {
        jobType: "jira.webhook.renewal",
        provider: "jira",
        payload: {
          registrationId: "registration-rollback",
          ownerId: "owner-1",
          connectionId: "conn-1",
          generation: 1,
          operation: "renew",
          configDigest: JiraWebhookRegistrationClient.digest(config),
        },
        maxAttempts: 1,
      });
      await db.query(
        "UPDATE jobs SET status='DEAD_LETTER', attempts=max_attempts WHERE job_id=$1",
        [rollbackJob.job_id],
      );
      const failing = new JiraWebhookRenewalService({
        ...deps,
        outbox: {
          enqueue: async () => {
            throw new Error("outbox fault");
          },
        },
      });
      await expect(
        failing.recordTerminalFailure({
          jobId: rollbackJob.job_id,
          registrationId: "registration-rollback",
          generation: 1,
          ownerId: "owner-1",
          connectionId: "conn-1",
          errorCode: "retry_exhausted",
        }),
      ).rejects.toThrow("outbox fault");
      expect(
        (
          await db.query(
            "SELECT status, terminal_alert_generation FROM jira_webhook_registrations WHERE registration_id='registration-rollback'",
          )
        ).rows[0],
      ).toEqual({ status: "RECONCILING", terminal_alert_generation: null });
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("0");
    });
  },
  available,
);
