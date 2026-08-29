/**
 * `worker.js` — the process that claims jobs and does the work (RA-027-WU-03).
 *
 * WHAT THIS FILE IS AND IS NOT. It is a composition root: it opens a database, builds a
 * `Scheduler` over the existing queue machinery, and hosts it in a `ProcessRuntime`. There
 * is no new domain logic here, and there must not be — `Scheduler` already owns reaping,
 * the outbox relay and bounded retry, and `createJobDispatch` owns routing. A behaviour
 * implemented here instead of in a package would be untested by every package suite.
 *
 * THE ENV CONTRACT IS PARSED SEPARATELY FROM THE WIRING, following the convention
 * `apps/discord-bot/src/env.ts` established: `workerConfigFromEnv` can be validated with no
 * database, no secret and no network, so a composition test proves the contract without a
 * live anything.
 *
 * DRAIN IS THE INTERESTING PART. A worker holding a job lease must not be killed between
 * claiming and completing, because the effect may be half-applied. So `drain` waits for the
 * in-flight tick to finish rather than for the queue to empty — waiting for empty would
 * never return under load, and `ProcessRuntime` would abandon it at the deadline anyway.
 * The lease and the reaper make an abandoned job recoverable; what must not happen is
 * abandoning it *silently*.
 */
import {
  Database,
  JobStore,
  JobType,
  OutboxRepository,
  Scheduler,
  createJobDispatch,
  productionRuntime,
  type ClaimableDispatch,
  type JobHandler,
  type JobTypeHandlers,
  type OutboxSink,
  type SchedulerContinuationLane,
} from "@remoteagent/database";
import {
  MetricRegistry,
  ProcessRuntime,
  StructuredLogger,
  type ProcessDefinition,
} from "@remoteagent/observability";
import {
  subscriptionModelInvocationDescriptorV1,
  type RuntimeConfig,
  type RuntimeTransport,
  type SubscriptionModelInvocationDescriptorV1,
} from "@remoteagent/model-runtime";
import type { EngineeringStage } from "@remoteagent/contracts";
import {
  createCodexCliTransport,
  type CodexCliTransport,
  type CodexCliTransportOptions,
} from "@remoteagent/model-provider-codex-cli";
import {
  createClaudeCodeTransport,
  type ClaudeCodeTransport,
  type ClaudeCodeTransportOptions,
} from "@remoteagent/model-provider-claude-code";
import { JiraRestClient } from "@remoteagent/connector-jira";
import { ChannelRegistry } from "@remoteagent/discord";

import { createRenewalHandler, createWorkerHandlers } from "./handlers.js";
import { basicAuthTransport, jiraReconcileConfigFromEnv } from "./jira-auth.js";
import { createJiraReconcileRun, ensureJiraConnection } from "./jira-reconcile.js";
import { WorkerPersistence } from "./persistence.js";
import { createRoles } from "./roles.js";
import { createEngineeringRoleContextReader } from "./context.js";
import {
  createEngineeringRoleModelComposition,
  createProductionEngineeringRuntimePort,
  engineeringExecutionConfigFromEnv,
} from "./engineering-execution.js";
import { createProductionEngineeringRecoveryCoordinator } from "./engineering-recovery.js";
import {
  createEngineeringDebugTransport,
  createEngineeringInvocationJournalRunner,
} from "./engineering-debug-journal.js";
import { engineeringModelRoutingFromEnv } from "./engineering-model-routing.js";
import {
  createLegacyConversationModelBinding,
  legacyConversationKnownSecretsFromEnv,
} from "./legacy-conversation-model.js";

/**
 * Roles this worker can execute. IMPLEMENTER is included because `agent.implementer` jobs
 * route to it; it runs only under a durable writer lease, enforced by `WriterLeaseGuard`.
 */
const WORKER_ROLES = [
  "SUPERVISOR",
  "PLANNER",
  "IMPLEMENTER",
  "REVIEWER",
  "VERIFICATION",
  "SPECIALIST",
] as const;

/** Env var names, documented so a deployment knows exactly what to set. */
export const WORKER_ENV = {
  /** Health server port. Defaults to 8080, matching `infra/cdk`'s container port. */
  port: "RA_HEALTH_PORT",
  /** Scheduler poll interval in ms. */
  intervalMs: "RA_POLL_INTERVAL_MS",
  /** Worker identity recorded as the lease owner; defaults to the hostname. */
  owner: "RA_WORKER_ID",
  /** Graceful shutdown budget in ms. */
  drainMs: "RA_DRAIN_MS",
} as const;

export interface WorkerConfig {
  readonly port: number;
  readonly intervalMs: number;
  readonly owner: string;
  readonly drainMs: number;
}

export type ProductionConversationModelBinding = Readonly<{
  transport: RuntimeTransport;
  config: RuntimeConfig;
}>;

export type ProductionEngineeringSubscriptionBinding = Readonly<{
  authority: "OFFICIAL_SUBSCRIPTION_CLI";
  transport: RuntimeTransport;
  config: RuntimeConfig;
  assertReadyForInvocation: (input: {
    invocation: SubscriptionModelInvocationDescriptorV1;
    signal?: AbortSignal;
  }) => Promise<void>;
  stageInvocation: (stage: EngineeringStage) => SubscriptionModelInvocationDescriptorV1;
  implementationInvocation: SubscriptionModelInvocationDescriptorV1;
  reviewInvocation: SubscriptionModelInvocationDescriptorV1;
}>;

/**
 * Construct the Codex subscription transport without assigning it to an
 * Engineering role. Immutable per-role routing is deliberately owned by
 * RA-052; this seam only makes the qualified adapter available to composition.
 */
export function createCodexSubscriptionModelTransport(
  options: CodexCliTransportOptions,
): CodexCliTransport {
  return createCodexCliTransport(options);
}

/**
 * Construct the Claude subscription transport without assigning it to an
 * Engineering role. RA-052 owns immutable per-role provider/profile routing.
 */
export function createClaudeSubscriptionModelTransport(
  options: ClaudeCodeTransportOptions,
): ClaudeCodeTransport {
  return createClaudeCodeTransport(options);
}

/**
 * Keep the legacy conversation model and the Engineering provider on separate composition slots.
 * Missing subscription wiring is a deliberate null, never a fallback to the conversation transport.
 */
export function bindProductionModelRuntimes(input: {
  conversation: ProductionConversationModelBinding;
  subscriptionEngineering?: ProductionEngineeringSubscriptionBinding;
}): Readonly<{
  conversation: ProductionConversationModelBinding;
  engineering: ProductionEngineeringSubscriptionBinding | null;
}> {
  const engineering = input.subscriptionEngineering;
  return Object.freeze({
    conversation: input.conversation,
    engineering:
      engineering === undefined
        ? null
        : Object.freeze({
            ...engineering,
            implementationInvocation: subscriptionModelInvocationDescriptorV1.parse(
              engineering.implementationInvocation,
            ),
            reviewInvocation: subscriptionModelInvocationDescriptorV1.parse(
              engineering.reviewInvocation,
            ),
            stageInvocation: (stage: EngineeringStage) =>
              subscriptionModelInvocationDescriptorV1.parse(engineering.stageInvocation(stage)),
          }),
  });
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    // Fail closed rather than falling back. A typo in `RA_POLL_INTERVAL_MS` silently
    // reverting to the default would be a deployment that looks configured and is not.
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

/** Parse and validate the env contract. No database, no secret, no network. */
export function workerConfigFromEnv(env: Env = process.env): WorkerConfig {
  return {
    port: positiveInt(env, WORKER_ENV.port, 8080),
    intervalMs: positiveInt(env, WORKER_ENV.intervalMs, 1_000),
    // Hostname, because in ECS that is the task id — which is what an operator has when
    // they see a stale lease and need to know which task held it.
    owner: env[WORKER_ENV.owner]?.trim() || `worker-${process.pid.toString()}`,
    drainMs: positiveInt(env, WORKER_ENV.drainMs, 20_000),
  };
}

/**
 * Build the worker's process definition over an already-open database.
 *
 * `handlers` is injected rather than constructed here: the worker's job handlers need the
 * orchestrator, and wiring that inside would make this file untestable without one. The
 * deployment supplies them; a composition test supplies fakes.
 */
export function createWorkerProcess(input: {
  readonly db: Database;
  readonly config: WorkerConfig;
  readonly handlers: Parameters<typeof createJobDispatch>[0];
  readonly sink: OutboxSink;
  readonly logger?: StructuredLogger;
  readonly continuation?: SchedulerContinuationLane;
}): ProcessDefinition {
  const runtime = productionRuntime();
  const jobs = new JobStore(runtime);
  const outbox = new OutboxRepository(runtime);

  // In-flight tracking wraps the HANDLER, not `Scheduler.tick`.
  //
  // Patching `tick` was the first attempt and is wrong twice over: it reaches into another
  // package's instance, and it counts a whole pass (reap + relay + claim) as "work in
  // flight" when only the handler can leave a job half-done. Wrapping the handler puts the
  // tracking exactly where the risk is — between claiming a job and completing it.
  const inFlight = new Set<Promise<void>>();
  const dispatch = createJobDispatch(input.handlers);
  const trackedHandler: JobHandler = async (lease, heartbeat) => {
    const work = dispatch(lease, heartbeat);
    inFlight.add(work);
    try {
      await work;
    } finally {
      inFlight.delete(work);
    }
  };

  const scheduler = new Scheduler({
    db: input.db,
    jobs,
    outbox,
    clock: runtime.clock,
    sink: input.sink,
    handler: trackedHandler,
    ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    claim: { owner: input.config.owner },
    intervalMs: input.config.intervalMs,
    // The worker is a job processor, not an outbox deliverer (ADR-0009). It relays NO
    // aggregates: an empty allow-list claims nothing, so it never grabs a `discord_case` row
    // (which only the discord-bot can deliver) and dead-letters it. `input.sink` stays as a
    // fail-closed safety net that must never actually be reached on this path.
    relay: { aggregates: [] },
  });

  const responsive = true;

  return {
    name: "worker",
    start: () => {
      scheduler.start();
    },
    stopAcceptingWork: () => {
      // Stops the polling loop. A tick already running is NOT interrupted — that is what
      // `drain` is for, and interrupting mid-tick is what leaves a claimed job leaked.
      scheduler.stop();
    },
    drain: async () => {
      // Awaits handlers actually running, not an empty queue — waiting for empty would
      // never return under load, and `ProcessRuntime` would abandon it at the deadline.
      // `allSettled` because a failing handler is `Scheduler`'s business (bounded retry),
      // not a reason to abort the drain.
      await Promise.allSettled([...inFlight]);
    },
    close: async () => {
      await input.db.close();
    },
    isResponsive: () => responsive,
    isDatabaseReachable: async () => {
      try {
        await input.db.query("SELECT 1");
        return true;
      } catch {
        // Reported as unreachable, NOT as unresponsive. The distinction is the whole point
        // of the two probes: the process is fine and will recover when the database does,
        // so it must not be restarted (RA-024).
        return false;
      }
    },
  };
}

/** Everything except `main`, so a test can drive the process without spawning one. */
export function bootstrapWorker(input: {
  readonly config: WorkerConfig;
  readonly db: Database;
  readonly handlers: Parameters<typeof createJobDispatch>[0];
  readonly sink: OutboxSink;
  readonly logger?: StructuredLogger;
  readonly continuation?: SchedulerContinuationLane;
}): ProcessRuntime {
  return new ProcessRuntime(createWorkerProcess(input), {
    port: input.config.port,
    drainMs: input.config.drainMs,
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });
}

/**
 * The deployment entry point.
 *
 * RA-028 CLOSED THE SEAM THAT WAS `handlers: {}` HERE. RA-027 left the map empty on
 * purpose — every claimed job failed closed to the DLQ — because the handlers need a model
 * transport and a persistence adapter, and composing those was a separate task. Both now
 * exist, so the real handlers are built here.
 *
 * The explicitly legacy conversation transport and the test transport are both injected into
 * the SAME `createRoles`/`createWorkerHandlers` code. That is what makes a
 * handler test evidence about this process rather than about a parallel implementation.
 */
/**
 * Build the `jira.reconcile` handler from the environment (RA-030 / ADR-0010), or `{}` if Jira is
 * not configured. Single-owner API token over Basic: the client authenticates with the personal
 * token, and the run correlates each changed issue into a case + `discord_case` outbox row (which
 * the discord-bot relay then delivers). Absent `JIRA_API_TOKEN` = handler not registered, so the
 * job fails closed to the DLQ rather than being silently dropped.
 */
export async function jiraReconcileHandlers(input: {
  readonly db: Database;
  readonly runtime: ReturnType<typeof productionRuntime>;
  readonly logger: StructuredLogger;
  readonly config: ReturnType<typeof jiraReconcileConfigFromEnv>;
}): Promise<JobTypeHandlers> {
  const config = input.config;
  if (config === null) {
    input.logger.info("jira.reconcile not configured (no JIRA_API_TOKEN); handler not registered");
    return {};
  }
  // The correlator rejects an issue whose connection is missing; provision it idempotently first.
  await ensureJiraConnection({
    db: input.db,
    ownerId: config.ownerId,
    connectionId: config.connectionId,
    alias: config.alias,
    displayName: config.origin,
  });
  const client = new JiraRestClient({
    origin: config.origin,
    allowedOrigins: [config.origin],
    getAccessToken: () => Promise.resolve(new TextEncoder().encode(config.token)),
    transport: basicAuthTransport(config.email, config.token),
  });
  const run = createJiraReconcileRun({
    db: input.db,
    search: client,
    channelRegistry: new ChannelRegistry({
      guildId: config.guildId,
      ownerId: config.discordOwnerId,
      channels: config.channels,
    }),
    ids: {
      caseId: () => input.runtime.ids.next("case"),
      entityId: () => input.runtime.ids.next("entity"),
      outboxId: () => input.runtime.ids.next("outbox"),
    },
    now: () => new Date().toISOString(),
  });
  input.logger.info("jira.reconcile handler registered", {
    connection_id: config.connectionId,
    origin: config.origin,
  });
  // `createRenewalHandler` is the generic injected-handler wrapper (heartbeat, then run).
  return { [JobType.JIRA_RECONCILE]: createRenewalHandler(run) };
}

export async function main(): Promise<void> {
  const config = workerConfigFromEnv();
  const knownSecrets = [...legacyConversationKnownSecretsFromEnv()];
  const logger = new StructuredLogger({
    knownSecrets,
    sink: { log: (record) => console.log(JSON.stringify(record)) },
  });
  const db = Database.fromEnv();
  const runtime = productionRuntime();
  const metrics = new MetricRegistry(knownSecrets);
  const extra = await jiraReconcileHandlers({
    db,
    runtime,
    logger,
    config: jiraReconcileConfigFromEnv(),
  });
  const persistence = new WorkerPersistence(db, runtime);
  const jobs = new JobStore(runtime);
  const legacyConversation = await createLegacyConversationModelBinding({ db });
  const modelBindings = bindProductionModelRuntimes({
    conversation: Object.freeze({
      transport: legacyConversation.transport,
      config: legacyConversation.config,
    }),
  });
  const transport = modelBindings.conversation.transport;
  const modelConfig = modelBindings.conversation.config;
  const readContext = createEngineeringRoleContextReader({
    db,
    metrics,
    knownSecrets,
    beforeRead: async (caseId) => {
      await persistence.ensureBaselineCheckpoint(caseId);
    },
  });
  const engineeringExecutionConfig = await engineeringExecutionConfigFromEnv();
  const engineeringModelRouting =
    engineeringExecutionConfig === null ? null : await engineeringModelRoutingFromEnv();
  const engineeringModels =
    engineeringExecutionConfig === null || engineeringModelRouting === null
      ? null
      : createEngineeringRoleModelComposition({
          routing: engineeringModelRouting,
          executionConfig: engineeringExecutionConfig,
          decorateTransport: (binding) =>
            createEngineeringDebugTransport(binding.transport, {
              role: binding.role,
              invocation: binding.invocation,
            }),
        });
  const handlers = createWorkerHandlers(
    {
      persistence,
      roles: createRoles(WORKER_ROLES, {
        // The ordinary conversation binding has its own explicit legacy owner. Engineering never
        // receives this transport or its environment-derived configuration.
        transport,
        config: modelConfig,
        readContext,
        metrics,
      }),
      logger,
      db,
      jobs,
      ...(engineeringExecutionConfig === null
        ? {}
        : {
            engineeringInvocation: createEngineeringInvocationJournalRunner({
              artifactRoot: engineeringExecutionConfig.artifactRoot,
              db,
              model:
                engineeringModelRouting === null
                  ? "subscription-provider-unavailable"
                  : "role-routed-subscription",
              configDigest: engineeringExecutionConfig.configDigest,
              logger,
            }),
          }),
      engineering: (lease) => {
        if (engineeringExecutionConfig === null) {
          throw new Error(
            "engineering execution is not configured: RA_ENGINEERING_CONFIG_PATH is required",
          );
        }
        if (engineeringModels === null) {
          throw new Error(
            "engineering subscription provider is unavailable; legacy fallback is disabled",
          );
        }
        return createProductionEngineeringRuntimePort({
          db,
          lease,
          jobs,
          config: engineeringExecutionConfig,
          transport: engineeringModels.implementation.transport,
          modelConfig: engineeringModels.implementation.config,
          readContext,
          stageExecutor: engineeringModels.stageExecutor,
          reviewSessionFactory: engineeringModels.reviewSessionFactory.createSession,
          implementationModelInvocation: engineeringModels.implementation.invocation,
          reviewModelInvocation: engineeringModels.reviewer.invocation,
          modelPreflight: engineeringModels.modelPreflight,
          metrics,
          policy: {
            // Conservative deployment default. No model output can downgrade this class, and the
            // missing owner/policy grant stops before implementation until a durable grant exists.
            riskFacts: {
              authority: "SERVER_OWNED",
              security_or_policy: false,
              migration: false,
              irreversible_side_effect: false,
              broad_public_contract_change: false,
              multi_module: true,
              new_architecture: false,
              deterministic_oracle: false,
              user_data: false,
              concurrency: true,
              external_side_effect: false,
            },
          },
        });
      },
    },
    extra,
  );
  const continuation =
    engineeringExecutionConfig === null || engineeringModels === null
      ? undefined
      : createProductionEngineeringRecoveryCoordinator({
          db,
          jobs,
          owner: config.owner,
          config: engineeringExecutionConfig,
          transport: engineeringModels.implementation.transport,
          modelConfig: engineeringModels.implementation.config,
          readContext,
          stageExecutor: engineeringModels.stageExecutor,
          createReviewerSession: engineeringModels.reviewSessionFactory.createSession,
          modelPreflight: engineeringModels.modelPreflight,
        });
  const workerRuntime = bootstrapWorker({
    config,
    db,
    handlers,
    // Outbox messages this process does not own are a routing bug, not something to absorb.
    sink: async (message: ClaimableDispatch): Promise<void> => {
      throw new Error(`worker received an outbox message it cannot deliver: ${message.aggregate}`);
    },
    logger,
    ...(continuation === undefined ? {} : { continuation }),
  });
  await workerRuntime.start();
  logger.info("worker ready", {
    registered_job_types: Object.keys(handlers).length,
    known_job_types: Object.values(JobType).length,
  });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
