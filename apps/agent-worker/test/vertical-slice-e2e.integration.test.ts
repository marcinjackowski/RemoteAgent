import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalDigest,
  engineeringContextManifest,
  EngineeringStage,
  TrustLevel,
} from "@remoteagent/contracts";
import {
  createRuntimeConfig,
  type RuntimeConfig,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeTransport,
} from "@remoteagent/model-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { StructuredLogger } from "@remoteagent/observability";
import {
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { afterAll, beforeAll, expect, it } from "vitest";

import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import type { CompiledRoleContext } from "../src/context.js";
import { createStructuredPreCommitReviewSessionFactory } from "../src/engineering-workflow.js";
import {
  createConfiguredEngineeringStageExecutor,
  createProductionEngineeringRuntimePort,
  type EngineeringExecutionConfig,
} from "../src/engineering-execution.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";

const run = promisify(execFile);
const available = await ensurePostgres();
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const model = { provider: "qualification_fake", model_id: "scripted-model" } as const;

class EngineeringScriptTransport implements RuntimeTransport {
  readonly requests: RuntimeRequest[] = [];
  #planning = 0;
  #implementation = 0;
  #implementationAwaitingReport = false;
  #review = 0;
  #memory = 0;

  async converse(request: RuntimeRequest, _config: RuntimeConfig): Promise<RuntimeResponse> {
    this.requests.push(request);
    const name = request.outputSchema?.name;
    const json = (value: unknown): RuntimeResponse => ({
      model,
      content: [{ type: "json", value: value as never }],
    });
    const common = { schema_version: 1, case_id: "case-e2e", run_id: "run-e2e", revision: 0 };
    if (name === "EngineeringSystemDesign_v1") {
      return json({
        ...common,
        artifact_kind: "SystemDesign",
        boundaries: ["workspace"],
        data: ["durable artifacts"],
        api: ["stage executors"],
        integrations: ["PostgreSQL", "Git"],
        invariants: ["one supervisor"],
        architecture: "durable engineering loop",
        components: ["SupervisorRuntime", "Postgres port"],
        interfaces: ["ordered artifact rows"],
        data_flow: "slice to evidence to review",
        risks: [],
        source_digest: sha("1"),
      });
    }
    if (name === "EngineeringProgramDesign_v2") {
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "ProgramDesign",
        call_flow: ["slice one", "slice two"],
        file_tree_delta: ["src/one.ts", "src/two.ts"],
        key_types_and_signatures: ["two bounded files"],
        uncertainty_review: ["review every attempt"],
        expected_tests: ["required unit gate"],
        slice_order: ["slice-1", "slice-2"],
        slice_blueprints: ["slice-1", "slice-2"].map((sliceId) => ({
          slice_id: sliceId,
          objective: `implement ${sliceId}`,
          observable_result: `${sliceId} file exists`,
          allowed_paths: ["src"],
          test_paths: ["src"],
          gate_ids: ["unit"],
          inspection_method: "inspect durable Git evidence",
          stop_condition: "fresh review passes",
        })),
        source_digest: sha("2"),
      });
    }
    if (name === "EngineeringSliceContract_v2") {
      this.#planning += 1;
      const id = this.#planning === 1 ? "slice-1" : "slice-2";
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "SliceContract",
        slice_id: id,
        objective: `implement ${id}`,
        observable_result: `${id} file exists`,
        allowed_paths: ["src"],
        test_paths: ["src"],
        gate_ids: ["unit"],
        inspection_method: "inspect durable Git evidence",
        stop_condition: "fresh review passes",
      });
    }
    if (name === "SliceImplementationReport_v1") {
      const index = this.#implementation;
      if (!this.#implementationAwaitingReport) {
        this.#implementationAwaitingReport = true;
        const path = index === 2 ? "src/two.ts" : "src/one.ts";
        const content =
          index === 0
            ? "bad implementation\n"
            : index === 1
              ? "good implementation\n"
              : "second slice\n";
        const tool =
          index === 1
            ? {
                id: `patch-${String(index)}`,
                name: "patch",
                input: {
                  replacement_files: [
                    {
                      relative_path: path,
                      replacements: [
                        {
                          old_content: "bad implementation\n",
                          new_content: "good implementation\n",
                        },
                      ],
                    },
                  ],
                },
              }
            : {
                id: `write-${String(index)}`,
                name: "write",
                input: { relative_path: path, content },
              };
        return {
          model,
          content: [{ type: "tool-use", ...tool }],
        };
      }
      this.#implementationAwaitingReport = false;
      this.#implementation += 1;
      return json({
        schema_version: 1,
        changed_files: [index === 2 ? "src/two.ts" : "src/one.ts"],
      });
    }
    if (name === "PreCommitReviewOutput_v1") {
      const review = this.#review++;
      return json(
        review === 0
          ? {
              schema_version: 1,
              findings: [
                {
                  severity: "MEDIUM",
                  summary: "The first implementation is deliberately wrong.",
                  location: { relative_path: "src/one.ts", line: 1 },
                  evidence: "bad implementation",
                  required_fix: "Replace it with the accepted good implementation.",
                },
              ],
              lines_examined: 20,
            }
          : { schema_version: 1, findings: [], lines_examined: 20 },
      );
    }
    if (name === "EngineeringMemoryUpdate_v1") {
      this.#memory += 1;
      return json({
        ...common,
        artifact_kind: "MemoryUpdate",
        source_watermark: sha("3"),
        evidence_digests: [sha("4")],
        trust: "UNTRUSTED_DATA",
        authority: "MODEL_PROJECTION",
        completed_requirements: [`slice-${String(this.#memory)}`],
        open_issues: [],
      });
    }
    if (name === "EngineeringVerificationDecision_v1") {
      return json({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "verification-final",
        rationale: "all required gates and fresh reviews are durable",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "all-slices", status: "PASSED", evidence_digest: sha("5") },
        ],
        evidence_digest: sha("5"),
      });
    }
    throw new Error(`unexpected scripted schema ${String(name)}`);
  }
}

describeIntegration(
  "production engineering execution E2E",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let parent: string;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      parent = await mkdtemp(join(tmpdir(), "ra043-production-e2e-"));
    });

    afterAll(async () => {
      await drop();
      await rm(parent, { recursive: true, force: true });
    });

    it("corrects slice one, accepts slice two and recovers one evidence-bound local commit", async () => {
      const source = join(parent, "source");
      const workspaceRoot = join(parent, "workspaces");
      const baselineRoot = join(parent, "baselines");
      const artifactRoot = join(parent, "artifacts");
      await Promise.all(
        [source, workspaceRoot, baselineRoot, artifactRoot].map((path) => mkdir(path)),
      );
      await run("git", ["init", "--quiet", "--initial-branch=main", source]);
      await run("git", ["-C", source, "config", "user.email", "e2e@example.test"]);
      await run("git", ["-C", source, "config", "user.name", "E2E"]);
      await mkdir(join(source, "src"));
      await writeFile(join(source, "src", "base.ts"), "export const base = true;\n");
      await run("git", ["-C", source, "add", "src/base.ts"]);
      await run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
      const baseSha = (await run("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

      await new OwnerRepository().insert(db, { ownerId: "owner-e2e", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "connection-e2e",
        ownerId: "owner-e2e",
        provider: "jira",
        displayName: "jira",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-e2e",
        ownerId: "owner-e2e",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-e2e"] },
        discordThreadId: "thread-e2e",
      });
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-e2e','owner-e2e',0,$1::jsonb)",
        [JSON.stringify(makeCheckpoint("case-e2e", 0))],
      );
      const units = new WorkUnitRepository();
      await units.insert(db, {
        workUnitId: "unit-e2e",
        caseId: "case-e2e",
        role: "IMPLEMENTER",
        objective: "implement two reviewed slices",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: ["repo"],
          can_write_workspace: true,
        },
      });
      await units.claim(db, { workUnitId: "unit-e2e", runId: "run-e2e", checkpointRevision: 0 });
      const jobs = new JobStore(productionRuntime());
      await jobs.enqueue(db, {
        caseId: "case-e2e",
        jobType: "agent.implementer",
        payload: { caseId: "case-e2e", workUnitId: "unit-e2e", runId: "run-e2e" },
      });
      const lease = await jobs.claim(db, { owner: "writer-e2e", leaseMs: 300_000 });
      if (lease === null) throw new Error("expected implementer lease");
      const executable = await realpath(process.execPath);
      const catalog = await VerificationGateCatalog.create({
        definitions: [
          VerificationGateDefinition.parse({
            schema_version: 1,
            gate_id: "unit",
            gate_class: VerificationGateClass.TEST,
            executable,
            argv: ["-e", "process.exit(0)"],
            relative_cwd: "src",
            required: true,
            baseline: false,
            test_first: false,
            timeout_ms: 10_000,
            environment_profile: "HERMETIC",
            network_profile: "DENY",
            mutable_outputs: [],
          }),
        ],
        executable_allowlist: [executable],
      });
      const config: EngineeringExecutionConfig = Object.freeze({
        workspaceConfig: {
          workspaceRoot,
          repositories: { repo: { sourcePath: source, baseBranch: "main" } },
        },
        repositoryId: "repo",
        baselineRoot,
        artifactRoot,
        writePathAllowlist: Object.freeze(["src"]),
        testPathAllowlist: Object.freeze(["src"]),
        writeDeploymentPolicy: Object.freeze({
          schema_version: 1,
          purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
          repository_id: "repo",
          write_path_allowlist: Object.freeze(["src"]),
        }),
        catalog,
        configDigest: canonicalDigest({ repo: "repo", catalog: catalog.config_digest }),
      });
      const transport = new EngineeringScriptTransport();
      const modelConfig = createRuntimeConfig({
        model,
        timeoutMs: 30_000,
        toolLimits: { maxIterations: 8, maxCalls: 16 },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
      });
      const stageExecutor = createConfiguredEngineeringStageExecutor({
        transport,
        modelConfig,
        executionConfig: config,
      });
      const reviewer = createStructuredPreCommitReviewSessionFactory({
        transport,
        config: modelConfig,
      });
      const readContext = async ({
        stage = EngineeringStage.DISCOVERY,
      }: {
        stage?: EngineeringStage;
      }) => {
        const value = engineeringContextManifest.parse({
          schema_version: 1,
          artifact_kind: "ContextManifest",
          case_id: "case-e2e",
          run_id: "run-e2e",
          revision: 0,
          authority: "SERVER_OWNED",
          sources: [
            {
              source_id: `source-${stage}`,
              kind: "RAW_EVIDENCE",
              ref: `ref-${stage}`,
              revision: 0,
              observed_at: "2026-08-26T00:00:00.000Z",
              digest: sha("6"),
              trust: TrustLevel.UNTRUSTED_DATA,
              freshness: "pinned",
              inclusion_reason: "stage input",
              byte_budget: 64,
              full_artifact_ref: `artifact-${stage}`,
            },
          ],
          total_byte_budget: 1024,
        });
        return {
          packet: `context ${stage}`,
          packetBytes: 32,
          estimatedInputTokens: 8,
          cacheState: "NOT_OBSERVED",
          snapshotDigest: canonicalDigest({ stage }),
          compiled: { stage, manifest: value },
        } as CompiledRoleContext;
      };
      const persistence = new WorkerPersistence(db, productionRuntime());
      const makeEngineeringPort = (writerLease: NonNullable<typeof lease>) =>
        createProductionEngineeringRuntimePort({
          db,
          jobs,
          lease: writerLease,
          config,
          transport,
          modelConfig,
          readContext: readContext as never,
          stageExecutor,
          reviewSessionFactory: reviewer.createSession,
          policy: {
            riskFacts: {
              authority: "SERVER_OWNED",
              security_or_policy: false,
              migration: false,
              irreversible_side_effect: false,
              broad_public_contract_change: false,
              multi_module: true,
              new_architecture: false,
              deterministic_oracle: true,
              user_data: false,
              concurrency: false,
              external_side_effect: false,
            },
          },
        });
      const handler = createWorkerHandlers({
        persistence,
        roles: {},
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
        db,
        jobs,
        heartbeatIntervalMs: 60_000,
        engineering: makeEngineeringPort,
      })["agent.implementer"]!;

      await handler(lease, async () => undefined);
      const workspacePath = join(workspaceRoot, "case-e2e", verticalSliceWorkspaceId("case-e2e"));
      expect(
        (
          await run("git", ["-C", workspacePath, "rev-list", "--count", `${baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");
      expect(
        (await run("git", ["-C", source, "branch", "--format=%(refname:short)"])).stdout.trim(),
      ).toBe("main");
      const artifacts = await db.query<{
        artifact_kind: string;
        stage_attempt: number;
        slice_id: string | null;
        decision: string | null;
      }>(
        "SELECT artifact_kind, stage_attempt, payload->>'slice_id' AS slice_id, payload->>'decision' AS decision FROM engineering_artifact_revisions WHERE run_id='run-e2e' ORDER BY revision",
      );
      const implementationArtifacts = artifacts.rows.filter(
        (row) => row.artifact_kind === "SliceImplementationReceipt",
      );
      expect(implementationArtifacts.map((row) => row.stage_attempt)).toEqual([1, 2, 3]);
      expect(implementationArtifacts.map((row) => row.slice_id)).toEqual([
        "slice-1",
        "slice-1",
        "slice-2",
      ]);
      expect(
        artifacts.rows
          .filter((row) => row.artifact_kind === "ReviewDecision")
          .map((row) => row.stage_attempt),
      ).toEqual([1, 2, 3]);
      expect(
        artifacts.rows
          .filter((row) => row.artifact_kind === "ReviewDecision")
          .map((row) => row.decision),
      ).toEqual(["CHANGES_REQUIRED", "PASS", "PASS"]);
      expect(
        artifacts.rows.filter((row) => row.artifact_kind === "LocalCommitReceipt"),
      ).toHaveLength(1);
      const implementationRequests = transport.requests.filter(
        (request) => request.outputSchema?.name === "SliceImplementationReport_v1",
      );
      expect(implementationRequests).toHaveLength(6);
      const correctionRequests = implementationRequests.filter(
        (request) =>
          request.tools
            ?.map((tool) => tool.name)
            .sort()
            .join(",") === "mkdir,patch,write",
      );
      expect(correctionRequests).toHaveLength(2);
      expect(
        correctionRequests.every(
          (request) =>
            request.tools
              ?.map((tool) => tool.name)
              .sort()
              .join(",") === "mkdir,patch,write",
        ),
      ).toBe(true);
      const correctionPrompt = correctionRequests[0]?.messages
        .flatMap((message) => message.content)
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");
      expect(correctionPrompt).toContain('"relative_path":"src/one.ts"');
      const serializedPrefetch = correctionPrompt
        ?.split("Code-owned prefetched repository context: ")[1]
        ?.split("\nPrevious required-gate correction evidence:")[0];
      const prefetched = JSON.parse(serializedPrefetch ?? "[]") as Array<{
        evidence: string;
        relative_path: string;
      }>;
      expect(prefetched).toHaveLength(1);
      expect(prefetched[0]?.relative_path).toBe("src/one.ts");
      expect(JSON.parse(prefetched[0]?.evidence ?? "{}")).toMatchObject({
        complete: true,
        content: "bad implementation\n",
        relative_path: "src/one.ts",
      });
      const ordinaryImplementationRequests = implementationRequests.filter(
        (request) => !correctionRequests.includes(request),
      );
      expect(
        ordinaryImplementationRequests.every(
          (request) =>
            request.tools
              ?.map((tool) => tool.name)
              .sort()
              .join(",") === "config,mkdir,patch,read,search,tree,write",
        ),
      ).toBe(true);
      expect(
        implementationRequests.some((request) =>
          request.tools?.some((tool) => tool.name === "command"),
        ),
      ).toBe(false);
      const reviewRequests = transport.requests.filter(
        (request) => request.outputSchema?.name === "PreCommitReviewOutput_v1",
      );
      expect(reviewRequests).toHaveLength(3);
      expect(reviewRequests.every((request) => (request.tools?.length ?? 0) === 0)).toBe(true);

      const requestsBeforeRecovery = transport.requests.length;
      const durableUnit = await units.findById(db, "unit-e2e");
      if (durableUnit === null) throw new Error("expected durable work unit");
      const recoveryPort = makeEngineeringPort(lease);
      await recoveryPort.open({
        unit: { workUnit: durableUnit },
        run: { runId: "run-e2e", checkpointRevision: 0 },
      });
      expect(
        await recoveryPort.recoverStage({
          caseId: "case-e2e",
          workUnitId: "unit-e2e",
          runId: "run-e2e",
          checkpointRevision: 0,
          stage: EngineeringStage.LOCAL_COMMIT,
          attempt: 1,
        }),
      ).toMatchObject({ status: "RECOVERED" });
      expect(
        (
          await run("git", ["-C", workspacePath, "rev-list", "--count", `${baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");
      await handler(lease, async () => undefined);
      expect(
        (
          await run("git", ["-C", workspacePath, "rev-list", "--count", `${baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");
      expect(transport.requests).toHaveLength(requestsBeforeRecovery);
    });
  },
  available,
);
