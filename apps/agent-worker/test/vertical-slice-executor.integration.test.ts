import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest, engineeringSliceContract } from "@remoteagent/contracts";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { TOOLSET_PATH_OUTSIDE_ALLOWED, ToolOutcome } from "@remoteagent/implementation-tools";
import {
  BaselineWorkspaceStore,
  LocalArtifactStore,
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { WorkspaceFencingError } from "@remoteagent/workspace-runner";
import { ReviewSeverity, preCommitReviewOutput } from "@remoteagent/review-loop";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import {
  buildEvidenceBoundCommitDescriptor,
  executeEvidenceBoundLocalCommit,
  executeVerticalSlice,
  executeVerticalSliceGates,
  executeVerticalSliceReview,
  recoverEvidenceBoundLocalCommit,
  verticalSliceWorkspaceId,
  type VerticalSliceWriterFence,
} from "../src/vertical-slice-executor.js";

const run = promisify(execFile);
const available = await ensurePostgres();

describeIntegration(
  "server-owned vertical slice executor",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let parent: string;
    let source: string;
    let workspaceRoot: string;
    let baseSha: string;
    const caseId = "case-vslice";

    const slice = engineeringSliceContract.parse({
      schema_version: 1,
      artifact_kind: "SliceContract",
      case_id: caseId,
      run_id: "run-vslice",
      revision: 0,
      slice_id: "slice-one",
      objective: "write the bounded result",
      observable_result: "the bounded files exist",
      allowed_paths: ["src", "docs/README.md"],
      gate_ids: ["unit"],
      inspection_method: "inspect the workspace bytes",
      stop_condition: "all bounded bytes are present",
    });

    type Authority = { owner: string; token: number; enabled: boolean; inImplementation: boolean };
    const writer = (authority: Authority, owner = authority.owner, token = authority.token) =>
      ({
        caseId,
        leaseOwner: owner,
        fencingToken: token,
        assertCurrent: async () => {
          if (!authority.enabled || authority.owner !== owner || authority.token !== token) {
            throw new Error("stale writer");
          }
        },
      }) satisfies VerticalSliceWriterFence;

    const config = () => ({
      workspaceRoot,
      repositories: { repo: { sourcePath: source, baseBranch: "main" } },
    });

    async function catalog(
      options: { fail?: boolean; baseline?: boolean } = {},
    ): Promise<VerificationGateCatalog> {
      const executable = await realpath(process.execPath);
      return VerificationGateCatalog.create({
        definitions: [
          VerificationGateDefinition.parse({
            schema_version: 1,
            gate_id: "unit",
            gate_class: VerificationGateClass.TEST,
            executable,
            argv: ["-e", `process.exit(${options.fail === true ? "7" : "0"})`],
            relative_cwd: "src",
            required: true,
            baseline: options.baseline ?? true,
            test_first: false,
            timeout_ms: 10_000,
            environment_profile: "HERMETIC",
            network_profile: "DENY",
            mutable_outputs: [],
          }),
        ],
        executable_allowlist: [executable],
      });
    }

    async function gateLease() {
      const jobs = new JobStore(productionRuntime());
      await jobs.enqueue(db, {
        caseId,
        jobType: "agent.implementer",
        payload: { caseId, workUnitId: "wu-vslice", runId: "run-vslice" },
      });
      const lease = await jobs.claim(db, { owner: "writer-a", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected gate job lease");
      return { jobs, lease };
    }

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      parent = await mkdtemp(join(tmpdir(), "ra043-vslice-"));
      source = join(parent, "source");
      workspaceRoot = join(parent, "workspaces");
      await mkdir(source);
      await mkdir(workspaceRoot);
      await run("git", ["init", "--quiet", "--initial-branch=main", source]);
      await run("git", ["-C", source, "config", "user.email", "slice@example.test"]);
      await run("git", ["-C", source, "config", "user.name", "Slice Test"]);
      await mkdir(join(source, "src"));
      await mkdir(join(source, "docs"));
      await writeFile(join(source, "src", "base.ts"), "export const base = true;\n");
      await writeFile(join(source, "docs", "README.md"), "base\n");
      await run("git", ["-C", source, "add", "--all"]);
      await run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
      baseSha = (await run("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

      await db.query(`TRUNCATE engineering_run_projections, engineering_stage_events,
        engineering_artifact_revisions, engineering_operations, implementation_tool_operations,
        job_reconciliations, job_completions, job_intents, job_attempts, jobs, workspaces,
        case_checkpoints, agent_runs, work_units, case_connections, cases, connections, owners
        RESTART IDENTITY CASCADE`);
      await new OwnerRepository().insert(db, { ownerId: "owner-vslice", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-vslice",
        ownerId: "owner-vslice",
        provider: "gitlab",
        alias: "private",
        displayName: "git",
      });
      await new CaseRepository().insert(db, {
        caseId,
        ownerId: "owner-vslice",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["gitlab"], connection_ids: ["conn-vslice"] },
        discordThreadId: "thread-vslice",
      });
      await db.withTransaction((tx) =>
        new CheckpointRepository().ensureBaseline(tx, {
          caseId,
          updatedAt: new Date().toISOString(),
        }),
      );
      const units = new WorkUnitRepository();
      await units.insert(db, {
        workUnitId: "wu-vslice",
        caseId,
        role: "IMPLEMENTER",
        objective: "execute bounded vertical slices",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: ["repo"],
          can_write_workspace: true,
        },
      });
      await units.claim(db, {
        workUnitId: "wu-vslice",
        runId: "run-vslice",
        checkpointRevision: 0,
      });
    });

    afterEach(async () => rm(parent, { recursive: true, force: true }));

    it("creates then recovers one deterministic workspace and exposes no command capability", async () => {
      const authority: Authority = {
        owner: "writer-a",
        token: 7,
        enabled: true,
        inImplementation: false,
      };
      const first = await executeVerticalSlice({
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writer(authority),
        slice,
        attempt: 1,
        implement: async (tools) => {
          expect(Object.keys(tools).sort()).toEqual(
            ["config", "mkdir", "patch", "read", "search", "tree", "write"].sort(),
          );
          expect("command" in tools).toBe(false);
          expect("identity" in tools).toBe(false);
          await expect(
            tools.write({
              relative_path: "src/caller.ts",
              content: "caller\n",
              operation_id: "caller-controlled",
            } as never),
          ).rejects.toThrow();

          const exact = await tools.write({
            relative_path: "docs/README.md",
            content: "exact root\n",
          });
          const child = await tools.write({
            relative_path: "src/child.ts",
            content: "export const child = true;\n",
          });
          const sibling = await tools.write({
            relative_path: "src-other/escape.ts",
            content: "escape\n",
          });
          expect(exact.outcome).toBe(ToolOutcome.SUCCEEDED);
          expect(child.outcome).toBe(ToolOutcome.SUCCEEDED);
          expect(sibling.outcome).toBe(ToolOutcome.FAILED);
          if (sibling.outcome !== ToolOutcome.FAILED) throw new Error("expected refusal");
          expect(sibling.failure_code).toBe(TOOLSET_PATH_OUTSIDE_ALLOWED);
          return { changed_files: ["docs/README.md", "src/child.ts"] };
        },
      });

      expect(first.lifecycle).toBe("CREATED");
      expect(first.workspaceId).toBe(verticalSliceWorkspaceId(caseId));
      expect(first.actual.changedFiles).toEqual(["docs/README.md", "src/child.ts"]);
      expect(first.actual.patch).toContain("src/child.ts");
      expect(first.actual.patch).toContain("new file mode");
      expect(first.actual.treeDigest).not.toBe(first.baseline.tree_digest);
      expect(first.operationResults).toHaveLength(3);
      expect(
        first.operationResults.every((result) => /^vs:[0-9a-f]{64}$/.test(result.operation_id)),
      ).toBe(true);
      expect(
        first.operationResults.some((result) => result.operation_id === "caller-controlled"),
      ).toBe(false);
      const callerOwned = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM implementation_tool_operations WHERE operation_id = $1",
        ["caller-controlled"],
      );
      expect(callerOwned.rows[0]?.count).toBe("0");
      await expect(readFile(join(first.workspacePath, "docs", "README.md"), "utf8")).resolves.toBe(
        "exact root\n",
      );
      await expect(readFile(join(first.workspacePath, "src", "child.ts"), "utf8")).resolves.toBe(
        "export const child = true;\n",
      );
      await expect(lstat(join(first.workspacePath, "src-other"))).rejects.toThrow();

      // Same slice/attempt regenerates the same server ids. Durable rows are
      // replayed, so changed model content cannot perform the effect twice.
      const recovered = await executeVerticalSlice({
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writer(authority),
        slice,
        attempt: 1,
        implement: async (tools) => {
          const replay = await tools.write({
            relative_path: "docs/README.md",
            content: "must not replay\n",
          });
          expect(replay.outcome).toBe(ToolOutcome.SUCCEEDED);
          return { changed_files: ["docs/README.md", "src/child.ts"] };
        },
      });
      expect(recovered.lifecycle).toBe("RESUMED");
      expect(recovered.operationResults[0]?.operation_id).toBe(
        first.operationResults[0]?.operation_id,
      );
      await expect(
        readFile(join(recovered.workspacePath, "docs", "README.md"), "utf8"),
      ).resolves.toBe("exact root\n");
    });

    it("rejects missing, foreign and stale writers before changing the tree", async () => {
      const before = await readFile(join(source, "src", "base.ts"), "utf8");
      const common = {
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        slice,
        attempt: 1,
        implement: async () => ({ changed_files: [] }),
      } as const;
      await expect(
        executeVerticalSlice({ ...common, writer: undefined as never }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);

      const authority: Authority = {
        owner: "writer-current",
        token: 11,
        enabled: true,
        inImplementation: false,
      };
      await expect(
        executeVerticalSlice({ ...common, writer: writer(authority, "writer-second", 12) }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
      authority.enabled = false;
      await expect(
        executeVerticalSlice({ ...common, writer: writer(authority) }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);

      expect(await readFile(join(source, "src", "base.ts"), "utf8")).toBe(before);
      await expect(lstat(join(workspaceRoot, caseId))).rejects.toThrow();
    });

    it("rejects a SliceContract outside the exact runtime binding before materialization", async () => {
      const authority: Authority = {
        owner: "writer-current",
        token: 13,
        enabled: true,
        inImplementation: false,
      };
      const common = {
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writer(authority),
        attempt: 1,
        implement: async () => ({ changed_files: [] }),
      } as const;

      for (const foreign of [
        { ...slice, case_id: "case-foreign" },
        { ...slice, run_id: "run-foreign" },
        { ...slice, revision: 9 },
      ]) {
        await expect(executeVerticalSlice({ ...common, slice: foreign })).rejects.toThrow(
          /runtime binding/,
        );
      }
      await expect(lstat(join(workspaceRoot, caseId))).rejects.toThrow();
    });

    it("uses the post-slice-one tree as slice-two baseline and emits only bound PASS evidence", async () => {
      const scheduled = await gateLease();
      const authority: Authority = {
        owner: scheduled.lease.leaseOwner,
        token: scheduled.lease.fencingToken,
        enabled: true,
        inImplementation: false,
      };
      const writerFence = writer(authority);
      const first = await executeVerticalSlice({
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 1,
        implement: async (tools) => {
          await tools.write({ relative_path: "src/slice-one.ts", content: "slice one accepted\n" });
          return { changed_files: ["src/slice-one.ts"] };
        },
      });
      const artifactRoot = join(parent, "artifacts");
      await mkdir(artifactRoot);
      const store = new LocalArtifactStore({ root: artifactRoot });
      const firstGates = await executeVerticalSliceGates({
        db,
        jobs: scheduled.jobs,
        lease: scheduled.lease,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 1,
        baseline: first.baseline,
        actual: first.actual,
        catalog: await catalog(),
        store,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        contextDigest: canonicalDigest({ context: "slice-one" }),
      });
      expect(firstGates.status).toBe("PASS");
      if (firstGates.status !== "PASS") throw new Error("expected first gate PASS");
      expect(firstGates.aggregate.baseline_tree_digest).toBe(first.baseline.tree_digest);
      expect(firstGates.bundle.tree_digest).toBe(first.actual.treeDigest);
      expect(firstGates.bundle.diff_digest).toBe(first.actual.diffDigest);

      const reviewBase = {
        db,
        lease: scheduled.lease,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 1,
        baseline: first.baseline,
        actual: first.actual,
        evidenceBundle: firstGates.bundle,
        evidenceBundleDigest: firstGates.bundleDigest,
        taskBrief: "Review the exact slice-one patch.",
      } as const;
      let reviewedRequest: unknown;
      const passedReview = await executeVerticalSliceReview({
        ...reviewBase,
        createReviewerSession: async () => ({
          sessionId: "fresh-review-pass",
          toolNames: [],
          review: async (request) => {
            reviewedRequest = request;
            return {
              output: preCommitReviewOutput.parse({
                schema_version: 1,
                findings: [],
                lines_examined: 6,
              }),
              modelCalls: 1,
            };
          },
        }),
      });
      expect(passedReview.decision).toMatchObject({
        artifact_kind: "ReviewDecision",
        decision: "PASS",
        findings: [],
      });
      expect(reviewedRequest).toMatchObject({
        binding: {
          case_id: caseId,
          run_id: "run-vslice",
          slice_id: "slice-one",
          attempt: 1,
        },
        actual_diff_digest: first.actual.diffDigest,
        tree_digest: first.actual.treeDigest,
        evidence_bundle: firstGates.bundle,
      });
      expect(passedReview.review.rawPatchDigest).not.toBe(first.actual.diffDigest);

      const changesReview = await executeVerticalSliceReview({
        ...reviewBase,
        createReviewerSession: async () => ({
          sessionId: "fresh-review-medium",
          toolNames: [],
          review: async () => ({
            output: preCommitReviewOutput.parse({
              schema_version: 1,
              findings: [
                {
                  severity: ReviewSeverity.MEDIUM,
                  summary: "The new slice value violates the accepted behavior.",
                  location: { relative_path: "src/slice-one.ts", line: 1 },
                  evidence: "slice one accepted",
                  required_fix: "Correct the bounded slice value.",
                },
              ],
              lines_examined: 6,
            }),
            modelCalls: 1,
          }),
        }),
      });
      expect(changesReview.decision).toMatchObject({
        artifact_kind: "ReviewDecision",
        decision: "CHANGES_REQUIRED",
      });
      expect(changesReview.decision.findings).toHaveLength(1);

      await expect(
        executeVerticalSliceReview({
          ...reviewBase,
          createReviewerSession: async () => ({
            sessionId: "fresh-review-stale-fence",
            toolNames: [],
            review: async () => {
              authority.enabled = false;
              return {
                output: preCommitReviewOutput.parse({
                  schema_version: 1,
                  findings: [],
                  lines_examined: 6,
                }),
                modelCalls: 1,
              };
            },
          }),
        }),
      ).rejects.toThrow(/stale writer/);
      authority.enabled = true;

      const baselineRoot = join(workspaceRoot, ".engineering-baselines");
      const restartedStore = new BaselineWorkspaceStore({ root: baselineRoot });
      const operationsBeforeReplay = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM engineering_operations",
      );
      const replayedGates = await executeVerticalSliceGates({
        db,
        jobs: scheduled.jobs,
        lease: scheduled.lease,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 1,
        baseline: first.baseline,
        actual: first.actual,
        catalog: await catalog(),
        store,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        contextDigest: canonicalDigest({ context: "slice-one" }),
        baselineStore: restartedStore,
      });
      expect(replayedGates).toMatchObject({ status: "PASS" });
      const operationsAfterReplay = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM engineering_operations",
      );
      expect(operationsAfterReplay.rows[0]?.count).toBe(operationsBeforeReplay.rows[0]?.count);
      const firstBinding = {
        case_id: caseId,
        workspace_id: first.workspaceId,
        run_id: "run-vslice",
        checkpoint_revision: 0,
        slice_id: slice.slice_id,
        attempt: 1,
      } as const;
      await expect(
        restartedStore.inspect(firstBinding, first.workspacePath, first.baseline, async () => true),
      ).resolves.toBe(true);
      await expect(
        restartedStore.cleanup(
          { ...firstBinding, slice_id: "foreign-slice" },
          first.workspacePath,
          first.baseline,
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_MISMATCH" });
      await expect(
        restartedStore.cleanup(firstBinding, first.workspacePath, {
          ...first.baseline,
          tree_digest: `sha256:${"f".repeat(64)}`,
        }),
      ).rejects.toMatchObject({ code: "MANIFEST_MISMATCH" });
      await expect(
        restartedStore.cleanup(firstBinding, first.workspacePath, first.baseline),
      ).resolves.toBe("CLEANED");
      await expect(
        restartedStore.cleanup(firstBinding, first.workspacePath, first.baseline),
      ).resolves.toBe("ALREADY_CLEANED");
      await expect(
        restartedStore.inspect(firstBinding, first.workspacePath, first.baseline, async () => true),
      ).rejects.toMatchObject({ code: "BASELINE_MISSING" });

      const sliceTwo = engineeringSliceContract.parse({
        ...slice,
        slice_id: "slice-two",
        objective: "write the second bounded result",
      });
      const second = await executeVerticalSlice({
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice: sliceTwo,
        attempt: 2,
        priorAgentPaths: first.actual.cumulativeAgentPaths,
        implement: async (tools) => {
          await tools.write({ relative_path: "src/slice-two.ts", content: "slice two\n" });
          return { changed_files: ["src/slice-two.ts"] };
        },
      });
      expect(second.baseline.tree_digest).toBe(first.actual.treeDigest);
      expect(second.actual.changedFiles).toEqual(["src/slice-two.ts"]);
      expect(second.actual.cumulativeAgentPaths).toEqual(["src/slice-one.ts", "src/slice-two.ts"]);
      const secondGates = await executeVerticalSliceGates({
        db,
        jobs: scheduled.jobs,
        lease: scheduled.lease,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice: sliceTwo,
        attempt: 2,
        baseline: second.baseline,
        actual: second.actual,
        catalog: await catalog(),
        store,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        contextDigest: canonicalDigest({ context: "slice-two" }),
      });
      expect(secondGates.status).toBe("PASS");
      if (secondGates.status !== "PASS") throw new Error("expected second gate PASS");
      expect(secondGates.aggregate.baseline_tree_digest).toBe(first.actual.treeDigest);
      expect(secondGates.bundle.tree_digest).toBe(second.actual.treeDigest);
      const secondReview = await executeVerticalSliceReview({
        db,
        lease: scheduled.lease,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice: sliceTwo,
        attempt: 2,
        baseline: second.baseline,
        actual: second.actual,
        evidenceBundle: secondGates.bundle,
        evidenceBundleDigest: secondGates.bundleDigest,
        taskBrief: "Review the exact slice-two patch.",
        createReviewerSession: async () => ({
          sessionId: "fresh-review-slice-two",
          toolNames: [],
          review: async () => ({
            output: preCommitReviewOutput.parse({
              schema_version: 1,
              findings: [],
              lines_examined: 8,
            }),
            modelCalls: 1,
          }),
        }),
      });
      const operationId = "eng-op-local-commit-vslice";
      const descriptor = buildEvidenceBoundCommitDescriptor({
        operationId,
        caseId,
        workUnitId: "wu-vslice",
        workspaceId: second.workspaceId,
        repositoryId: "repo",
        runId: "run-vslice",
        checkpointRevision: 0,
        branchName: `remoteagent/${second.workspaceId}`,
        expectedParentSha: baseSha,
        actual: second.actual,
        accepted: [
          {
            sliceId: slice.slice_id,
            attempt: 1,
            evidenceDigest: canonicalDigest(firstGates.bundle),
            reviewDigest: canonicalDigest(passedReview.decision),
          },
          {
            sliceId: sliceTwo.slice_id,
            attempt: 2,
            evidenceDigest: canonicalDigest(secondGates.bundle),
            reviewDigest: canonicalDigest(secondReview.decision),
          },
        ],
        finalVerificationDigest: canonicalDigest({ decision: "VERIFIED" }),
        summary: "complete two bounded slices",
      });
      const commit = await executeEvidenceBoundLocalCommit({
        db,
        writer: writerFence,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        descriptor,
      });
      expect(commit).toMatchObject({
        artifact_kind: "LocalCommitReceipt",
        branch: descriptor.branch_name,
        parent_sha: baseSha,
        review_digest: descriptor.review_digest,
      });
      expect(
        await recoverEvidenceBoundLocalCommit({
          db,
          workspaceConfig: config(),
          repositoryId: "repo",
          caseId,
          runId: "run-vslice",
          workUnitId: "wu-vslice",
          checkpointRevision: 0,
          descriptor,
        }),
      ).toEqual(commit);
      expect(
        (
          await run("git", ["-C", second.workspacePath, "rev-list", "--count", `${baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");
    });

    it("rejects omission of any server-required gate before creating an operation", async () => {
      const scheduled = await gateLease();
      const authority: Authority = {
        owner: scheduled.lease.leaseOwner,
        token: scheduled.lease.fencingToken,
        enabled: true,
        inImplementation: false,
      };
      const writerFence = writer(authority);
      const execution = await executeVerticalSlice({
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 1,
        implement: async (tools) => {
          await tools.write({ relative_path: "src/omitted-gate.ts", content: "bounded\n" });
          return { changed_files: ["src/omitted-gate.ts"] };
        },
      });
      const executable = await realpath(process.execPath);
      const definition = (gateId: string) =>
        VerificationGateDefinition.parse({
          schema_version: 1,
          gate_id: gateId,
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
        });
      const requiredCatalog = await VerificationGateCatalog.create({
        definitions: [definition("unit"), definition("security")],
        executable_allowlist: [executable],
      });
      const before = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM engineering_operations",
      );
      const artifactRoot = join(parent, "omitted-gate-artifacts");
      await mkdir(artifactRoot);
      await expect(
        executeVerticalSliceGates({
          db,
          jobs: scheduled.jobs,
          lease: scheduled.lease,
          workspaceConfig: config(),
          repositoryId: "repo",
          caseId,
          runId: "run-vslice",
          workUnitId: "wu-vslice",
          checkpointRevision: 0,
          writer: writerFence,
          slice,
          attempt: 1,
          baseline: execution.baseline,
          actual: execution.actual,
          catalog: requiredCatalog,
          store: new LocalArtifactStore({ root: artifactRoot }),
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          contextDigest: canonicalDigest({ context: "omitted-required" }),
        }),
      ).rejects.toThrow(/equal every server-required gate/);
      const after = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM engineering_operations",
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });

    it("rejects a false changed-files report and blocks a failed gate without a bundle", async () => {
      const scheduled = await gateLease();
      const authority: Authority = {
        owner: scheduled.lease.leaseOwner,
        token: scheduled.lease.fencingToken,
        enabled: true,
        inImplementation: false,
      };
      const writerFence = writer(authority);
      await expect(
        executeVerticalSlice({
          db,
          workspaceConfig: config(),
          repositoryId: "repo",
          baseSha,
          caseId,
          runId: "run-vslice",
          checkpointRevision: 0,
          writer: writerFence,
          slice,
          attempt: 1,
          implement: async (tools) => {
            await tools.write({ relative_path: "src/actual.ts", content: "actual\n" });
            return { changed_files: ["src/claimed.ts"] };
          },
        }),
      ).rejects.toThrow(/does not match actual slice delta/);
      const workspacePath = join(workspaceRoot, caseId, verticalSliceWorkspaceId(caseId));
      expect(
        await run("git", ["-C", workspacePath, "diff", "--cached", "--name-only"]),
      ).toMatchObject({
        stdout: "",
      });

      // A new attempt gets a new pre-write baseline and cannot launder the prior
      // untrusted report into its own result.
      const corrected = await executeVerticalSlice({
        db,
        workspaceConfig: config(),
        repositoryId: "repo",
        baseSha,
        caseId,
        runId: "run-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 2,
        priorAgentPaths: ["src/actual.ts"],
        implement: async (tools) => {
          await tools.write({ relative_path: "src/corrected.ts", content: "corrected\n" });
          return { changed_files: ["src/corrected.ts"] };
        },
      });
      const artifactRoot = join(parent, "failed-artifacts");
      await mkdir(artifactRoot);
      const gateBase = {
        db,
        jobs: scheduled.jobs,
        workspaceConfig: config(),
        repositoryId: "repo",
        caseId,
        runId: "run-vslice",
        workUnitId: "wu-vslice",
        checkpointRevision: 0,
        writer: writerFence,
        slice,
        attempt: 2,
        baseline: corrected.baseline,
        actual: corrected.actual,
        catalog: await catalog({ fail: true, baseline: false }),
        store: new LocalArtifactStore({ root: artifactRoot }),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        contextDigest: canonicalDigest({ context: "failed" }),
      } as const;
      await expect(
        executeVerticalSliceGates({
          ...gateBase,
          lease: {
            ...scheduled.lease,
            payload: { ...scheduled.lease.payload, workUnitId: "foreign-unit" },
          },
        }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
      const failed = await executeVerticalSliceGates({
        ...gateBase,
        lease: scheduled.lease,
      });
      expect(failed).toMatchObject({ status: "BLOCKED", bundle: null, reason: "FAILED" });
    });

    it("re-checks the fence before every patch syscall and halts after AMBIGUOUS", async () => {
      const authority: Authority = {
        owner: "writer-a",
        token: 17,
        enabled: true,
        inImplementation: false,
      };
      let mutationChecks = 0;
      const guardedWriter: VerticalSliceWriterFence = {
        caseId,
        leaseOwner: authority.owner,
        fencingToken: authority.token,
        assertCurrent: async () => {
          if (authority.inImplementation) {
            mutationChecks += 1;
            if (mutationChecks === 1) authority.enabled = false;
          }
          if (!authority.enabled && mutationChecks > 1) throw new Error("stale writer");
        },
      };

      await expect(
        executeVerticalSlice({
          db,
          workspaceConfig: config(),
          repositoryId: "repo",
          baseSha,
          caseId,
          runId: "run-vslice",
          checkpointRevision: 0,
          writer: guardedWriter,
          slice,
          attempt: 1,
          implement: async (tools) => {
            authority.inImplementation = true;
            const partial = await tools.patch({
              files: [
                { relative_path: "src/first.ts", content: "first\n" },
                { relative_path: "src/second.ts", content: "second\n" },
              ],
            });
            expect(partial.outcome).toBe(ToolOutcome.AMBIGUOUS);
            await expect(
              tools.write({ relative_path: "src/replayed.ts", content: "no\n" }),
            ).rejects.toThrow(/requires reconciliation/);
            return { changed_files: ["src/first.ts"] };
          },
        }),
      ).rejects.toThrow(/ambiguous implementation operation/);

      expect(mutationChecks).toBe(2);
      const workspacePath = join(workspaceRoot, caseId, verticalSliceWorkspaceId(caseId));
      await expect(readFile(join(workspacePath, "src", "first.ts"), "utf8")).resolves.toBe(
        "first\n",
      );
      await expect(lstat(join(workspacePath, "src", "second.ts"))).rejects.toThrow();
      await expect(lstat(join(workspacePath, "src", "replayed.ts"))).rejects.toThrow();
    });

    it("re-checks the writer immediately before staging actual untracked paths", async () => {
      const authority: Authority = {
        owner: "writer-a",
        token: 31,
        enabled: true,
        inImplementation: false,
      };
      await expect(
        executeVerticalSlice({
          db,
          workspaceConfig: config(),
          repositoryId: "repo",
          baseSha,
          caseId,
          runId: "run-vslice",
          checkpointRevision: 0,
          writer: writer(authority),
          slice,
          attempt: 1,
          implement: async (tools) => {
            await tools.write({ relative_path: "src/pre-stage.ts", content: "written\n" });
            authority.enabled = false;
            return { changed_files: ["src/pre-stage.ts"] };
          },
        }),
      ).rejects.toThrow(/writer fence is not current/);
      const workspacePath = join(workspaceRoot, caseId, verticalSliceWorkspaceId(caseId));
      const staged = await run("git", ["-C", workspacePath, "diff", "--cached", "--name-only"]);
      expect(staged.stdout).toBe("");
      await expect(readFile(join(workspacePath, "src", "pre-stage.ts"), "utf8")).resolves.toBe(
        "written\n",
      );
    });
  },
  available,
);
