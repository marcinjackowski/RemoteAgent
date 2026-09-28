/** Small, local-only operator boundary for the Engineering runtime. */
import { readFile, mkdir, writeFile, stat, realpath, statfs, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, dirname, basename, resolve } from "node:path";
import {
  Database,
  EngineeringControlPlaneRepository,
  EngineeringStopIngressRepository,
  EngineeringApprovalIngressRepository,
  CaseMessageRepository,
  CaseRepository,
  ConnectionRepository,
  DiscordBindingRepository,
  OwnerRepository,
  JobStore,
  migrateUp,
  resolvePoolConfig,
  productionRuntime,
  type Database as Db,
} from "@remoteagent/database";
import {
  loadEngineeringExecutionConfig,
  createEngineeringRoleModelComposition,
  createProductionEngineeringRuntimePort,
} from "./engineering-execution.js";
import { createProductionEngineeringModelRouting } from "./engineering-model-routing.js";
import { createEngineeringRoleContextReader } from "./context.js";
import { WorkerPersistence } from "./persistence.js";
import { createWorkerHandlers } from "./handlers.js";
import {
  createEngineeringDebugTransport,
  createEngineeringInvocationJournalRunner,
} from "./engineering-debug-journal.js";
import { MetricRegistry, StructuredLogger } from "@remoteagent/observability";
import { WorkspaceRepository } from "@remoteagent/database";
import {
  projectAcceptedLocalCommit,
  selectLocalCommitOperationId,
} from "./engineering-accepted-commit.js";
import { observeEngineeringLiveCommit } from "./engineering-commit-observation.js";
import { verticalSliceWorkspaceId } from "./vertical-slice-executor.js";
import { execFileSync } from "node:child_process";

export type PilotOptions = Readonly<{
  command: "run" | "status" | "stop";
  config: string;
  models?: string;
  task?: string;
  approve?: boolean;
  runDir: string;
  runId?: string;
  ownerId?: string;
}>;
export type PilotRecord = Readonly<{
  schema_version: 1;
  run_id: string;
  case_id: string;
  owner_id: string;
  database: string;
  config_path: string;
  task_path?: string;
  artifact_root: string;
  workspace_root: string;
  journal_root: string;
  created_at: string;
}>;

const SAFE = /^[a-zA-Z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function pilotDatabaseConfig(base: ReturnType<typeof resolvePoolConfig>, name: string) {
  if (!/^ra_pilot_[0-9a-f]{32}$/.test(name)) throw new Error("E_RECORD");
  if (base.connectionString) {
    const url = new URL(base.connectionString);
    url.pathname = `/${name}`;
    return { connectionString: url.toString() };
  }
  return { ...base, database: name };
}
export function parsePilotRecord(raw: unknown): PilotRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("E_RECORD");
  const v = raw as Record<string, unknown>;
  const keys = [
    "schema_version",
    "run_id",
    "case_id",
    "owner_id",
    "database",
    "config_path",
    "task_path",
    "artifact_root",
    "workspace_root",
    "journal_root",
    "created_at",
  ];
  if (
    Object.keys(v).some((k) => !keys.includes(k)) ||
    v.schema_version !== 1 ||
    typeof v.run_id !== "string" ||
    !SAFE.test(v.run_id) ||
    typeof v.case_id !== "string" ||
    !v.case_id.startsWith("case_") ||
    !UUID.test(v.case_id.slice(5)) ||
    typeof v.owner_id !== "string" ||
    !v.owner_id.startsWith("owner_") ||
    !UUID.test(v.owner_id.slice(6)) ||
    typeof v.database !== "string" ||
    !/^ra_pilot_[0-9a-f]{32}$/.test(v.database)
  )
    throw new Error("E_RECORD");
  for (const key of ["config_path", "artifact_root", "workspace_root", "journal_root"])
    if (typeof v[key] !== "string" || !isAbsolute(v[key])) throw new Error("E_RECORD");
  if (v.task_path !== undefined && (typeof v.task_path !== "string" || !isAbsolute(v.task_path)))
    throw new Error("E_RECORD");
  if (typeof v.created_at !== "string" || Number.isNaN(Date.parse(v.created_at)))
    throw new Error("E_RECORD");
  return v as PilotRecord;
}
export function parseEngineeringPilotArgs(argv: readonly string[]): PilotOptions {
  const command = argv[0];
  if (command !== "run" && command !== "status" && command !== "stop") throw new Error("E_USAGE");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const allowed = new Set([
    "config",
    "models",
    "task-file",
    "approve-local-write",
    "run-dir",
    "run-id",
    "owner-id",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error("E_USAGE");
    const eq = a.indexOf("=");
    const key = a.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.has(key) || values.has(key) || flags.has(key)) throw new Error("E_USAGE");
    if (eq >= 0) values.set(key, a.slice(eq + 1));
    else flags.add(key);
  }
  const config = values.get("config") ?? process.env.RA_ENGINEERING_CONFIG_PATH;
  const runDir = values.get("run-dir");
  if (!runDir || !isAbsolute(runDir) || (command === "run" && (!config || !isAbsolute(config))))
    throw new Error("E_USAGE");
  if (command === "run" && (values.has("run-id") || values.has("owner-id")))
    throw new Error("E_USAGE");
  if (
    command === "run" &&
    (!values.get("task-file") || !values.get("models") || !flags.has("approve-local-write"))
  )
    throw new Error("E_APPROVAL_REQUIRED");
  if (command !== "run" && !values.get("run-id")) throw new Error("E_USAGE");
  const result: PilotOptions = {
    command,
    config: config ?? "",
    runDir,
    approve: flags.has("approve-local-write"),
  };
  if (values.has("models")) (result as { models?: string }).models = values.get("models")!;
  if (values.has("task-file")) (result as { task?: string }).task = values.get("task-file")!;
  if (values.has("run-id")) (result as { runId?: string }).runId = values.get("run-id")!;
  if (values.has("owner-id")) (result as { ownerId?: string }).ownerId = values.get("owner-id")!;
  return result;
}

export async function validateEngineeringPilotConfig(path: string) {
  const config = await loadEngineeringExecutionConfig(path);
  if (config.catalog.definitions.length === 0) throw new Error("E_EMPTY_GATES");
  for (const gate of config.catalog.definitions)
    if (gate.environment_profile !== "HERMETIC" || gate.network_profile !== "DENY")
      throw new Error("E_NON_HERMETIC_GATE");
  const nodeExecutable = await realpath(process.execPath);
  if (!config.catalog.definitions.every((gate) => gate.executable === nodeExecutable))
    throw new Error("E_EXECUTABLE");
  return config;
}

async function privateRecord(path: string): Promise<PilotRecord> {
  return parsePilotRecord(JSON.parse(await readFile(path, "utf8")));
}

async function canonicalFuturePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalFuturePath(parent), basename(path));
  }
}
function containsPath(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (part !== ".." &&
      !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(part))
  );
}

export async function runEngineeringPilot(
  options: PilotOptions,
  onStarted?: (record: PilotRecord) => void,
): Promise<PilotRecord> {
  if (options.command !== "run" || !options.task || !options.approve)
    throw new Error("E_APPROVAL_REQUIRED");
  if (!options.models) throw new Error("E_MODELS");
  if (![options.config, options.models, options.task, options.runDir].every(isAbsolute))
    throw new Error("E_USAGE");
  const config = await validateEngineeringPilotConfig(options.config);
  const sourcePath = config.workspaceConfig.repositories[config.repositoryId]!.sourcePath;
  const sourceStatus = () =>
    execFileSync("git", ["-C", sourcePath, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
    }).trim();
  const sourceBaseSha = execFileSync("git", ["-C", sourcePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (sourceStatus() !== "") throw new Error("E_SOURCE_DIRTY");
  const canonicalRunDir = await canonicalFuturePath(resolve(options.runDir));
  const roots = await Promise.all(
    [
      sourcePath,
      config.workspaceConfig.workspaceRoot,
      config.baselineRoot,
      config.artifactRoot,
    ].map(canonicalFuturePath),
  );
  if (
    roots.some((root) => containsPath(root, canonicalRunDir) || containsPath(canonicalRunDir, root))
  )
    throw new Error("E_SCOPE");
  if (config.generatorCatalog && config.generatorCatalog.definitions.length > 0)
    throw new Error("E_SCOPE");
  const disk = await statfs(config.workspaceConfig.workspaceRoot);
  if (disk.bavail * disk.bsize < 1024 ** 3) throw new Error("E_RESOURCES");
  const taskPath = await realpath(options.task);
  const task = await readFile(taskPath, "utf8");
  if (task.trim().length === 0) throw new Error("E_TASK"); // retained only as an untrusted OWNER message
  await mkdir(options.runDir, { recursive: true });
  const runId = `pilot_${randomUUID()}`;
  let actualRunId = runId;
  const ownerId = `owner_${randomUUID()}`;
  const caseId = `case_${randomUUID()}`;
  const record: PilotRecord = {
    schema_version: 1,
    run_id: runId,
    case_id: caseId,
    owner_id: ownerId,
    database: `ra_pilot_${randomUUID().replaceAll("-", "")}`,
    config_path: options.config,
    task_path: taskPath,
    artifact_root: config.artifactRoot,
    workspace_root: config.workspaceConfig.workspaceRoot,
    journal_root: join(config.artifactRoot, "engineering-debug"),
    created_at: new Date().toISOString(),
  };
  const recordPath = join(options.runDir, "run.json");
  const allocationPath = join(options.runDir, "allocation.json");
  try {
    await stat(recordPath);
    throw new Error("E_DUPLICATE_RUN_DIR");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await writeFile(
    allocationPath,
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      case_id: caseId,
      owner_id: ownerId,
      database: record.database,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const failurePath = join(options.runDir, "result.json");
  const writeFailure = async (outcome = "FAILED") => {
    try {
      await stat(failurePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        await writeFile(
          failurePath,
          JSON.stringify({ outcome, run_id: actualRunId, case_id: caseId }) + "\n",
          { mode: 0o600, flag: "wx" },
        );
      else throw e;
    }
  };
  let cleanupDb: Db | undefined;
  let cleanupSignals: (() => Promise<void>) | undefined;
  const lockPath = join(config.workspaceConfig.workspaceRoot, ".engineering-pilot.lock");
  let ownsLock = false;
  try {
    try {
      await writeFile(lockPath, runId, { flag: "wx", mode: 0o600 });
      ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("E_PILOT_BUSY");
      throw error;
    }
    const base = resolvePoolConfig();
    const adminConfig = base.connectionString
      ? {
          connectionString: (() => {
            const u = new URL(base.connectionString!);
            u.pathname = "/postgres";
            return u.toString();
          })(),
        }
      : { ...base, database: "postgres" };
    const admin: Db = Database.fromEnv(adminConfig);
    try {
      await admin.query(`CREATE DATABASE "${record.database}"`);
    } finally {
      await admin.close();
    }
    const db: Db = Database.fromEnv(pilotDatabaseConfig(base, record.database));
    cleanupDb = db;
    const runtime = productionRuntime();
    const jobs = new JobStore(runtime);
    const persistence = new WorkerPersistence(db, runtime);
    await migrateUp(db);
    const ids = {
      connectionId: `pilot_${randomUUID()}`,
      channelId: `pilot_${randomUUID()}`,
      threadId: `pilot_${randomUUID()}`,
      messageId: `pilot_${randomUUID()}`,
      proposeId: `pilot_${randomUUID()}`,
      grantId: `pilot_${randomUUID()}`,
    };
    await new OwnerRepository().insert(db, { ownerId, displayName: "Engineering pilot owner" });
    await new ConnectionRepository().insert(db, {
      connectionId: ids.connectionId,
      ownerId,
      provider: "jira",
      displayName: "Engineering pilot local",
    });
    await new CaseRepository().insert(db, {
      caseId,
      ownerId,
      status: "IMPLEMENTING",
      integrationScope: { providers: ["jira"], connection_ids: [ids.connectionId] },
      discordThreadId: ids.threadId,
    });
    const bindings = new DiscordBindingRepository();
    await bindings.ensure(db, { caseId, ownerId, channelId: ids.channelId });
    await db.withTransaction((tx) =>
      bindings.setThread(tx, caseId, { threadId: ids.threadId, rootMessageId: `${runId}-root` }),
    );
    await db.withTransaction((tx) =>
      new CaseMessageRepository().append(tx, {
        messageId: ids.messageId,
        caseId,
        role: "OWNER",
        trust: "UNTRUSTED_DATA",
        body: task,
      }),
    );
    await persistence.ensureBaselineCheckpoint(caseId);
    const routing = await createProductionEngineeringModelRouting({
      configPath: options.models,
      environment: process.env,
    });
    if (routing === null) throw new Error("E_MODELS");
    const roles = createEngineeringRoleModelComposition({
      routing,
      executionConfig: config,
      decorateTransport: (binding) =>
        createEngineeringDebugTransport(binding.transport, {
          role: binding.role,
          invocation: binding.invocation,
        }),
    });
    const proposed = await new EngineeringApprovalIngressRepository({
      runtime,
      deploymentPolicy: config.writeDeploymentPolicy,
      proposalTtlMs: 1_200_000,
    }).propose(db, { caseId, actorId: ownerId, interactionId: ids.proposeId });
    if (proposed.status !== "created") throw new Error("E_PROPOSAL");
    const granted = await new EngineeringApprovalIngressRepository({
      runtime,
      deploymentPolicy: config.writeDeploymentPolicy,
      proposalTtlMs: 1_200_000,
    }).respond(db, {
      caseId,
      actorId: ownerId,
      interactionId: ids.grantId,
      proposalId: proposed.proposal.proposal_id,
      checkpointRevision: proposed.proposal.authorization_scope.checkpoint_revision,
      choice: "grant",
    });
    if (granted.status !== "granted") throw new Error("E_GRANT");
    actualRunId = granted.runId;
    const finalRecord = { ...record, run_id: granted.runId };
    await writeFile(recordPath, JSON.stringify(finalRecord) + "\n", { mode: 0o600, flag: "wx" });
    const lease = await jobs.claim(db, { owner: `${runId}-worker`, leaseMs: 1_200_000 });
    if (lease === null || lease.jobId !== granted.jobId) throw new Error("E_LEASE");
    const metrics = new MetricRegistry([]);
    const readContext = createEngineeringRoleContextReader({
      db,
      metrics,
      knownSecrets: [],
      beforeRead: (id) => persistence.ensureBaselineCheckpoint(id).then(() => undefined),
    });
    const port = createProductionEngineeringRuntimePort({
      db,
      jobs,
      lease,
      config,
      transport: roles.implementation.transport,
      modelConfig: roles.implementation.config,
      readContext,
      stageExecutor: roles.stageExecutor,
      reviewSessionFactory: roles.reviewSessionFactory.createSession,
      implementationModelInvocation: roles.implementation.invocation,
      reviewModelInvocation: roles.reviewer.invocation,
      modelPreflight: roles.modelPreflight,
      workflowDeadlineMs: 1_200_000,
      metrics,
      policy: {
        riskFacts: {
          authority: "SERVER_OWNED",
          security_or_policy: false,
          migration: false,
          irreversible_side_effect: false,
          broad_public_contract_change: false,
          multi_module: false,
          new_architecture: false,
          deterministic_oracle: true,
          user_data: false,
          concurrency: false,
          external_side_effect: false,
        },
      },
    });
    const handlers = createWorkerHandlers({
      persistence,
      roles: {},
      logger: new StructuredLogger({ knownSecrets: [], sink: { log: () => undefined } }),
      db,
      jobs,
      engineering: () => port,
      engineeringInvocation: createEngineeringInvocationJournalRunner({
        artifactRoot: config.artifactRoot,
        db,
        model: "role-routed-subscription",
        configDigest: config.configDigest,
        logger: new StructuredLogger({ knownSecrets: [], sink: { log: () => undefined } }),
      }),
    });
    let pendingStop: Promise<unknown> | null = null;
    let stopFailed = false;
    const onSignal = () => {
      pendingStop ??= new EngineeringStopIngressRepository({ runtime })
        .stop(db, { caseId, actorId: ownerId, interactionId: randomUUID() })
        .catch(() => {
          stopFailed = true;
        });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    cleanupSignals = async () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      if (pendingStop) await pendingStop;
    };
    await writeFile(
      join(options.runDir, "started.json"),
      JSON.stringify({
        outcome: "RUN_STARTED",
        run_id: granted.runId,
        case_id: caseId,
        journal_root: record.journal_root,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    onStarted?.(finalRecord);
    await handlers["agent.implementer"]!(lease, async () => {
      await jobs.heartbeat(db, lease, 1_200_000);
    });
    if (pendingStop) await pendingStop;
    if (stopFailed) throw new Error("E_STOP_FAILED");
    const afterSha = execFileSync("git", ["-C", sourcePath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    if (afterSha !== sourceBaseSha || sourceStatus() !== "") throw new Error("E_SOURCE_CHANGED");
    const rows = await new EngineeringControlPlaneRepository(runtime).listRunArtifactRevisions(db, {
      runId: granted.runId,
    });
    const operationId = selectLocalCommitOperationId(rows, {
      caseId,
      runId: granted.runId,
      jobId: lease.jobId,
    });
    const completion = await new EngineeringControlPlaneRepository(runtime).readOperationCompletion(
      db,
      { operationId },
    );
    const accepted = projectAcceptedLocalCommit({
      rows,
      completion,
      scope: { caseId, runId: granted.runId, jobId: lease.jobId },
    });
    const workspace = await new WorkspaceRepository().find(db, verticalSliceWorkspaceId(caseId));
    if (!workspace || workspace.case_id !== caseId) throw new Error("E_INCOMPLETE");
    const worktreePath = await realpath(
      join(config.workspaceConfig.workspaceRoot, caseId, workspace.workspace_id),
    );
    if (!containsPath(await realpath(config.workspaceConfig.workspaceRoot), worktreePath))
      throw new Error("E_SCOPE");
    await observeEngineeringLiveCommit(worktreePath, sourceBaseSha, accepted.commitReceipt);
    await jobs.complete(db, lease);
    await writeFile(
      join(options.runDir, "result.json"),
      JSON.stringify({
        outcome: "COMPLETED",
        run_id: granted.runId,
        case_id: caseId,
        job_id: lease.jobId,
        commit_sha: accepted.commitReceipt.commit_sha,
        worktree_path: worktreePath,
        journal_root: record.journal_root,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return finalRecord;
  } catch (error) {
    await writeFailure(
      error instanceof Error && error.message === "E_SOURCE_CHANGED" ? "BLOCKED" : "FAILED",
    );
    throw error;
  } finally {
    try {
      if (cleanupSignals) await cleanupSignals();
    } finally {
      try {
        if (cleanupDb) await cleanupDb.close();
      } finally {
        if (ownsLock) {
          if ((await readFile(lockPath, "utf8")) !== runId) throw new Error("E_LOCK_OWNERSHIP");
          await unlink(lockPath);
        }
      }
    }
  }
}

export async function engineeringPilotStatus(runDir: string, runId: string) {
  const record = await privateRecord(join(runDir, "run.json"));
  if (record.run_id !== runId) throw new Error("E_RECORD");
  const db: Db = Database.fromEnv(pilotDatabaseConfig(resolvePoolConfig(), record.database));
  const control = new EngineeringControlPlaneRepository(productionRuntime());
  try {
    const identity = await db.query<{ checkpoint_revision: number }>(
      "SELECT checkpoint_revision FROM agent_runs WHERE run_id=$1 AND case_id=$2 AND owner_id=$3",
      [runId, record.case_id, record.owner_id],
    );
    const revision = identity.rows[0]?.checkpoint_revision;
    if (revision === undefined) throw new Error("E_UNKNOWN_RUN");
    const state = await control.readRunControlState(db, {
      runId,
      caseId: record.case_id,
      ownerId: record.owner_id,
      checkpointRevision: revision,
    });
    const trace = await control.listRunTrace(db, {
      runId,
      caseId: record.case_id,
      ownerId: record.owner_id,
      checkpointRevision: revision,
    });
    const latest = trace.at(-1);
    const status = await control.readRunStatus(db, { runId, ownerId: record.owner_id });
    return {
      record,
      status: {
        run_id: runId,
        case_id: record.case_id,
        current_stage: latest?.stage ?? "STARTING",
        recovery_status:
          status !== null && status.last_event_sequence === latest?.event_sequence
            ? status.recovery_status
            : "UNPROJECTED",
        cancellation_requested: state.cancelled,
        current_artifact_revision_id: latest?.artifact_revision_id ?? null,
        updated_at: latest?.recorded_at ?? record.created_at,
      },
    };
  } finally {
    await db.close();
  }
}

export async function stopEngineeringPilot(
  runDir: string,
  runId: string,
  interactionId: string = randomUUID(),
) {
  const record = await privateRecord(join(runDir, "run.json"));
  if (record.run_id !== runId) throw new Error("E_RECORD");
  const db: Db = Database.fromEnv(pilotDatabaseConfig(resolvePoolConfig(), record.database));
  try {
    return await new EngineeringStopIngressRepository({ runtime: productionRuntime() }).stop(db, {
      caseId: record.case_id,
      actorId: record.owner_id,
      interactionId,
    });
  } finally {
    await db.close();
  }
}
