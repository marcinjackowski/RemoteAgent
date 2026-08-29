import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeConfig, RuntimeRequest, RuntimeTransport } from "@remoteagent/bedrock-runtime";
import type {
  SubscriptionAuthPreflight,
  SubscriptionModelProfileV1,
  SubscriptionModelProviderKind,
  SubscriptionModelRole,
} from "@remoteagent/model-runtime";
import { afterEach, expect, it } from "vitest";

import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import {
  EngineeringDebugJournal,
  createEngineeringDebugTransport,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";
import { engineeringModelRoleForStage } from "../src/engineering-execution.js";
import {
  createProductionEngineeringModelRouting,
  type EngineeringModelRoleBinding,
  type ProductionEngineeringModelRouting,
} from "../src/engineering-model-routing.js";
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";
import {
  EngineeringQualificationTransport,
  createEngineeringQualificationFixture,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const run = promisify(execFile);
const available = await ensurePostgres();
const roots: string[] = [];
const fixtures: EngineeringQualificationFixture[] = [];
const riskFacts = Object.freeze({
  authority: "SERVER_OWNED" as const,
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
});

type Routes = Readonly<Record<SubscriptionModelRole, "claude-local" | "codex-local">>;
type ProviderCall = Readonly<{
  provider: SubscriptionModelProviderKind;
  profileName: string;
  schema: string | null;
}>;

async function deploymentFile(routes: Routes): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "ra-engineering-role-matrix-"));
  const root = await realpath(created);
  roots.push(root);
  const path = join(root, "models.json");
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 2,
      profiles: [
        {
          schema_version: 1,
          profile_name: "claude-local",
          provider: "claude_code",
          executable: process.execPath,
          model: "claude-opus-4-8",
          timeout_ms: 30_000,
          kill_grace_ms: 100,
          max_stdin_bytes: 65_536,
          max_stdout_bytes: 65_536,
          max_stderr_bytes: 4096,
        },
        {
          schema_version: 1,
          profile_name: "codex-local",
          provider: "codex_cli",
          executable: process.execPath,
          model: "gpt-5.6-codex",
          timeout_ms: 30_000,
          kill_grace_ms: 100,
          max_stdin_bytes: 65_536,
          max_stdout_bytes: 65_536,
          max_stderr_bytes: 4096,
        },
      ],
      routes,
    }),
  );
  return path;
}

function authenticatedPreflight(): SubscriptionAuthPreflight {
  return {
    verify: async ({ profile }) => ({
      status: "SUBSCRIPTION_AUTHENTICATED",
      provider: profile.provider,
      profile_name: profile.profile_name,
      client_version: profile.provider === "codex_cli" ? "0.147.0" : "2.1.250",
      model: profile.model,
    }),
  };
}

async function routedModels(input: {
  routes: Routes;
  delegate: RuntimeTransport;
  calls: ProviderCall[];
  readiness?: Partial<Record<SubscriptionModelProviderKind, boolean>>;
  quotaFailure?: SubscriptionModelProviderKind;
}): Promise<ProductionEngineeringModelRouting> {
  const makeTransport = (profile: SubscriptionModelProfileV1) => ({
    converse: async (request: RuntimeRequest, config: RuntimeConfig) => {
      input.calls.push({
        provider: profile.provider,
        profileName: profile.profile_name,
        schema: request.outputSchema?.name ?? null,
      });
      if (input.quotaFailure === profile.provider) {
        throw new Error(`SUBSCRIPTION_QUOTA_UNAVAILABLE:${profile.provider}`);
      }
      const response = await input.delegate.converse(request, config);
      return {
        ...response,
        model: config.model,
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      };
    },
    assertInvocationReady: async () => {
      if (input.readiness?.[profile.provider] === false) {
        throw new Error(`SUBSCRIPTION_AUTH_REQUIRED:${profile.provider}`);
      }
    },
  });
  const path = await deploymentFile(input.routes);
  return createProductionEngineeringModelRouting({
    configPath: path,
    codexPreflight: authenticatedPreflight(),
    claudePreflight: authenticatedPreflight(),
    createCodexTransport: ({ profile }) => makeTransport(profile),
    createClaudeTransport: ({ profile }) => makeTransport(profile),
  });
}

function mediumTransport(
  fixture: EngineeringQualificationFixture,
): EngineeringQualificationTransport {
  return new EngineeringQualificationTransport({
    caseId: fixture.ids.caseId,
    runId: fixture.ids.runId,
    sliceIds: ["slice-1", "slice-2"],
    implementationPaths: ["src/one.ts", "src/one.ts", "src/two.ts"],
    reviewOutcomes: ["CHANGES_REQUIRED", "PASS", "PASS"],
    processClass: "MEDIUM",
  });
}

async function artifactSummary(fixture: EngineeringQualificationFixture) {
  return fixture.db.query<{
    artifact_kind: string;
    stage_attempt: number;
    slice_id: string | null;
    decision: string | null;
  }>(
    `SELECT artifact_kind,stage_attempt,payload->>'slice_id' AS slice_id,
            payload->>'decision' AS decision
       FROM engineering_artifact_revisions
      WHERE run_id=$1 ORDER BY revision`,
    [fixture.ids.runId],
  );
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.drop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeIntegration(
  "RA-052 production Engineering role routing",
  () => {
    it.each([
      {
        label: "Codex designer/reviewer and Claude implementer/verifier",
        routes: {
          DESIGNER: "codex-local",
          IMPLEMENTER: "claude-local",
          REVIEWER: "codex-local",
          VERIFIER: "claude-local",
        } as const,
      },
      {
        label: "Claude designer/reviewer and Codex implementer/verifier",
        routes: {
          DESIGNER: "claude-local",
          IMPLEMENTER: "codex-local",
          REVIEWER: "claude-local",
          VERIFIER: "codex-local",
        } as const,
      },
    ])("runs two slices, correction, review and one commit with $label", async ({ routes }) => {
      const fixture = await createEngineeringQualificationFixture({
        id: `roles-${routes.DESIGNER.split("-")[0]}`,
      });
      fixtures.push(fixture);
      const transport = mediumTransport(fixture);
      const calls: ProviderCall[] = [];
      const routing = await routedModels({ routes, delegate: transport, calls });
      const lease = await fixture.claimImplementer();
      const journal = await EngineeringDebugJournal.create({
        artifactRoot: fixture.config.artifactRoot,
        invocationId: `${fixture.ids.runId}-roles`,
      });
      const production = fixture.makeProduction(lease, {
        transport,
        modelRouting: routing,
        decorateTransport: (binding: EngineeringModelRoleBinding) =>
          createEngineeringDebugTransport(binding.transport, {
            role: binding.role,
            invocation: binding.invocation,
          }),
        policy: { riskFacts },
      });
      await runWithEngineeringDebugJournal(journal, () =>
        production.handler(lease, async () => undefined),
      );
      await journal.close();

      const artifacts = await artifactSummary(fixture);
      expect(
        artifacts.rows
          .filter((row) => row.artifact_kind === "SliceImplementationReceipt")
          .map((row) => [row.stage_attempt, row.slice_id]),
      ).toEqual([
        [1, "slice-1"],
        [2, "slice-1"],
        [3, "slice-2"],
      ]);
      expect(
        artifacts.rows
          .filter((row) => row.artifact_kind === "ReviewDecision")
          .map((row) => row.decision),
      ).toEqual(["CHANGES_REQUIRED", "PASS", "PASS"]);
      expect(
        artifacts.rows.filter((row) => row.artifact_kind === "LocalCommitReceipt"),
      ).toHaveLength(1);
      const workspacePath = join(
        fixture.config.workspaceConfig.workspaceRoot,
        fixture.ids.caseId,
        verticalSliceWorkspaceId(fixture.ids.caseId),
      );
      expect(
        (
          await run("git", ["-C", workspacePath, "rev-list", "--count", `${fixture.baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");

      const intents = await fixture.db.query<{
        stage: string;
        descriptor: { model_invocation?: Record<string, unknown> };
      }>(
        `SELECT o.stage,i.descriptor
           FROM engineering_operations o JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id=$1 ORDER BY o.recorded_at,o.operation_id`,
        [fixture.ids.runId],
      );
      for (const row of intents.rows) {
        const role = engineeringModelRoleForStage(row.stage as never);
        if (role === null) {
          expect(row.descriptor.model_invocation).toBeUndefined();
        } else {
          expect(row.descriptor.model_invocation).toEqual(routing.forRole(role).invocation);
        }
      }

      const records = (await readFile(journal.filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const usage = records.filter((record) => record.event === "MODEL_USAGE");
      expect(new Set(usage.map((record) => record.role))).toEqual(
        new Set(["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"]),
      );
      expect(
        usage
          .filter((record) => record.role === "IMPLEMENTER" || record.role === "REVIEWER")
          .every(
            (record) => typeof record.slice_id === "string" && typeof record.attempt === "number",
          ),
      ).toBe(true);
      expect(usage.every((record) => record.response_total_tokens === 150)).toBe(true);
      expect(usage.every((record) => typeof record.invocation_digest === "string")).toBe(true);
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain(process.execPath);
      expect(serialized).not.toContain("qualify the production engineering path");
      expect(calls.some((call) => call.provider === "codex_cli")).toBe(true);
      expect(calls.some((call) => call.provider === "claude_code")).toBe(true);
    });

    it("supports all-Codex and all-Claude routes without a hidden fallback", async () => {
      for (const profile of ["codex-local", "claude-local"] as const) {
        const calls: ProviderCall[] = [];
        const delegate: RuntimeTransport = {
          converse: async () => {
            throw new Error("route construction must not call a model");
          },
        };
        const routing = await routedModels({
          routes: {
            DESIGNER: profile,
            IMPLEMENTER: profile,
            REVIEWER: profile,
            VERIFIER: profile,
          },
          delegate,
          calls,
        });
        expect(
          new Set(
            (["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"] as const).map(
              (role) => routing.forRole(role).invocation.profile_name,
            ),
          ),
        ).toEqual(new Set([profile]));
        expect(calls).toHaveLength(0);
      }
    });

    it("blocks auth loss and quota refusal without calling the other provider", async () => {
      for (const failure of ["AUTH", "QUOTA"] as const) {
        const fixture = await createEngineeringQualificationFixture({ id: `roles-${failure}` });
        fixtures.push(fixture);
        const transport = mediumTransport(fixture);
        const calls: ProviderCall[] = [];
        const readiness = { codex_cli: true, claude_code: true };
        const routing = await routedModels({
          routes: {
            DESIGNER: "codex-local",
            IMPLEMENTER: "claude-local",
            REVIEWER: "codex-local",
            VERIFIER: "claude-local",
          },
          delegate: transport,
          calls,
          readiness,
          ...(failure === "QUOTA" ? { quotaFailure: "codex_cli" as const } : {}),
        });
        if (failure === "AUTH") readiness.codex_cli = false;
        const lease = await fixture.claimImplementer();
        const production = fixture.makeProduction(lease, {
          transport,
          modelRouting: routing,
          policy: { riskFacts },
        });
        await expect(production.handler(lease, async () => undefined)).rejects.toThrow();
        expect(calls.filter((call) => call.provider === "claude_code")).toHaveLength(0);
        expect(
          (
            await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [
              fixture.ids.caseId,
            ])
          ).rowCount,
        ).toBe(0);
      }
    });

    it("rejects a stale lease before either provider or workspace can run", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "roles-stale" });
      fixtures.push(fixture);
      const transport = mediumTransport(fixture);
      const calls: ProviderCall[] = [];
      const routing = await routedModels({
        routes: {
          DESIGNER: "codex-local",
          IMPLEMENTER: "claude-local",
          REVIEWER: "codex-local",
          VERIFIER: "claude-local",
        },
        delegate: transport,
        calls,
      });
      const lease = await fixture.claimImplementer();
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      const production = fixture.makeProduction(lease, {
        transport,
        modelRouting: routing,
        policy: { riskFacts },
      });
      await expect(production.handler(lease, async () => undefined)).rejects.toThrow();
      expect(calls).toHaveLength(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [fixture.ids.caseId]))
          .rowCount,
      ).toBe(0);
    });

    it("keeps two concurrent cases and their provider routes isolated", async () => {
      const left = await createEngineeringQualificationFixture({ id: "roles-concurrent-left" });
      const right = await createEngineeringQualificationFixture({ id: "roles-concurrent-right" });
      fixtures.push(left, right);
      const leftCalls: ProviderCall[] = [];
      const rightCalls: ProviderCall[] = [];
      const leftTransport = new EngineeringQualificationTransport({
        caseId: left.ids.caseId,
        runId: left.ids.runId,
        sliceIds: ["slice-1", "slice-2"],
        implementationPaths: ["src/left.ts", "src/left-two.ts"],
        processClass: "MEDIUM",
      });
      const rightTransport = new EngineeringQualificationTransport({
        caseId: right.ids.caseId,
        runId: right.ids.runId,
        sliceIds: ["slice-1", "slice-2"],
        implementationPaths: ["src/right.ts", "src/right-two.ts"],
        processClass: "MEDIUM",
      });
      const [leftRouting, rightRouting] = await Promise.all([
        routedModels({
          routes: {
            DESIGNER: "codex-local",
            IMPLEMENTER: "claude-local",
            REVIEWER: "codex-local",
            VERIFIER: "claude-local",
          },
          delegate: leftTransport,
          calls: leftCalls,
        }),
        routedModels({
          routes: {
            DESIGNER: "claude-local",
            IMPLEMENTER: "codex-local",
            REVIEWER: "claude-local",
            VERIFIER: "codex-local",
          },
          delegate: rightTransport,
          calls: rightCalls,
        }),
      ]);
      const [leftLease, rightLease] = await Promise.all([
        left.claimImplementer(),
        right.claimImplementer(),
      ]);
      const leftProduction = left.makeProduction(leftLease, {
        transport: leftTransport,
        modelRouting: leftRouting,
        policy: { riskFacts },
      });
      const rightProduction = right.makeProduction(rightLease, {
        transport: rightTransport,
        modelRouting: rightRouting,
        policy: { riskFacts },
      });
      await Promise.all([
        leftProduction.handler(leftLease, async () => undefined),
        rightProduction.handler(rightLease, async () => undefined),
      ]);
      expect(
        (await artifactSummary(left)).rows.some(
          (row) => row.artifact_kind === "LocalCommitReceipt",
        ),
      ).toBe(true);
      expect(
        (await artifactSummary(right)).rows.some(
          (row) => row.artifact_kind === "LocalCommitReceipt",
        ),
      ).toBe(true);
      expect(new Set(leftCalls.map((call) => call.profileName))).toEqual(
        new Set(["codex-local", "claude-local"]),
      );
      expect(new Set(rightCalls.map((call) => call.profileName))).toEqual(
        new Set(["codex-local", "claude-local"]),
      );
      expect(
        leftTransport.requests.every((request) =>
          JSON.stringify(request).includes(left.ids.caseId),
        ),
      ).toBe(true);
      expect(
        rightTransport.requests.every((request) =>
          JSON.stringify(request).includes(right.ids.caseId),
        ),
      ).toBe(true);
    });
  },
  available,
);
