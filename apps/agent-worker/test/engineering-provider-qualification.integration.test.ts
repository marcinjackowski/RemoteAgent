import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import type {
  RuntimeConfig,
  RuntimeRequest,
  RuntimeTransport,
  SubscriptionAuthPreflight,
  SubscriptionModelProfileV1,
} from "@remoteagent/model-runtime";
import { afterEach, expect, it } from "vitest";

import {
  ensurePostgres,
  describeIntegration,
} from "../../../packages/database/test/integration-base.js";
import {
  createEngineeringDebugTransport,
  EngineeringDebugJournal,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";
import {
  createEngineeringQualificationReport,
  engineeringQualificationReportV1,
} from "../src/engineering-qualification.js";
import {
  createProductionEngineeringModelRouting,
  type EngineeringModelRoleBinding,
} from "../src/engineering-model-routing.js";
import {
  createEngineeringQualificationFixture,
  EngineeringQualificationTransport,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const available = await ensurePostgres();
const fixtures: EngineeringQualificationFixture[] = [];
const roots: string[] = [];
const roles = ["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"] as const;
const scenarioDigest = canonicalDigest({
  seed: "ra-053-provider-matrix-v1",
  objective: "execute the same bounded two-slice correction scenario",
  gates: ["qualification"],
});
const policy = Object.freeze({
  riskFacts: {
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
  },
});

type Profile = "claude-local" | "codex-local";

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

async function routing(input: {
  delegate: RuntimeTransport;
  implementer: Profile;
  reviewer: Profile;
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra-053-qualification-")));
  roots.push(root);
  const configPath = join(root, "models.json");
  const routes = {
    DESIGNER: input.reviewer,
    IMPLEMENTER: input.implementer,
    REVIEWER: input.reviewer,
    VERIFIER: input.implementer,
  } as const;
  await writeFile(
    configPath,
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
  const makeTransport = (profile: SubscriptionModelProfileV1) => ({
    converse: async (request: RuntimeRequest, config: RuntimeConfig) => {
      const response = await input.delegate.converse(request, config);
      return {
        ...response,
        model: { provider: profile.provider, model_id: profile.model },
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      };
    },
    assertInvocationReady: async () => undefined,
  });
  return createProductionEngineeringModelRouting({
    configPath,
    codexPreflight: authenticatedPreflight(),
    claudePreflight: authenticatedPreflight(),
    createCodexTransport: ({ profile }) => makeTransport(profile),
    createClaudeTransport: ({ profile }) => makeTransport(profile),
  });
}

function usageFrom(
  records: readonly Record<string, unknown>[],
  modelRouting: Awaited<ReturnType<typeof routing>>,
) {
  return roles.map((role) => {
    const entries = records.filter(
      (record) => record.event === "MODEL_USAGE" && record.role === role,
    );
    const sum = (key: string) =>
      entries.reduce(
        (total, entry) => total + (typeof entry[key] === "number" ? entry[key] : 0),
        0,
      );
    return {
      role,
      invocation_digest: canonicalDigest(modelRouting.forRole(role).invocation),
      responses: entries.length,
      input_tokens: sum("response_input_tokens"),
      output_tokens: sum("response_output_tokens"),
      total_tokens: sum("response_total_tokens"),
      responses_without_usage: entries.filter((entry) => entry.provider_reported === false).length,
    };
  });
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.drop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeIntegration(
  "RA-053 subscription provider qualification",
  () => {
    it("runs all four implementer/reviewer combinations and emits exact content-free reports", async () => {
      const reports = [];
      for (const [implementer, reviewer] of [
        ["codex-local", "codex-local"],
        ["codex-local", "claude-local"],
        ["claude-local", "codex-local"],
        ["claude-local", "claude-local"],
      ] as const) {
        const fixture = await createEngineeringQualificationFixture({
          id: `ra053-${implementer.split("-")[0]}-${reviewer.split("-")[0]}`,
        });
        fixtures.push(fixture);
        const delegate = new EngineeringQualificationTransport({
          caseId: fixture.ids.caseId,
          runId: fixture.ids.runId,
          sliceIds: ["slice-1", "slice-2"],
          implementationPaths: ["src/one.ts", "src/one.ts", "src/two.ts"],
          reviewOutcomes: ["CHANGES_REQUIRED", "PASS", "PASS"],
          processClass: "MEDIUM",
        });
        const modelRouting = await routing({ delegate, implementer, reviewer });
        const lease = await fixture.claimImplementer();
        const journal = await EngineeringDebugJournal.create({
          artifactRoot: fixture.config.artifactRoot,
          invocationId: `${fixture.ids.runId}-ra053`,
        });
        const production = fixture.makeProduction(lease, {
          transport: delegate,
          modelRouting,
          decorateTransport: (binding: EngineeringModelRoleBinding) =>
            createEngineeringDebugTransport(binding.transport, {
              role: binding.role,
              invocation: binding.invocation,
            }),
          policy,
        });
        const started = Date.now();
        await runWithEngineeringDebugJournal(journal, () =>
          production.handler(lease, async () => undefined),
        );
        const elapsedMs = Date.now() - started;
        await journal.close();
        const records = (await readFile(journal.filePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const artifacts = await fixture.db.query<{
          artifact_kind: string;
          payload: {
            cumulative_paths?: string[];
            diff_digest?: string;
            commit_sha?: string;
          };
        }>(
          `SELECT artifact_kind,payload FROM engineering_artifact_revisions
            WHERE run_id=$1 ORDER BY revision`,
          [fixture.ids.runId],
        );
        const commit = artifacts.rows.find((row) => row.artifact_kind === "LocalCommitReceipt");
        const implementation = artifacts.rows
          .filter((row) => row.artifact_kind === "SliceImplementationReceipt")
          .at(-1);
        const gateAttempts = await fixture.db.query(
          `SELECT 1 FROM engineering_operations
            WHERE run_id=$1 AND stage='GATE_EXECUTION'`,
          [fixture.ids.runId],
        );
        reports.push(
          createEngineeringQualificationReport({
            schema_version: 1,
            scenario_digest: scenarioDigest,
            outcome: "SUCCEEDED",
            routes: Object.fromEntries(
              roles.map((role) => [role, modelRouting.forRole(role).invocation]),
            ) as never,
            gate_attempts: gateAttempts.rowCount,
            review_attempts: artifacts.rows.filter((row) => row.artifact_kind === "ReviewDecision")
              .length,
            elapsed_ms: elapsedMs,
            usage: usageFrom(records, modelRouting),
            changed_paths: implementation?.payload.cumulative_paths ?? [],
            diff_digest: commit?.payload.diff_digest ?? null,
            commit_sha: commit?.payload.commit_sha ?? null,
          }),
        );
      }

      expect(reports).toHaveLength(4);
      expect(new Set(reports.map((report) => report.scenario_digest))).toEqual(
        new Set([scenarioDigest]),
      );
      expect(new Set(reports.map((report) => JSON.stringify(report.changed_paths)))).toEqual(
        new Set([JSON.stringify(["src/one.ts", "src/two.ts"])]),
      );
      expect(new Set(reports.map((report) => report.diff_digest))).toHaveLength(1);
      expect(reports.every((report) => report.review_attempts === 3)).toBe(true);
      expect(reports.every((report) => report.gate_attempts > 0)).toBe(true);
      expect(reports.every((report) => report.commit_sha !== null)).toBe(true);
      expect(
        new Set(
          reports.map(
            (report) => `${report.routes.IMPLEMENTER.provider}:${report.routes.REVIEWER.provider}`,
          ),
        ),
      ).toEqual(
        new Set([
          "codex_cli:codex_cli",
          "codex_cli:claude_code",
          "claude_code:codex_cli",
          "claude_code:claude_code",
        ]),
      );
      expect(
        reports.every((report) => engineeringQualificationReportV1.safeParse(report).success),
      ).toBe(true);
      expect(
        engineeringQualificationReportV1.safeParse({
          ...reports[0]!,
          elapsed_ms: reports[0]!.elapsed_ms + 1,
        }).success,
      ).toBe(false);
      expect(JSON.stringify(reports)).not.toContain("execute bounded slices");
      expect(JSON.stringify(reports)).not.toContain(process.execPath);
    }, 240_000);

    it("rejects a report whose usage is detached from its exact route identity", () => {
      const invocation = {
        schema_version: 1,
        role: "DESIGNER",
        provider: "codex_cli",
        profile_name: "codex-local",
        client_version: "0.147.0",
        model: "gpt-5.6-codex",
        executable_digest: canonicalDigest("codex"),
        deployment_config_digest: canonicalDigest("deployment"),
        profile_config_digest: canonicalDigest("profile"),
      } as const;
      const routes = Object.fromEntries(
        roles.map((role) => [role, { ...invocation, role }]),
      ) as never;
      expect(() =>
        createEngineeringQualificationReport({
          schema_version: 1,
          scenario_digest: scenarioDigest,
          outcome: "REFUSED",
          routes,
          gate_attempts: 0,
          review_attempts: 0,
          elapsed_ms: 1,
          usage: roles.map((role) => ({
            role,
            invocation_digest: canonicalDigest("wrong route"),
            responses: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            responses_without_usage: 0,
          })),
          changed_paths: [],
          diff_digest: null,
          commit_sha: null,
        }),
      ).toThrow(/usage invocation identity mismatch/u);

      const valid = createEngineeringQualificationReport({
        schema_version: 1,
        scenario_digest: scenarioDigest,
        outcome: "REFUSED",
        routes,
        gate_attempts: 0,
        review_attempts: 0,
        elapsed_ms: 1,
        usage: roles.map((role) => ({
          role,
          invocation_digest: canonicalDigest(routes[role]),
          responses: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          responses_without_usage: 0,
        })),
        changed_paths: [],
        diff_digest: null,
        commit_sha: null,
      });
      expect(engineeringQualificationReportV1.safeParse({ ...valid, elapsed_ms: 2 }).success).toBe(
        false,
      );
    });
  },
  available,
);
