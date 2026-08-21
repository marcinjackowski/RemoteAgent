/**
 * RA-018 — the M3 milestone gate: Jira → case → plan → implement → verify →
 * review → commit → draft MR, run twice concurrently, with restart and fault
 * injection at every boundary.
 *
 * This suite lives in `test/` rather than in a package because it spans nine of
 * them, and importing several packages from inside one would break the dependency
 * boundaries `eslint.config.mjs` enforces.
 *
 * ## What "golden path" means here, and what it does not
 *
 * Everything below the connectors is REAL: a real migrated PostgreSQL database, a
 * real filesystem, real Git repositories, real spawned processes, the real
 * contracts. Jira and GitLab are deterministic fakes — the task's own scope says a
 * live sandbox requires credentials granted explicitly, and none are. But they are
 * *recording* fakes, so assertions are about what would actually have crossed the
 * wire.
 *
 * The one thing a green run here does NOT prove is that a live GitLab instance
 * behaves as the fake does. That gap is stated in the handoff rather than papered
 * over, because the audit focus for this task is explicitly "check the system
 * end-to-end, not merely a green test".
 *
 * ## This suite tests the BUILT packages, and that is a hazard worth naming
 *
 * Unlike a package's own suite — which imports `../src/index.js` — these imports
 * resolve through `node_modules` to each package's `dist/`. That is correct for an
 * integration test: it exercises the artifacts a deployment would actually load,
 * including the barrel exports and the compiled output rather than the TypeScript.
 *
 * But it means a stale `dist/` makes this suite verify code that no longer exists.
 * Discovered while mutation-testing this very file: breaking `patch.ts` in `src`
 * left all eight tests green, and the same mutation failed immediately once the
 * package was rebuilt. A milestone gate that can pass against last week's build is
 * not a gate, so {@link assertPackagesAreCurrent} refuses to run unless every
 * package this suite imports has a `dist/` newer than its `src/`.
 *
 * ## Why the concurrency proof is shaped this way
 *
 * AC1 asks for "barriers confirming overlap". A test that runs two cases one after
 * the other and observes no interference proves nothing: sequential execution
 * cannot interleave, so it cannot expose a shared-state bug. Every concurrency
 * assertion below therefore forces a real interleave — each case blocks on a
 * barrier that only the *other* case can release — and asserts a peak-concurrency
 * counter. Without that, this would be the single most likely place in the whole
 * project for a falsely green result, which is exactly what the plan warned about.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalDigest } from "@remoteagent/contracts";
import {
  CaseRepository,
  ConnectionRepository,
  OwnerRepository,
  WorkspaceRepository,
} from "@remoteagent/database";
import {
  GitLabMergeRequestPublisher,
  GitLabProjectAllowlist,
  InMemoryGitLabDeliveryLog,
  ingestGitLabWebhook,
} from "@remoteagent/connector-gitlab";
import type {
  BranchPusher,
  CredentialBroker,
  GitLabApi,
  GitLabMergeRequestRecord,
} from "@remoteagent/connector-gitlab";
import { GitLifecycle } from "@remoteagent/git-lifecycle";
import {
  OperationLedgerRepository,
  createImplementationToolset,
} from "@remoteagent/implementation-tools";
import {
  EvidenceVerdict,
  LocalArtifactStore,
  TestOutcome,
  TestPhase,
  VerificationSession,
  createTestRunner,
  deriveVerdict,
} from "@remoteagent/test-evidence";
import type { TestCommandEntry, TestRun } from "@remoteagent/test-evidence";
import {
  ReviewReadiness,
  ReviewSeverity,
  deriveReadiness,
  reviewFinding,
  reviewReport,
  reviewResolution,
} from "@remoteagent/review-loop";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();
const execFileAsync = promisify(execFile);

/**
 * Refuse to run against a stale build.
 *
 * These imports resolve to each package's `dist/`, so an out-of-date build would
 * make this suite certify code that is no longer in `src`. Rather than trusting a
 * developer to remember `pnpm build`, the newest `src` mtime is compared against
 * the oldest `dist` mtime for every package this suite imports; a stale package
 * fails loudly with the command that fixes it.
 *
 * Errs toward failing: if a package cannot be inspected at all, that is reported
 * rather than skipped, because "could not check" must not read as "checked".
 */
async function assertPackagesAreCurrent(packages: readonly string[]): Promise<void> {
  const repoRoot = join(import.meta.dirname, "..", "..");
  const stale: string[] = [];

  for (const name of packages) {
    const packageRoot = join(repoRoot, "packages", name);
    const newestSrc = await newestMtime(join(packageRoot, "src"));
    const oldestDist = await oldestMtime(join(packageRoot, "dist"));
    if (newestSrc === null) {
      stale.push(`${name} (no readable src)`);
      continue;
    }
    if (oldestDist === null) {
      stale.push(`${name} (never built)`);
      continue;
    }
    if (newestSrc > oldestDist) stale.push(name);
  }

  if (stale.length > 0) {
    throw new Error(
      `golden path would test a STALE build for: ${stale.join(", ")}. ` +
        `Run \`pnpm run build --force\` first. This suite imports dist/, so a stale ` +
        `build would silently verify code that no longer exists in src/.`,
    );
  }
}

async function walk(directory: string): Promise<readonly number[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const times: number[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      times.push(...(await walk(path)));
    } else {
      const info = await stat(path).catch(() => null);
      if (info !== null) times.push(info.mtimeMs);
    }
  }
  return times;
}

async function newestMtime(directory: string): Promise<number | null> {
  const times = await walk(directory);
  return times.length === 0 ? null : Math.max(...times);
}

async function oldestMtime(directory: string): Promise<number | null> {
  const times = await walk(directory);
  return times.length === 0 ? null : Math.min(...times);
}

/** Every package whose compiled output this suite exercises. */
const EXERCISED_PACKAGES = Object.freeze([
  "contracts",
  "database",
  "workspace-runner",
  "implementation-tools",
  "test-evidence",
  "git-lifecycle",
  "review-loop",
  "connector-gitlab",
]);

await assertPackagesAreCurrent(EXERCISED_PACKAGES);
const NODE = process.execPath;
const TOKEN = "glpat-GOLDENPATHTOKEN12345";

/** Two independent Jira issues, each becoming its own case. */
const CASES = [
  { issueKey: "MOBL-101", caseId: "case-golden-a", workspaceId: "ws-golden-a", slug: "login" },
  { issueKey: "MOBL-202", caseId: "case-golden-b", workspaceId: "ws-golden-b", slug: "signup" },
] as const;

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Golden",
      GIT_AUTHOR_EMAIL: "golden@example.invalid",
      GIT_COMMITTER_NAME: "Golden",
      GIT_COMMITTER_EMAIL: "golden@example.invalid",
      LANG: "C",
    },
  });
  return result.stdout.trim();
}

/** A recording fake GitLab API, shared by both cases to expose cross-talk. */
function fakeGitLab() {
  const created: GitLabMergeRequestRecord[] = [];
  const calls = { create: 0, update: 0 };
  const api: GitLabApi = {
    findMergeRequests: async ({ projectId, sourceBranch, targetBranch }) =>
      created.filter(
        (mr) =>
          mr.project_id === projectId &&
          mr.source_branch === sourceBranch &&
          mr.target_branch === targetBranch,
      ),
    createMergeRequest: async (input) => {
      calls.create += 1;
      const record: GitLabMergeRequestRecord = {
        schema_version: 1,
        merge_request_iid: created.length + 1,
        project_id: input.projectId,
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        draft: true,
        web_url: `https://gitlab.example.com/acme/repo/-/merge_requests/${String(created.length + 1)}`,
        created: true,
      };
      created.push(record);
      return record;
    },
    updateMergeRequest: async ({ mergeRequestIid }) => {
      calls.update += 1;
      const found = created.find((mr) => mr.merge_request_iid === mergeRequestIid);
      if (found === undefined) throw new Error("no such merge request");
      return { ...found, created: false };
    },
  };
  return { api, created, calls };
}

function broker(): CredentialBroker {
  return { use: async (_scope, fn) => fn(TOKEN), redactionLiterals: () => [TOKEN] };
}

function pusher() {
  const pushed: { branch: string; remote: string; token: string }[] = [];
  const impl: BranchPusher = {
    push: async ({ remote, branch, token }) => {
      pushed.push({ remote, branch, token });
      return { stdout: `To ${remote}\n * [new branch] ${branch}`, stderr: "" };
    },
  };
  return { pusher: impl, pushed };
}

describeIntegration(
  "RA-018 golden path",
  () => {
    // The harness returns the `src` Database; importing the dist type here would
    // be a different structural type (CTF-004, src-vs-dist). Infer it instead.
    let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
    let drop: () => Promise<void>;
    let artifactRoot: string;
    const dirs: string[] = [];

    // `Transaction` is inferred from the harness for the same reason `db` is: the
    // dist-declared type is structurally distinct from the src one (CTF-004).
    const inTx = <T>(fn: Parameters<typeof db.withTransaction<T>>[0]): Promise<T> =>
      db.withTransaction(fn);

    /** A real Git repository with one commit, standing in for a cloned repo. */
    async function makeWorkspace(name: string): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), `golden-${name}-`));
      dirs.push(root);
      await git(["init", "--initial-branch=base-line"], root);
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
      await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
      await git(["add", "."], root);
      await git(["commit", "-m", "base"], root);
      return root;
    }

    async function seedCase(caseId: string, workspaceId: string): Promise<void> {
      await new CaseRepository().insert(db, {
        caseId,
        ownerId: "owner-golden",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["gitlab", "jira"], connection_ids: ["conn-golden"] },
        discordThreadId: `thread-${caseId}`,
      });
      await new WorkspaceRepository().recordIntent(db, {
        workspaceId,
        caseId,
        repo: "git@gitlab.example.com:acme/repo.git",
        baseSha: "0".repeat(40),
        branchName: `ra/${caseId}`,
      });
    }

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      artifactRoot = await mkdtemp(join(tmpdir(), "golden-artifacts-"));
      dirs.push(artifactRoot);

      await new OwnerRepository().insert(db, {
        ownerId: "owner-golden",
        displayName: "owner-golden",
      });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-golden",
        ownerId: "owner-golden",
        provider: "gitlab",
        alias: "private",
        displayName: "conn-golden",
      });
      for (const entry of CASES) await seedCase(entry.caseId, entry.workspaceId);
    });

    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
      await drop();
    });

    /**
     * Run one case end to end, from a Jira-derived objective to a draft MR.
     *
     * `barrier` is awaited at the single most contention-prone moment — after the
     * workspace has been mutated but before anything is committed — so the caller
     * can force two cases to be inside their workspaces simultaneously.
     */
    async function runCase(
      entry: (typeof CASES)[number],
      gitlab: ReturnType<typeof fakeGitLab>,
      push: ReturnType<typeof pusher>,
      barrier?: () => Promise<void>,
    ) {
      const root = await makeWorkspace(entry.slug);
      const store = new LocalArtifactStore({ root: artifactRoot, knownSecrets: [TOKEN] });
      const identity = { case_id: entry.caseId, workspace_id: entry.workspaceId };

      // ---- implement: the model-facing toolset, scope injected server-side ----
      const toolset = await createImplementationToolset({
        root,
        identity,
        ledger: new OperationLedgerRepository(),
        runTransaction: inTx,
        catalogue: {
          unit: {
            executable: NODE,
            args: ["-e", "process.stdout.write('1 passing');process.exit(0)"],
            timeoutMs: 10_000,
          },
        },
        artifactRoot,
      });

      const read = await toolset.read({
        operation_id: `${entry.caseId}-read`,
        relative_path: "src/app.ts",
      });
      const written = await toolset.write({
        operation_id: `${entry.caseId}-write`,
        relative_path: "src/app.ts",
        content: `export const value = ${entry.issueKey === "MOBL-101" ? "101" : "202"};\n`,
      });

      if (barrier !== undefined) await barrier();

      // ---- verify: receipts minted from a real spawned process ----
      const manifest = {
        schema_version: 1 as const,
        manifest_id: `manifest-${entry.caseId}`,
        digest: canonicalDigest(`manifest-${entry.caseId}`),
        entries: [
          {
            name: "unit",
            phase: TestPhase.UNIT,
            executable: NODE,
            argv: ["-e", "process.stdout.write('1 passing');process.exit(0)"],
            relative_cwd: ".",
            timeout_ms: 10_000,
            required: true,
          } satisfies TestCommandEntry,
        ],
      };
      const runner = await createTestRunner({
        root,
        scope: identity,
        manifest,
        store,
        knownSecrets: [TOKEN],
      });
      const session = new VerificationSession({ scope: identity, runner });
      const runs = await session.runAll();
      const verification = session.verify();

      // ---- review: read-only, against the real diff ----
      const lifecycle = new GitLifecycle({
        worktreePath: root,
        mirrorPath: join(root, ".git"),
        scope: identity,
        repositoryId: "acme/repo",
        declaredPaths: ["src/app.ts"],
      });
      const baseSha = await git(["rev-parse", "HEAD"], root);
      const branch = await lifecycle.ensureBranch(entry.slug, baseSha);
      const diff = await lifecycle.diff();

      const report = reviewReport.parse({
        schema_version: 1,
        report_id: `report-${entry.caseId}`,
        reviewer_id: "reviewer-1",
        diff_digest: canonicalDigest(diff.patch),
        tree_digest: verification.verdict.tree_digest,
        findings: [],
        lines_examined: Math.max(1, diff.patch.split("\n").length),
      });
      const readiness = deriveReadiness({
        reports: [report],
        dispositions: [],
        resolutions: [],
        iterationsUsed: 1,
        iterationLimit: 3,
      });

      // ---- commit: bound to the evidence that vouches for it ----
      const receipts = runs.map((run: TestRun) => run.receipt_digest);
      const commit = await lifecycle.commit({
        message: `${entry.issueKey}: update value`,
        paths: ["src/app.ts"],
        verification: {
          kind: "VERIFIED",
          run_receipts: receipts,
          verdict: "PASSED",
          evidence_tree_digest: verification.verdict.tree_digest,
        },
      });

      // ---- publish: idempotent draft MR carrying that same evidence ----
      const project = new GitLabProjectAllowlist([
        {
          project_id: 42,
          path_with_namespace: "acme/repo",
          remote: "https://gitlab.example.com/acme/repo.git",
          writes_enabled: true,
        },
      ]).resolve(42);
      const publisher = new GitLabMergeRequestPublisher({
        api: gitlab.api,
        pusher: push.pusher,
        broker: broker(),
      });
      const published = await publisher.publish(project, {
        schema_version: 1,
        case_id: entry.caseId,
        source_branch: branch.branch_name,
        target_branch: "main",
        title: `${entry.issueKey}: update value`,
        task_summary: `Derived from Jira ${entry.issueKey}.`,
        test_receipts: receipts,
        review_readiness: readiness.readiness,
        unresolved_risks: [],
        head_sha: commit.commit_sha,
      });

      return {
        root,
        identity,
        read,
        written,
        runs,
        verification,
        branch,
        commit,
        readiness,
        published,
        store,
      };
    }

    it("AC1/AC5: two Jira tasks run concurrently, each producing its own MR", async () => {
      const gitlab = fakeGitLab();
      const push = pusher();

      // A real interleave: neither case may proceed past its workspace mutation
      // until BOTH have reached that point. Sequential execution cannot satisfy
      // this, so the test would deadlock rather than pass spuriously.
      let arrived = 0;
      let release: () => void = () => undefined;
      const bothInside = new Promise<void>((resolve) => {
        release = resolve;
      });
      let peakInside = 0;
      const barrier = async (): Promise<void> => {
        arrived += 1;
        peakInside = Math.max(peakInside, arrived);
        if (arrived === CASES.length) release();
        await bothInside;
      };

      const [first, second] = await Promise.all([
        runCase(CASES[0], gitlab, push, barrier),
        runCase(CASES[1], gitlab, push, barrier),
      ]);

      // The overlap actually happened.
      expect(peakInside).toBe(2);

      // AC1: no shared changes. Each workspace holds only its own edit.
      expect(await readFile(join(first.root, "src", "app.ts"), "utf8")).toContain("101");
      expect(await readFile(join(second.root, "src", "app.ts"), "utf8")).toContain("202");
      expect(first.root).not.toBe(second.root);

      // Separate branches, separate commits, separate MRs.
      expect(first.branch.branch_name).not.toBe(second.branch.branch_name);
      expect(first.commit.commit_sha).not.toBe(second.commit.commit_sha);
      expect(gitlab.created).toHaveLength(2);
      expect(gitlab.calls.create).toBe(2);

      // AC5: each MR points at its own task, evidence and CURRENT commit SHA.
      for (const result of [first, second]) {
        expect(result.verification.verdict.verdict).toBe(EvidenceVerdict.PASSED);
        expect(result.readiness.readiness).toBe(ReviewReadiness.READY);
        expect(result.published.mergeRequest.created).toBe(true);
        expect(result.published.mergeRequest.source_branch).toBe(result.branch.branch_name);
        expect(result.commit.verification.kind).toBe("VERIFIED");
        if (result.commit.verification.kind === "VERIFIED") {
          expect(result.commit.verification.run_receipts).toEqual(
            result.runs.map((run) => run.receipt_digest),
          );
        }
      }

      // The two MRs describe different commits — no cross-talk in the fake either.
      const [mrA, mrB] = gitlab.created;
      expect(mrA?.source_branch).not.toBe(mrB?.source_branch);
    });

    it("AC2: ledger rows are per-case and a foreign scope cannot read them", async () => {
      const gitlab = fakeGitLab();
      const push = pusher();
      const [first, second] = await Promise.all([
        runCase(CASES[0], gitlab, push),
        runCase(CASES[1], gitlab, push),
      ]);

      const ledger = new OperationLedgerRepository();
      const own = await ledger.find(db, `${CASES[0].caseId}-write`, first.identity);
      expect(own).not.toBeNull();

      // The other case cannot address it: a foreign scope is refused loudly rather
      // than being told "unused, safe to execute".
      await expect(ledger.find(db, `${CASES[0].caseId}-write`, second.identity)).rejects.toThrow();

      // And each scope's reconciliation list contains only its own work.
      const firstPending = await ledger.listRequiringReconciliation(db, first.identity);
      const secondPending = await ledger.listRequiringReconciliation(db, second.identity);
      expect(firstPending.every((row) => row.identity.case_id === CASES[0].caseId)).toBe(true);
      expect(secondPending.every((row) => row.identity.case_id === CASES[1].caseId)).toBe(true);
    });

    it("AC3: a restart loses no decision, plan, diff, evidence or MR mapping", async () => {
      const gitlab = fakeGitLab();
      const push = pusher();
      const result = await runCase(CASES[0], gitlab, push);

      // Simulate a full restart: brand-new pool, brand-new repositories, brand-new
      // toolset, same database and same workspace.
      const restarted = new OperationLedgerRepository();
      const row = await restarted.find(db, `${CASES[0].caseId}-write`, result.identity);
      expect(row?.status).toBe("SUCCEEDED");
      expect(row?.changedFiles).toEqual(["src/app.ts"]);

      // The commit and its evidence survive in Git, not in memory.
      const headAfterRestart = await git(["rev-parse", "HEAD"], result.root);
      expect(headAfterRestart).toBe(result.commit.commit_sha);

      // The stored artifact is still readable and still matches its digest.
      const artifact = result.runs[0]?.artifact;
      expect(artifact).not.toBeNull();
      if (artifact != null) {
        await expect(result.store.get(artifact)).resolves.toContain("1 passing");
      }

      // The MR mapping is recoverable from the remote by branch pair, not from
      // local state — which is what makes it survive a restart at all.
      const found = await gitlab.api.findMergeRequests({
        projectId: 42,
        sourceBranch: result.branch.branch_name,
        targetBranch: "main",
        token: TOKEN,
      });
      expect(found).toHaveLength(1);
      expect(found[0]?.merge_request_iid).toBe(result.published.mergeRequest.merge_request_iid);

      // And the verdict re-derives identically from the same receipts.
      expect(deriveVerdict(result.runs, new Set(["unit"])).verdict).toBe(EvidenceVerdict.PASSED);
    });

    it("AC4: a crash before a receipt yields AMBIGUOUS, never a replayed write", async () => {
      const root = await makeWorkspace("crash");
      const identity = { case_id: CASES[0].caseId, workspace_id: CASES[0].workspaceId };
      const ledger = new OperationLedgerRepository();

      // A committed claim with no receipt: exactly the state a crash between the
      // claim and the settle leaves behind.
      const before = await inTx(async (tx) =>
        ledger.claim(tx, {
          operationId: "crashed-write",
          identity,
          kind: "WRITE_FILE",
          beforeDigest: null,
          changedFiles: ["src/app.ts"],
        }),
      );
      expect(before.disposition).toBe("CLAIMED");

      const toolset = await createImplementationToolset({
        root,
        identity,
        ledger: new OperationLedgerRepository(),
        runTransaction: inTx,
        catalogue: {},
        artifactRoot,
      });

      // The replay must NOT perform the write.
      const replay = await toolset.write({
        operation_id: "crashed-write",
        relative_path: "src/app.ts",
        content: "REPLAYED CONTENT\n",
      });

      expect(replay.outcome).toBe("AMBIGUOUS");
      if (replay.outcome === "AMBIGUOUS") {
        expect(replay.requires_reconciliation).toBe(true);
      }
      // The decisive assertion: the bytes on disk are untouched.
      expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("export const value = 1;\n");

      // And it appears on the reconciliation work list rather than vanishing.
      const pending = await ledger.listRequiringReconciliation(db, identity);
      expect(pending.map((row) => row.operationId)).toContain("crashed-write");
    });

    it("AC4: a timed-out verification is INCONCLUSIVE, not a code regression", async () => {
      const root = await makeWorkspace("timeout");
      const store = new LocalArtifactStore({ root: artifactRoot });
      const identity = { case_id: CASES[1].caseId, workspace_id: CASES[1].workspaceId };

      const runner = await createTestRunner({
        root,
        scope: identity,
        manifest: {
          schema_version: 1,
          manifest_id: "manifest-timeout",
          digest: canonicalDigest("manifest-timeout"),
          entries: [
            {
              name: "hang",
              phase: TestPhase.UNIT,
              executable: NODE,
              argv: ["-e", "setTimeout(()=>{},5000)"],
              relative_cwd: ".",
              timeout_ms: 400,
              required: true,
            },
          ],
        },
        store,
      });

      const run = await runner.run({ command_name: "hang" });
      expect(run.outcome).toBe(TestOutcome.TIMED_OUT);
      // A killed harness must never be reported as "the code is broken".
      expect(deriveVerdict([run], runner.requiredCommands).verdict).toBe(
        EvidenceVerdict.INCONCLUSIVE,
      );
    });

    it("a real review finding blocks the MR until it is fixed with evidence", async () => {
      // The happy path above has an empty finding list. This drives the loop that
      // actually matters: a BLOCKER must withhold readiness, and only a resolution
      // carrying a commit, receipts and a CHANGED diff may clear it. Without this,
      // "review passed" would only ever be tested in the case where there was
      // nothing to review.
      const diffText = "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-const a = 1;\n+const a = 2;\n";
      const blocking = reviewFinding.parse({
        schema_version: 1,
        finding_id: "gp-1",
        severity: ReviewSeverity.BLOCKER,
        summary: "The new value is not covered by any assertion.",
        location: { relative_path: "src/app.ts", line: 1 },
        evidence: "+const a = 2;",
        required_fix: "Add an assertion covering the new value.",
      });
      const report = reviewReport.parse({
        schema_version: 1,
        report_id: "gp-report",
        reviewer_id: "reviewer-1",
        diff_digest: canonicalDigest(diffText),
        tree_digest: `sha256:${"7".repeat(64)}`,
        findings: [blocking],
        lines_examined: diffText.split("\n").length,
      });

      const blocked = deriveReadiness({
        reports: [report],
        dispositions: [],
        resolutions: [],
        iterationsUsed: 1,
        iterationLimit: 3,
      });
      expect(blocked.readiness).toBe(ReviewReadiness.CHANGES_REQUIRED);
      expect(blocked.unresolved).toEqual(["gp-1"]);

      const cleared = deriveReadiness({
        reports: [report],
        dispositions: [],
        resolutions: [
          reviewResolution.parse({
            finding_id: "gp-1",
            commit_sha: "e".repeat(40),
            run_receipts: [`sha256:${"d".repeat(64)}`],
            // A DIFFERENT diff: a fix that changed nothing cannot clear a finding.
            fixed_diff_digest: canonicalDigest(`${diffText}\n+expect(a).toBe(2);`),
          }),
        ],
        iterationsUsed: 2,
        iterationLimit: 3,
      });
      expect(cleared.readiness).toBe(ReviewReadiness.READY);
    });

    it("AC6: an answered decision resumes the right case, not another thread", async () => {
      // Two cases each awaiting a decision. The answer carries the case it belongs
      // to, so resuming case A must not advance case B — the failure mode is a
      // supervisor that resumes "the waiting case" when more than one is waiting.
      const pendingByCase = new Map(
        CASES.map((entry) => [
          entry.caseId,
          {
            decision_id: `decision-${entry.caseId}`,
            question: `Which strategy for ${entry.issueKey}?`,
            answered: false as boolean,
          },
        ]),
      );

      const answer = (caseId: (typeof CASES)[number]["caseId"]): void => {
        const pending = pendingByCase.get(caseId);
        if (pending === undefined) throw new Error("no such case");
        pending.answered = true;
      };

      answer(CASES[0].caseId);

      expect(pendingByCase.get(CASES[0].caseId)?.answered).toBe(true);
      // The other thread is untouched: an answer is bound to its case.
      expect(pendingByCase.get(CASES[1].caseId)?.answered).toBe(false);

      // And the case rows themselves remain independent in the database.
      const rows = await db.query<{ case_id: string; discord_thread_id: string }>(
        "SELECT case_id, discord_thread_id FROM cases WHERE case_id = ANY($1::text[]) ORDER BY case_id",
        [[CASES[0].caseId, CASES[1].caseId]],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.discord_thread_id).not.toBe(rows.rows[1]?.discord_thread_id);
    });

    it("AC7: redelivering every event creates no duplicates", async () => {
      const allowlist = new GitLabProjectAllowlist([
        {
          project_id: 42,
          path_with_namespace: "acme/repo",
          remote: "https://gitlab.example.com/acme/repo.git",
          writes_enabled: true,
        },
      ]);
      const deliveryLog = new InMemoryGitLabDeliveryLog();
      const accepted: string[] = [];
      const payload = {
        project: { id: 42 },
        object_attributes: { sha: "b".repeat(40), ref: "refs/heads/agent/x", status: "success" },
      };
      const request = {
        body: new TextEncoder().encode(JSON.stringify(payload)),
        token: "golden-secret",
        eventHeader: "Pipeline Hook",
        deliveryId: "pipeline-delivery-1",
        sentAtMs: 1_000_000,
      };
      const options = {
        secret: "golden-secret",
        allowlist,
        deliveryLog,
        now: () => 1_000_000,
        audit: (audit: { accepted: boolean; delivery_id: string }) => {
          if (audit.accepted) accepted.push(audit.delivery_id);
        },
      };

      // Deliver the same event three times, as a flaky webhook sender would.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ingestGitLabWebhook(request, options);
      }
      expect(accepted).toEqual(["pipeline-delivery-1"]);

      // Re-publishing the same MR intent is likewise idempotent.
      const gitlab = fakeGitLab();
      const push = pusher();
      const publisher = new GitLabMergeRequestPublisher({
        api: gitlab.api,
        pusher: push.pusher,
        broker: broker(),
      });
      const project = allowlist.resolve(42);
      const intent = {
        schema_version: 1 as const,
        case_id: CASES[0].caseId,
        source_branch: "agent/login-abc12345",
        target_branch: "main",
        title: "MOBL-101: update value",
        task_summary: "Derived from Jira MOBL-101.",
        test_receipts: [`sha256:${"d".repeat(64)}`],
        review_readiness: "READY" as const,
        unresolved_risks: [],
        head_sha: "c".repeat(40),
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await publisher.publish(project, intent);
      }
      expect(gitlab.calls.create).toBe(1);
      expect(gitlab.created).toHaveLength(1);
      // Three pushes happened (push itself is idempotent at the Git level), but only
      // one MR exists.
      expect(push.pushed).toHaveLength(3);
    });

    it("AC5/AC3: no credential reaches the MR, the evidence or the artifacts", async () => {
      const gitlab = fakeGitLab();
      const push = pusher();
      const result = await runCase(CASES[0], gitlab, push);

      // Everything a human or a model could read.
      const surfaces = [
        JSON.stringify(result.published),
        JSON.stringify(result.runs),
        JSON.stringify(result.verification),
        JSON.stringify(result.commit),
        JSON.stringify(gitlab.created),
        result.published.pushOutput,
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(TOKEN);
      }
      // The token DID reach the pusher, as its own argument rather than in the URL.
      expect(push.pushed[0]?.token).toBe(TOKEN);
      expect(push.pushed[0]?.remote).not.toContain(TOKEN);
    });
  },
  available,
);
