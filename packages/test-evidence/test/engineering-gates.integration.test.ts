import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  EngineeringControlPlaneRepository,
  JobStore,
  ManualClock,
  OwnerRepository,
  SequentialIdGenerator,
  WorkspaceRepository,
  migrateUp,
  resolvePoolConfig,
  type JobLease,
} from "@remoteagent/database";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalArtifactStore,
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
  VerificationGateOutcome,
  VerificationGateReceipt,
  VerificationGateStatus,
  VerificationGateTarget,
  VerificationGateTier,
  TestPhase,
  createTestRunner,
  executeVerificationGate,
  executeVerificationGateBatch,
  testCommandManifest,
  type ArtifactStore,
  type VerificationGateExecutionInput,
  type VerificationGateBatchExecutionInput,
  type VerificationGatePlatformAdapter,
} from "../src/index.js";

function databaseWithName(name?: string): Database {
  const base = resolvePoolConfig();
  if ("connectionString" in base && base.connectionString !== undefined) {
    const url = new URL(base.connectionString);
    if (name !== undefined) url.pathname = `/${name}`;
    return new Database({ connectionString: url.toString() });
  }
  return new Database(
    name === undefined ? { ...base, database: "postgres" } : { ...base, database: name },
  );
}

async function postgresAvailable(): Promise<boolean> {
  const db = databaseWithName();
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await db.close();
  }
}

async function createTestDatabase(): Promise<{
  db: Database;
  drop: () => Promise<void>;
}> {
  const name = `ra_test_${randomUUID().replaceAll("-", "")}`;
  const admin = databaseWithName();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const db = databaseWithName(name);
  await migrateUp(db);
  return {
    db,
    drop: async () => {
      await db.close();
      const cleanup = databaseWithName();
      await cleanup.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [name],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
      await cleanup.close();
    },
  };
}

const available = await postgresAvailable();
const describeIntegration = available
  ? describe
  : process.env.RA_REQUIRE_POSTGRES
    ? describe
    : describe.skip;
const INITIAL_TREE_DIGEST = `sha256:${"a".repeat(64)}`;
const SCHEMA_DIGEST = canonicalDigest({
  contract: "VerificationGateReceipt",
  schema_version: 1,
});

describeIntegration("durable engineering gate executor", () => {
  let db: Database;
  let drop: () => Promise<void>;
  let root: string;
  let baselineRoot: string;
  let artifactRoot: string;
  let store: LocalArtifactStore;
  let jobs: JobStore;
  let control: EngineeringControlPlaneRepository;
  let lease: JobLease;
  let catalog: VerificationGateCatalog;
  let clock: ManualClock;
  const dirs: string[] = [];

  beforeAll(async () => {
    const created = await createTestDatabase();
    db = created.db;
    drop = created.drop;
  });

  afterAll(async () => drop());

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "engineering-gate-root-"));
    baselineRoot = await mkdtemp(join(tmpdir(), "engineering-gate-baseline-"));
    artifactRoot = await mkdtemp(join(tmpdir(), "engineering-gate-artifacts-"));
    dirs.push(root, baselineRoot, artifactRoot);
    await mkdir(join(root, "src"));
    await mkdir(join(baselineRoot, "src"));
    await writeFile(join(root, "src", "subject.txt"), "initial\n");
    await writeFile(join(baselineRoot, "src", "subject.txt"), "baseline\n");
    store = new LocalArtifactStore({ root: artifactRoot });

    await db.query(
      `TRUNCATE engineering_run_projections, engineering_stage_events,
                  engineering_artifact_revisions, engineering_operations,
                  job_reconciliations, job_completions, job_intents, job_attempts,
                  jobs, workspaces, case_checkpoints, agent_runs, case_messages,
                  cases, events, raw_events, connections, owners
         RESTART IDENTITY CASCADE`,
    );
    await new OwnerRepository().insert(db, { ownerId: "owner-gate", displayName: "owner" });
    await new ConnectionRepository().insert(db, {
      connectionId: "connection-gate",
      ownerId: "owner-gate",
      provider: "gitlab",
      displayName: "gitlab",
    });
    await new CaseRepository().insert(db, {
      caseId: "case-gate",
      ownerId: "owner-gate",
      status: "IMPLEMENTING",
      integrationScope: { providers: ["gitlab"], connection_ids: ["connection-gate"] },
      discordThreadId: "thread-gate",
    });
    await db.withTransaction((tx) =>
      new CheckpointRepository().ensureBaseline(tx, {
        caseId: "case-gate",
        updatedAt: new Date().toISOString(),
      }),
    );
    await db.query(
      `INSERT INTO agent_runs (
           run_id, case_id, owner_id, work_unit_id, role, safety_state,
           checkpoint_revision)
         VALUES ('run-gate', 'case-gate', 'owner-gate', 'wu-gate',
                 'IMPLEMENTER', 'STARTED', 0)`,
    );
    const workspaces = new WorkspaceRepository();
    const mapping = {
      workspaceId: "workspace-gate",
      caseId: "case-gate",
      repo: "git@example.com:remoteagent/repo.git",
      baseSha: "0".repeat(40),
      branchName: "ra/case-gate",
    };
    await workspaces.recordIntent(db, mapping);
    expect(await workspaces.finalizeDigest(db, mapping, INITIAL_TREE_DIGEST)).toBe(true);

    await db.query(
      `INSERT INTO jobs (
           job_id, case_id, job_type, status, payload, lease_owner,
           lease_expires_at, fencing_token, attempts, serialization_key)
         VALUES ('job-gate', 'case-gate', 'engineering', 'LEASED', '{}'::jsonb,
                 'worker-gate', now() + interval '1 hour', 1, 1, 'case-gate')`,
    );
    lease = {
      jobId: "job-gate",
      caseId: "case-gate",
      jobType: "engineering",
      payload: {},
      provider: null,
      serializationKey: "case-gate",
      attempts: 1,
      maxAttempts: 10,
      fencingToken: 1,
      leaseExpiresAtMs: Date.now() + 3_600_000,
      leaseOwner: "worker-gate",
    };
    clock = new ManualClock(Date.now());
    const runtime = { clock, ids: new SequentialIdGenerator(), leaseTime: "db" as const };
    jobs = new JobStore(runtime);
    control = new EngineeringControlPlaneRepository(runtime, jobs);

    const executable = await realpath(process.execPath);
    catalog = await gateCatalog(executable);
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function gateCatalog(
    executable: string,
    overrides: Partial<VerificationGateDefinition> = {},
  ): Promise<VerificationGateCatalog> {
    const definition = VerificationGateDefinition.parse({
      schema_version: 1,
      gate_id: "unit-gate",
      gate_class: VerificationGateClass.TEST,
      executable,
      argv: ["-e", "process.stdout.write('gate-ok')"],
      relative_cwd: "src",
      required: true,
      baseline: false,
      test_first: false,
      timeout_ms: 10_000,
      environment_profile: "HERMETIC",
      network_profile: "DENY",
      mutable_outputs: ["out"],
      ...overrides,
    });
    return VerificationGateCatalog.create({
      definitions: [definition],
      executable_allowlist: [executable],
    });
  }

  it("rejects host-path gate inputs before a hermetic command can become a late infrastructure failure", async () => {
    const executable = await realpath(process.execPath);
    expect(() =>
      VerificationGateDefinition.parse({
        schema_version: 1,
        gate_id: "host-script",
        gate_class: VerificationGateClass.TEST,
        executable,
        argv: ["/private/tmp/code-owned-gate.mjs"],
        relative_cwd: "src",
        required: true,
        baseline: false,
        test_first: false,
        timeout_ms: 10_000,
        environment_profile: "HERMETIC",
        network_profile: "DENY",
        mutable_outputs: [],
      }),
    ).toThrow(/absolute host paths/u);
    expect(() =>
      VerificationGateDefinition.parse({
        schema_version: 1,
        gate_id: "host-script-assignment",
        gate_class: VerificationGateClass.TEST,
        executable,
        argv: ["--config=/private/tmp/code-owned-gate.json"],
        relative_cwd: "src",
        required: true,
        baseline: false,
        test_first: false,
        timeout_ms: 10_000,
        environment_profile: "HERMETIC",
        network_profile: "DENY",
        mutable_outputs: [],
      }),
    ).toThrow(/absolute host paths/u);
  });

  async function catalogFrom(
    definitions: readonly Record<string, unknown>[],
  ): Promise<VerificationGateCatalog> {
    const executable = await realpath(process.execPath);
    return VerificationGateCatalog.create({
      definitions: definitions.map((definition) =>
        VerificationGateDefinition.parse({
          schema_version: 1,
          gate_id: "required-gate",
          gate_class: VerificationGateClass.TEST,
          executable,
          argv: ["-e", "process.stdout.write('ok')"],
          relative_cwd: "src",
          required: true,
          baseline: false,
          test_first: false,
          timeout_ms: 10_000,
          environment_profile: "HERMETIC",
          network_profile: "DENY",
          mutable_outputs: ["out"],
          ...definition,
        }),
      ),
      executable_allowlist: [executable],
    });
  }

  function executorInput(
    overrides: Partial<VerificationGateExecutionInput> = {},
  ): VerificationGateExecutionInput {
    return {
      db,
      jobs,
      lease,
      catalog,
      gate_id: "unit-gate",
      target: VerificationGateTarget.CURRENT,
      case_id: "case-gate",
      workspace_id: "workspace-gate",
      run_id: "run-gate",
      stage_attempt: 1,
      deadline_at: new Date(clock.now() + 600_000).toISOString(),
      authoritative_root: root,
      store,
      control_plane: control,
      now: () => clock.now(),
      ...overrides,
    };
  }

  async function batchInput(
    batchCatalog: VerificationGateCatalog,
    overrides: Partial<VerificationGateBatchExecutionInput> = {},
  ): Promise<VerificationGateBatchExecutionInput> {
    return {
      db,
      jobs,
      lease,
      catalog: batchCatalog,
      metadata: {
        case_id: "case-gate",
        workspace_id: "workspace-gate",
        run_id: "run-gate",
        revision: 0,
        current_tree_digest: await computeTreeDigest(root),
        diff_digest: `sha256:${"d".repeat(64)}`,
        context_digest: `sha256:${"e".repeat(64)}`,
        review_findings: ["reviewed exact durable evidence"],
        decisions: ["decision-gate"],
      },
      current_root: root,
      ...(batchCatalog.definitions.some((definition) => definition.required && definition.baseline)
        ? { baseline_root: baselineRoot }
        : {}),
      stage_attempt: 1,
      deadline_at: new Date(clock.now() + 600_000).toISOString(),
      store,
      control_plane: control,
      now: () => clock.now(),
      ...overrides,
    };
  }

  async function exactBinding(stageAttempt: number) {
    const treeDigest = await computeTreeDigest(root);
    const descriptor = {
      kind: "verification.gate.v1" as const,
      case_id: "case-gate",
      workspace_id: "workspace-gate",
      run_id: "run-gate",
      stage_attempt: stageAttempt,
      gate_id: "unit-gate",
      target: VerificationGateTarget.CURRENT,
      tree_digest: treeDigest,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest("unit-gate"),
    };
    const operationId = `verification-gate-${canonicalDigest(descriptor).slice(7)}`;
    const operation = await control.bindOperationIntent(db, lease, {
      operationId,
      runId: "run-gate",
      stage: "GATE_EXECUTION",
      stageAttempt,
      operationKind: "engineering.verification.gate",
      effectClass: "COMMAND",
      descriptor,
      configDigest: catalog.config_digest,
      schemaDigest: SCHEMA_DIGEST,
      deadlineAt: new Date(clock.now() + 600_000).toISOString(),
    });
    return { descriptor, operationId, operation, treeDigest };
  }

  it("executes a real process, re-reads durable evidence, and identities exact tree attempts", async () => {
    const initialCurrent = await computeTreeDigest(root);
    expect(initialCurrent).not.toBe(INITIAL_TREE_DIGEST);
    const durableRead = vi.spyOn(control, "readOperationCompletion");

    const first = await executeVerificationGate(executorInput());
    expect(first.status).toBe("RECORDED");
    if (first.status !== "RECORDED") throw new Error("expected a receipt");
    expect(first.receipt.outcome).toBe(VerificationGateOutcome.PASSED);
    expect(first.receipt.workspace_id).toBe("workspace-gate");
    expect(first.receipt.tree_digest).toBe(initialCurrent);
    expect(first.receipt.log_artifact?.digest).toBe(first.receipt.log_digest);
    expect(JSON.stringify(first.receipt.log_artifact)).not.toContain(root);
    expect(JSON.stringify(first.receipt.log_artifact)).not.toContain(artifactRoot);
    expect(durableRead).toHaveBeenCalledTimes(2);

    durableRead.mockClear();
    const replay = await executeVerificationGate(executorInput());
    expect(replay).toEqual(first);
    expect(durableRead).toHaveBeenCalledTimes(1);
    await writeFile(join(root, "src", "subject.txt"), "changed\n");
    const changed = await executeVerificationGate(executorInput());
    expect(changed.status).toBe("RECORDED");
    expect(changed.operation_id).not.toBe(first.operation_id);
    if (changed.status === "RECORDED") {
      expect(changed.receipt.tree_digest).not.toBe(first.receipt.tree_digest);
    }

    const counts = await db.query<{ started: string; completions: string; observed: string }>(
      `SELECT
           (SELECT count(*)::text FROM engineering_stage_events WHERE event_type='STARTED') AS started,
           (SELECT count(*)::text FROM job_completions) AS completions,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE event_type='COMPLETION_OBSERVED') AS observed`,
    );
    expect(counts.rows[0]).toEqual({ started: "2", completions: "2", observed: "2" });
  });

  it("returns explicit AMBIGUOUS and never replays STARTED without completion", async () => {
    const bound = await exactBinding(1);
    await control.commitOperationStarted(db, lease, { operationId: bound.operationId });
    const platformRun = vi.fn<VerificationGatePlatformAdapter["run"]>();

    const result = await executeVerificationGate(
      executorInput({ platform_adapter: { run: platformRun } }),
    );

    expect(result).toEqual({
      status: "AMBIGUOUS",
      operation_id: bound.operationId,
      receipt: null,
    });
    expect(platformRun).not.toHaveBeenCalled();
    expect((await db.query("SELECT 1 FROM job_completions")).rowCount).toBe(0);
  });

  it("keeps portable gates on the hermetic runner when a platform adapter is available", async () => {
    const platformRun = vi.fn<VerificationGatePlatformAdapter["run"]>();

    const result = await executeVerificationGate(
      executorInput({ platform_adapter: { run: platformRun } }),
    );

    expect(result.status).toBe("RECORDED");
    if (result.status !== "RECORDED") throw new Error("expected a portable receipt");
    expect(result.receipt.outcome).toBe(VerificationGateOutcome.PASSED);
    expect(platformRun).not.toHaveBeenCalled();
  });

  it("refuses to create or dispatch a missing command during receipt-only recovery", async () => {
    const platformRun = vi.fn<VerificationGatePlatformAdapter["run"]>();

    const result = await executeVerificationGate(
      executorInput({
        recovery_only: true,
        platform_adapter: { run: platformRun },
      }),
    );

    expect(result).toMatchObject({ status: "AMBIGUOUS", receipt: null });
    expect(platformRun).not.toHaveBeenCalled();
    expect((await db.query("SELECT 1 FROM engineering_operations")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM job_intents")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM job_completions")).rowCount).toBe(0);
  });

  it("observes an exact existing completion then re-reads its strict receipt", async () => {
    const bound = await exactBinding(2);
    const log = await store.put({
      artifact_id: "preexisting-log",
      scope: { case_id: "case-gate", workspace_id: "workspace-gate" },
      content: "preexisting result",
    });
    const fields = {
      case_id: "case-gate",
      workspace_id: "workspace-gate",
      run_id: "run-gate",
      operation_id: bound.operationId,
      gate_id: "unit-gate",
      target: VerificationGateTarget.CURRENT,
      tree_digest: bound.treeDigest,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest("unit-gate"),
      outcome: VerificationGateOutcome.PASSED,
      exit_code: 0,
      signal: null,
      duration_ms: 5,
      log_artifact: log,
      log_digest: log.digest,
    } as const;
    const receipt = VerificationGateReceipt.parse({
      schema_version: 1,
      receipt_id: `verification-receipt-${canonicalDigest(fields).slice(7)}`,
      ...fields,
    });
    const completionId = await jobs.recordCompletion(db, {
      intentId: bound.operation.intent_id,
      jobId: bound.operation.job_id,
      outcome: "SUCCEEDED",
      receipt,
      lease,
    });
    expect(
      (await control.readOperationCompletion(db, { operationId: bound.operationId }))
        ?.completion_observed,
    ).toBe(false);

    const result = await executeVerificationGate(executorInput({ stage_attempt: 2 }));
    expect(result).toEqual({
      status: "RECORDED",
      operation_id: bound.operationId,
      completion_id: completionId,
      receipt,
    });
    const recovered = await control.readOperationCompletion(db, {
      operationId: bound.operationId,
    });
    expect(recovered?.completion?.completion_id).toBe(completionId);
    expect(recovered?.completion_observed).toBe(true);
  });

  it("fails closed on a stale receipt swap before dispatch", async () => {
    const valid = await executeVerificationGate(executorInput());
    if (valid.status !== "RECORDED") throw new Error("expected a receipt");
    const foreign = await exactBinding(3);
    await jobs.recordCompletion(db, {
      intentId: foreign.operation.intent_id,
      jobId: foreign.operation.job_id,
      outcome: "SUCCEEDED",
      receipt: valid.receipt,
      lease,
    });
    const platformRun = vi.fn<VerificationGatePlatformAdapter["run"]>();

    await expect(
      executeVerificationGate(
        executorInput({ stage_attempt: 3, platform_adapter: { run: platformRun } }),
      ),
    ).rejects.toThrow(/receipt binding/u);
    expect(platformRun).not.toHaveBeenCalled();
  });

  it("requires an explicit adapter for nonportable profiles and never fabricates green logs", async () => {
    const executable = await realpath(process.execPath);
    const nonportable = await gateCatalog(executable, {
      environment_profile: "BUILD_TOOLCHAIN",
    });
    const result = await executeVerificationGate(executorInput({ catalog: nonportable }));
    expect(result.status).toBe("RECORDED");
    if (result.status !== "RECORDED") throw new Error("expected a receipt");
    expect(result.receipt.outcome).toBe(VerificationGateOutcome.INFRASTRUCTURE);
    expect(result.receipt.log_artifact).toBeNull();
    const recovered = await control.readOperationCompletion(db, {
      operationId: result.operation_id,
    });
    expect(recovered?.started).toBe(false);
    expect(recovered?.completion?.outcome).toBe("SUCCEEDED");

    const unavailableStore: ArtifactStore = {
      put: async () => Promise.reject(new Error("unavailable")),
      get: async () => Promise.reject(new Error("unavailable")),
      has: async () => false,
    };
    const missingLog = await executeVerificationGate(
      executorInput({ store: unavailableStore, stage_attempt: 2 }),
    );
    expect(missingLog.status).toBe("RECORDED");
    if (missingLog.status === "RECORDED") {
      expect(missingLog.receipt.outcome).toBe(VerificationGateOutcome.INFRASTRUCTURE);
      expect(missingLog.receipt.exit_code).toBe(0);
      expect(missingLog.receipt.log_artifact).toBeNull();
    }

    const platformAdapter: VerificationGatePlatformAdapter = {
      run: async ({ definition, disposable_root, scope, store: adapterStore, signal }) => {
        const manifest = testCommandManifest.parse({
          schema_version: 1,
          manifest_id: `verification-${definition.gate_id}`,
          digest: canonicalDigest({ definition }),
          entries: [
            {
              name: definition.gate_id,
              phase: TestPhase.UNIT,
              executable: definition.executable,
              argv: definition.argv,
              relative_cwd: definition.relative_cwd,
              timeout_ms: definition.timeout_ms,
              required: true,
            },
          ],
        });
        const runner = await createTestRunner({
          root: disposable_root,
          scope,
          manifest,
          store: adapterStore,
          network: "DENY",
        });
        return runner.run({
          command_name: definition.gate_id,
          ...(signal === undefined ? {} : { signal }),
        });
      },
    };
    const adapted = await executeVerificationGate(
      executorInput({
        catalog: nonportable,
        stage_attempt: 3,
        platform_adapter: platformAdapter,
      }),
    );
    expect(adapted.status).toBe("RECORDED");
    if (adapted.status === "RECORDED") {
      expect(adapted.receipt.outcome).toBe(VerificationGateOutcome.PASSED);
    }

    const foreignAdapter: VerificationGatePlatformAdapter = {
      run: async (adapterInput) => {
        const valid = await platformAdapter.run(adapterInput);
        const scope = { case_id: "case-foreign", workspace_id: "workspace-foreign" };
        return {
          ...valid,
          scope,
          receipt_digest: canonicalDigest({
            run_id: valid.run_id,
            scope,
            command_name: valid.command_name,
            phase: valid.phase,
            manifest_digest: valid.manifest_digest,
            outcome: valid.outcome,
            exit_code: valid.exit_code,
            signal: valid.signal,
            tree_digest_before: valid.tree_digest_before,
            tree_digest_after: valid.tree_digest_after,
            artifact_digest: valid.artifact?.digest ?? null,
          }),
        };
      },
    };
    const boundaryErrors = vi.fn();
    const foreignRun = await executeVerificationGate(
      executorInput({
        catalog: nonportable,
        stage_attempt: 4,
        platform_adapter: foreignAdapter,
        boundary_error_observer: boundaryErrors,
      }),
    );
    expect(foreignRun.status).toBe("RECORDED");
    if (foreignRun.status === "RECORDED") {
      expect(foreignRun.receipt.outcome).toBe(VerificationGateOutcome.INFRASTRUCTURE);
      expect(foreignRun.receipt.log_artifact).toBeNull();
    }
    expect(boundaryErrors).toHaveBeenLastCalledWith(
      expect.objectContaining({
        gate_id: "unit-gate",
        target: "CURRENT",
        phase: "RECEIPT_VALIDATION",
        error: expect.any(Error),
      }),
    );

    const invalidDigestRun = await executeVerificationGate(
      executorInput({
        catalog: nonportable,
        stage_attempt: 5,
        platform_adapter: {
          run: async (adapterInput) => ({
            ...(await platformAdapter.run(adapterInput)),
            receipt_digest: `sha256:${"f".repeat(64)}`,
          }),
        },
        boundary_error_observer: boundaryErrors,
      }),
    );
    expect(invalidDigestRun.status).toBe("RECORDED");
    if (invalidDigestRun.status === "RECORDED") {
      expect(invalidDigestRun.receipt.outcome).toBe(VerificationGateOutcome.INFRASTRUCTURE);
    }
    expect(boundaryErrors).toHaveBeenCalledTimes(2);
  });

  it("durably maps a disposable write-boundary violation to INFRASTRUCTURE", async () => {
    const executable = await realpath(process.execPath);
    const writesProtected = await gateCatalog(executable, {
      argv: ["-e", "require('node:fs').writeFileSync('forbidden.txt','must-not-survive')"],
    });
    const result = await executeVerificationGate(executorInput({ catalog: writesProtected }));
    expect(result.status).toBe("RECORDED");
    if (result.status !== "RECORDED") throw new Error("expected a receipt");
    expect(result.receipt.outcome).toBe(VerificationGateOutcome.INFRASTRUCTURE);
    expect(result.receipt.exit_code).toBe(0);
    expect(result.receipt.log_artifact).not.toBeNull();
  });

  it("runs required gates in catalog order with baseline first and derives a server-owned bundle", async () => {
    const canary = join(tmpdir(), `ra-gate-optional-${randomUUID()}`);
    dirs.push(canary);
    const batchCatalog = await catalogFrom([
      {
        gate_id: "a-test-first",
        baseline: true,
        test_first: true,
        argv: [
          "-e",
          "const f=require('node:fs');process.exit(f.readFileSync('subject.txt','utf8')==='initial\\n'?0:7)",
        ],
      },
      {
        gate_id: "b-current",
        argv: ["-e", "process.stdout.write(process.argv[1])", `literal;touch ${canary}`],
      },
      {
        gate_id: "z-optional-model-cannot-select",
        required: false,
        argv: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1],'should-not-run')",
          "optional-should-not-run",
        ],
      },
    ]);

    const result = await executeVerificationGateBatch(await batchInput(batchCatalog));
    expect(result.status).toBe("COMPLETE");
    if (result.status !== "COMPLETE") throw new Error("expected a complete batch");
    expect(result.aggregate.status).toBe(VerificationGateStatus.PASSED);
    expect(result.bundle).not.toBeNull();
    expect(result.bundle?.authority).toBe("SERVER_OWNED");
    expect(result.bundle?.tree_digest).toBe(await computeTreeDigest(root));
    expect(result.bundle?.config_digests).toEqual([batchCatalog.config_digest]);
    expect(result.bundle?.test_first_evidence).toHaveLength(1);
    expect(result.bundle?.test_first_evidence[0]).toMatchObject({
      gate_id: "a-test-first",
      baseline_outcome: "FAILED",
      current_outcome: "PASSED",
    });
    expect(result.bundle?.items.every((item) => item.trust === "UNTRUSTED_DATA")).toBe(true);
    expect(JSON.stringify(result.bundle?.items)).not.toContain(root);
    expect(JSON.stringify(result.bundle?.items)).not.toContain(artifactRoot);
    await expect(access(canary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "src", "optional-should-not-run"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const ordered = await db.query<{ gate_id: string; target: string }>(
      `SELECT i.descriptor->>'gate_id' AS gate_id,
              i.descriptor->>'target' AS target
         FROM engineering_stage_events e
         JOIN engineering_operations o ON o.operation_id=e.operation_id
         JOIN job_intents i ON i.intent_id=o.intent_id
        WHERE e.event_type='INTENT_BOUND'
        ORDER BY e.event_sequence`,
    );
    expect(ordered.rows).toEqual([
      { gate_id: "a-test-first", target: "BASELINE" },
      { gate_id: "a-test-first", target: "CURRENT" },
      { gate_id: "b-current", target: "CURRENT" },
    ]);

    const durable = await db.query<{
      completion_id: string;
      payload_id: string;
      artifact_id: string;
    }>(
      `SELECT completion_id, receipt->>'receipt_id' AS payload_id,
              receipt->'log_artifact'->>'artifact_id' AS artifact_id
         FROM job_completions ORDER BY completion_id`,
    );
    const completionIds = durable.rows.map((row) => row.completion_id).sort();
    const payloadIds = durable.rows.map((row) => row.payload_id);
    expect(result.bundle?.command_receipts).toEqual(completionIds);
    expect(result.bundle?.command_receipts.some((id) => payloadIds.includes(id))).toBe(false);
    expect(new Set(durable.rows.map((row) => row.artifact_id)).size).toBe(3);
    expect(
      result.bundle?.test_first_evidence[0]?.receipt_ids.every((id) => completionIds.includes(id)),
    ).toBe(true);
  });

  it("binds explicit tier and schedule into catalog and command digests with deterministic defaults", async () => {
    const implicit = await catalogFrom([{ gate_id: "tiered" }]);
    const explicitFull = await catalogFrom([
      { gate_id: "tiered", gate_tier: VerificationGateTier.FULL },
    ]);
    const fast = await catalogFrom([{ gate_id: "tiered", gate_tier: VerificationGateTier.FAST }]);
    const firstSlice = await catalogFrom([{ gate_id: "tiered", gate_schedule: "FIRST_SLICE" }]);
    const withRequiredTest = await catalogFrom([
      { gate_id: "tiered", required_test_paths: ["tests/feature.test.ts"] },
    ]);
    const withRequiredMutation = await catalogFrom([
      { gate_id: "tiered", required_mutation_paths: ["src/feature.ts"] },
    ]);

    expect(implicit.definitions[0]?.gate_tier).toBe(VerificationGateTier.FULL);
    expect(implicit.definitions[0]?.execution_order).toBe(1_000);
    expect(implicit.config_digest).toBe(explicitFull.config_digest);
    expect(implicit.commandDigest("tiered")).toBe(explicitFull.commandDigest("tiered"));
    expect(fast.config_digest).not.toBe(explicitFull.config_digest);
    expect(fast.commandDigest("tiered")).not.toBe(explicitFull.commandDigest("tiered"));
    expect(implicit.definitions[0]?.gate_schedule).toBe("EACH_SLICE");
    expect(implicit.definitions[0]?.required_test_paths).toEqual([]);
    expect(implicit.definitions[0]?.required_mutation_paths).toEqual([]);
    expect(withRequiredTest.definitions[0]?.required_test_paths).toEqual(["tests/feature.test.ts"]);
    expect(Object.isFrozen(withRequiredTest.definitions[0]?.required_test_paths)).toBe(true);
    expect(withRequiredMutation.definitions[0]?.required_mutation_paths).toEqual([
      "src/feature.ts",
    ]);
    expect(Object.isFrozen(withRequiredMutation.definitions[0]?.required_mutation_paths)).toBe(
      true,
    );
    expect(withRequiredTest.config_digest).not.toBe(implicit.config_digest);
    expect(withRequiredTest.commandDigest("tiered")).toBe(implicit.commandDigest("tiered"));
    expect(withRequiredMutation.config_digest).not.toBe(implicit.config_digest);
    expect(withRequiredMutation.commandDigest("tiered")).toBe(implicit.commandDigest("tiered"));
    expect(firstSlice.config_digest).not.toBe(explicitFull.config_digest);
    expect(firstSlice.commandDigest("tiered")).not.toBe(explicitFull.commandDigest("tiered"));
    await expect(
      catalogFrom([
        {
          gate_id: "duplicate-tests",
          required_test_paths: ["tests/feature.test.ts", "tests/feature.test.ts"],
        },
      ]),
    ).rejects.toThrow(/required test paths must be unique/u);
    await expect(
      catalogFrom([
        {
          gate_id: "duplicate-mutations",
          required_mutation_paths: ["src/feature.ts", "src/feature.ts"],
        },
      ]),
    ).rejects.toThrow(/required mutation paths must be unique/u);
  });

  it("runs a cheaper FAST preflight before an expensive FAST test by code-owned order", async () => {
    const ordered = await catalogFrom([
      {
        gate_id: "a-expensive-test",
        gate_tier: VerificationGateTier.FAST,
        execution_order: 200,
      },
      {
        gate_id: "z-compile-preflight",
        gate_tier: VerificationGateTier.FAST,
        execution_order: 100,
      },
    ]);

    expect(ordered.definitions.map((gate) => gate.gate_id)).toEqual([
      "z-compile-preflight",
      "a-expensive-test",
    ]);
    expect(ordered.config_digest).not.toBe(
      (
        await catalogFrom([
          {
            gate_id: "a-expensive-test",
            gate_tier: VerificationGateTier.FAST,
            execution_order: 100,
          },
          {
            gate_id: "z-compile-preflight",
            gate_tier: VerificationGateTier.FAST,
            execution_order: 200,
          },
        ])
      ).config_digest,
    );
  });

  it("finishes both targets of a failed FAST test-first gate and blocks lexical-first FULL", async () => {
    const batchCatalog = await catalogFrom([
      {
        gate_id: "a-full-must-not-run",
        gate_tier: VerificationGateTier.FULL,
        argv: ["-e", "process.stdout.write('full')"],
      },
      {
        gate_id: "z-fast-first",
        gate_tier: VerificationGateTier.FAST,
        baseline: true,
        test_first: true,
        argv: ["-e", "process.stdout.write('fast');process.exit(7)"],
      },
    ]);

    expect(batchCatalog.definitions.map((gate) => gate.gate_id)).toEqual([
      "z-fast-first",
      "a-full-must-not-run",
    ]);
    const result = await executeVerificationGateBatch(await batchInput(batchCatalog));
    expect(result).toEqual({
      status: "INCOMPLETE",
      aggregate: null,
      bundle: null,
      reason: "FAST_GATE_BLOCKED_FULL",
      blocking_gate_ids: ["z-fast-first"],
      receipts: expect.any(Array),
    });
    const receipts = await db.query<{ gate_id: string; target: string; outcome: string }>(
      `SELECT receipt->>'gate_id' AS gate_id,
              receipt->>'target' AS target,
              receipt->>'outcome' AS outcome
         FROM job_completions ORDER BY receipt->>'target'`,
    );
    expect(receipts.rows).toEqual([
      {
        gate_id: "z-fast-first",
        target: VerificationGateTarget.BASELINE,
        outcome: VerificationGateOutcome.FAILED,
      },
      {
        gate_id: "z-fast-first",
        target: VerificationGateTarget.CURRENT,
        outcome: VerificationGateOutcome.FAILED,
      },
    ]);
  });

  it("keeps a missing FAST recovery receipt AMBIGUOUS without dispatching either tier", async () => {
    const batchCatalog = await catalogFrom([
      { gate_id: "z-fast", gate_tier: VerificationGateTier.FAST },
      { gate_id: "a-full", gate_tier: VerificationGateTier.FULL },
    ]);
    const result = await executeVerificationGateBatch(
      await batchInput(batchCatalog, { recovery_only: true }),
    );

    expect(result).toEqual({
      status: "INCOMPLETE",
      aggregate: null,
      bundle: null,
      reason: "AMBIGUOUS",
      blocking_gate_ids: ["z-fast"],
      receipts: [],
    });
    expect((await db.query("SELECT 1 FROM job_intents")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM job_completions")).rowCount).toBe(0);
  });

  it("runs all passing FAST gates before FULL regardless of lexical gate IDs", async () => {
    const batchCatalog = await catalogFrom([
      {
        gate_id: "a-full",
        gate_tier: VerificationGateTier.FULL,
        argv: ["-e", "process.stdout.write('full')"],
      },
      {
        gate_id: "z-fast",
        gate_tier: VerificationGateTier.FAST,
        argv: ["-e", "process.stdout.write('fast')"],
      },
    ]);

    const result = await executeVerificationGateBatch(await batchInput(batchCatalog));
    expect(result.status).toBe("COMPLETE");
    if (result.status !== "COMPLETE") throw new Error("expected complete tiered gates");
    expect(result.aggregate.status).toBe(VerificationGateStatus.PASSED);
    expect(result.bundle).not.toBeNull();
    expect(batchCatalog.definitions.map((gate) => gate.gate_id)).toEqual(["z-fast", "a-full"]);
    const invocations = await db.query<{ gate_id: string }>(
      `SELECT i.descriptor->>'gate_id' AS gate_id
         FROM engineering_stage_events e
         JOIN engineering_operations o ON o.operation_id=e.operation_id
         JOIN job_intents i ON i.intent_id=o.intent_id
        WHERE e.event_type='INTENT_BOUND'
        ORDER BY e.event_sequence`,
    );
    expect(invocations.rows).toEqual([{ gate_id: "z-fast" }, { gate_id: "a-full" }]);
  });

  it("rejects vacuous baseline green and never mints an EvidenceBundle", async () => {
    const batchCatalog = await catalogFrom([
      {
        gate_id: "test-first-green-baseline",
        baseline: true,
        test_first: true,
      },
    ]);
    const result = await executeVerificationGateBatch(await batchInput(batchCatalog));
    expect(result.status).toBe("COMPLETE");
    if (result.status !== "COMPLETE") throw new Error("expected a complete batch");
    expect(result.aggregate.status).toBe(VerificationGateStatus.FAILED);
    expect(result.aggregate.blocking_gate_ids).toEqual(["test-first-green-baseline"]);
    expect(result.bundle).toBeNull();
  });

  it("stops on an ambiguous durable operation without replay or synthetic receipt", async () => {
    const bound = await exactBinding(1);
    await control.commitOperationStarted(db, lease, { operationId: bound.operationId });
    const result = await executeVerificationGateBatch(await batchInput(catalog));
    expect(result).toEqual({
      status: "INCOMPLETE",
      aggregate: null,
      bundle: null,
      reason: "AMBIGUOUS",
      blocking_gate_ids: ["unit-gate"],
      receipts: [],
    });
    expect((await db.query("SELECT 1 FROM job_completions")).rowCount).toBe(0);
  });

  it("fails closed when the exact durable completion disappears from the reread", async () => {
    const durableRead = vi.spyOn(control, "readOperationCompletion");
    durableRead.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(executeVerificationGateBatch(await batchInput(catalog))).rejects.toThrow(
      /completion disappeared/u,
    );
    expect((await db.query("SELECT 1 FROM job_completions")).rowCount).toBe(1);
  });

  it("rejects stale trees, foreign workspace scope, and model-supplied policy fields", async () => {
    const stale = await batchInput(catalog);
    await expect(
      executeVerificationGateBatch({
        ...stale,
        metadata: {
          ...(stale.metadata as Record<string, unknown>),
          current_tree_digest: `sha256:${"f".repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/current tree/u);

    const foreign = await batchInput(catalog);
    await expect(
      executeVerificationGateBatch({
        ...foreign,
        metadata: {
          ...(foreign.metadata as Record<string, unknown>),
          workspace_id: "workspace-foreign",
        },
      }),
    ).rejects.toThrow(/workspace/u);

    const injected = await batchInput(catalog);
    await expect(
      executeVerificationGateBatch({
        ...injected,
        metadata: {
          ...(injected.metadata as Record<string, unknown>),
          authority: "MODEL_OWNED",
          gate_definitions: [{ gate_id: "invented" }],
          command_receipts: ["invented"],
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps protected writes and timeouts inconclusive with no bundle", async () => {
    const protectedCatalog = await catalogFrom([
      {
        gate_id: "protected-write",
        argv: ["-e", "require('node:fs').writeFileSync('forbidden.txt','blocked')"],
      },
    ]);
    const protectedResult = await executeVerificationGateBatch(await batchInput(protectedCatalog));
    expect(protectedResult.status).toBe("COMPLETE");
    if (protectedResult.status !== "COMPLETE") throw new Error("expected complete evidence");
    expect(protectedResult.aggregate.status).toBe(VerificationGateStatus.INCONCLUSIVE);
    expect(protectedResult.bundle).toBeNull();

    const timeoutCatalog = await catalogFrom([
      {
        gate_id: "timeout-gate",
        argv: ["-e", "setTimeout(()=>{}, 10_000)"],
        timeout_ms: 20,
      },
    ]);
    const timeoutResult = await executeVerificationGateBatch(
      await batchInput(timeoutCatalog, { stage_attempt: 2 }),
    );
    expect(timeoutResult.status).toBe("COMPLETE");
    if (timeoutResult.status !== "COMPLETE") throw new Error("expected complete evidence");
    expect(timeoutResult.aggregate.status).toBe(VerificationGateStatus.INCONCLUSIVE);
    expect(timeoutResult.bundle).toBeNull();
    const timeoutReceipt = await db.query<{ outcome: string }>(
      `SELECT receipt->>'outcome' AS outcome FROM job_completions
        WHERE receipt->>'gate_id'='timeout-gate'`,
    );
    expect(timeoutReceipt.rows).toEqual([{ outcome: VerificationGateOutcome.TIMED_OUT }]);
  });

  it("records cancellation distinctly, stops the batch, and never emits a bundle", async () => {
    const first = await catalogFrom([
      {
        gate_id: "a-cancelled",
        argv: ["-e", "setInterval(()=>{},1000)"],
      },
      { gate_id: "b-must-not-run" },
    ]);
    const controller = new AbortController();
    const running = executeVerificationGateBatch(
      await batchInput(first, { signal: controller.signal }),
    );
    const deadline = Date.now() + 2_000;
    while (true) {
      const started = await db.query(
        `SELECT 1
           FROM engineering_stage_events e
           JOIN engineering_operations o ON o.operation_id=e.operation_id
           JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE e.event_type='STARTED'
            AND i.descriptor->>'gate_id'='a-cancelled'`,
      );
      if ((started.rowCount ?? 0) > 0) break;
      if (Date.now() >= deadline) throw new Error("active gate did not reach durable STARTED");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    const result = await running;
    expect(result).toEqual({
      status: "INCOMPLETE",
      aggregate: null,
      bundle: null,
      reason: "CANCELLED",
      blocking_gate_ids: ["a-cancelled"],
      receipts: expect.any(Array),
    });
    const receipts = await db.query<{ gate_id: string; outcome: string }>(
      `SELECT receipt->>'gate_id' AS gate_id, receipt->>'outcome' AS outcome
         FROM job_completions ORDER BY completion_id`,
    );
    expect(receipts.rows).toEqual([
      { gate_id: "a-cancelled", outcome: VerificationGateOutcome.CANCELLED },
    ]);
  });

  it("rejects foreign or inactive server-owned workspace bindings", async () => {
    await expect(
      executeVerificationGate(executorInput({ case_id: "case-foreign" })),
    ).rejects.toThrow(/workspace|lease/u);
    await db.query("UPDATE workspaces SET status='ARCHIVED' WHERE workspace_id='workspace-gate'");
    await expect(executeVerificationGate(executorInput())).rejects.toThrow(/workspace/u);
  });
});
