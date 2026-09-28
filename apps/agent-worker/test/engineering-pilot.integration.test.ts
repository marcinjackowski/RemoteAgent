import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Database, resolvePoolConfig } from "@remoteagent/database";
import { afterEach, describe, expect, it, vi } from "vitest";

const scenario = vi.hoisted(() => ({
  runDir: "",
  fail: false,
  calls: 0,
  hold: false,
  release: undefined as (() => void) | undefined,
}));

// Only the external subscription/model boundary is substituted. The pilot, grant,
// DB, SupervisorRuntime, workspace, gates, review binding and Git are the real code.
vi.mock("../src/engineering-model-routing.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/engineering-model-routing.js")>();
  const { EngineeringQualificationTransport } =
    await import("./engineering-qualification-fixture.js");
  return {
    ...original,
    createProductionEngineeringModelRouting: async (
      options: Parameters<typeof original.createProductionEngineeringModelRouting>[0],
    ) => {
      let delegate: InstanceType<typeof EngineeringQualificationTransport> | undefined;
      return original.createProductionEngineeringModelRouting({
        ...options,
        codexPreflight: {
          verify: async ({ profile }) => ({
            status: "SUBSCRIPTION_AUTHENTICATED",
            provider: profile.provider,
            profile_name: profile.profile_name,
            model: profile.model,
            client_version: "0.153.3",
          }),
        },
        createCodexTransport: () => ({
          assertInvocationReady: async () => undefined,
          converse: async (request, config) => {
            scenario.calls++;
            if (scenario.hold && scenario.calls === 1)
              await new Promise<void>((resolve) => {
                scenario.release = resolve;
              });
            if (scenario.fail) throw new Error("PRIVATE-MODEL-FAILURE");
            if (delegate === undefined) {
              const record = JSON.parse(
                await readFile(join(scenario.runDir, "run.json"), "utf8"),
              ) as { case_id: string; run_id: string };
              delegate = new EngineeringQualificationTransport({
                caseId: record.case_id,
                runId: record.run_id,
                sliceIds: ["slice-1"],
                implementationPaths: ["src/qualified.ts"],
                processClass: "SMALL",
              });
            }
            const response = await delegate.converse(request, config);
            return {
              ...response,
              model: config.model,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      });
    },
  };
});

import {
  runEngineeringPilot,
  engineeringPilotStatus,
  stopEngineeringPilot,
  pilotDatabaseConfig,
} from "../src/engineering-pilot.js";
import * as commitObservation from "../src/engineering-commit-observation.js";

const run = promisify(execFile);
const roots: string[] = [];

async function fixture(fail = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra-pilot-integration-")));
  roots.push(root);
  const source = join(root, "source");
  for (const dir of [
    source,
    join(root, "workspaces"),
    join(root, "baselines"),
    join(root, "artifacts"),
  ])
    await mkdir(dir);
  await mkdir(join(source, "src"));
  await writeFile(join(source, "src/base.ts"), "export const base = true;\n");
  await run("git", ["init", "--quiet", "--initial-branch=main", source]);
  await run("git", ["-C", source, "config", "user.name", "Pilot test"]);
  await run("git", ["-C", source, "config", "user.email", "pilot@example.test"]);
  await run("git", ["-C", source, "add", "src"]);
  await run("git", ["-C", source, "commit", "--quiet", "-m", "seed"]);
  const baseSha = (await run("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const executable = await realpath(process.execPath);
  const gateArgs = [
    "-e",
    "const fs=require('fs');require('assert/strict').ok(fs.readFileSync('qualified.ts','utf8').includes('qualified-green'));console.log('assertion passed')",
  ];
  await expect(run(executable, gateArgs, { cwd: join(source, "src") })).rejects.toMatchObject({
    code: 1,
  });
  const configPath = join(root, "engineering.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schema_version: 3,
      workspace_root: join(root, "workspaces"),
      baseline_root: join(root, "baselines"),
      artifact_root: join(root, "artifacts"),
      repository: {
        repository_id: "pilot-test",
        source_path: source,
        base_branch: "main",
        write_path_allowlist: ["src"],
        test_path_allowlist: ["src"],
      },
      executable_allowlist: [executable],
      gates: [
        {
          schema_version: 1,
          gate_id: "qualification",
          gate_class: "TEST",
          gate_tier: "FAST",
          gate_schedule: "EACH_SLICE",
          execution_order: 10,
          executable,
          argv: gateArgs,
          relative_cwd: "src",
          required: true,
          baseline: false,
          test_first: false,
          timeout_ms: 10000,
          environment_profile: "HERMETIC",
          network_profile: "DENY",
          mutable_outputs: [],
          required_test_paths: [],
          required_mutation_paths: ["src/qualified.ts"],
        },
      ],
    }),
  );
  const modelsPath = join(root, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      schema_version: 2,
      profiles: [
        {
          schema_version: 1,
          profile_name: "pilot-test",
          provider: "codex_cli",
          executable,
          model: "pilot-fixture",
          timeout_ms: 10000,
          kill_grace_ms: 100,
          max_stdin_bytes: 1048576,
          max_stdout_bytes: 1048576,
          max_stderr_bytes: 4096,
        },
      ],
      routes: {
        DESIGNER: "pilot-test",
        IMPLEMENTER: "pilot-test",
        REVIEWER: "pilot-test",
        VERIFIER: "pilot-test",
      },
    }),
  );
  const task = join(root, "task.md");
  await writeFile(
    task,
    "Create src/qualified.ts with exported qualification value qualified-green; use the qualification gate.\n",
  );
  scenario.runDir = join(root, "run");
  scenario.fail = fail;
  scenario.calls = 0;
  scenario.hold = false;
  scenario.release = undefined;
  return {
    root,
    source,
    baseSha,
    options: {
      command: "run" as const,
      config: configPath,
      models: modelsPath,
      task,
      approve: true,
      runDir: scenario.runDir,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const allocationFiles = (await readdir(root, { recursive: true })).filter((path) =>
      path.endsWith("allocation.json"),
    );
    for (const path of allocationFiles) {
      const allocation = JSON.parse(await readFile(join(root, path), "utf8")) as {
        database: string;
      };
      expect(allocation.database).toMatch(/^ra_pilot_[a-f0-9]{32}$/u);
      const base = resolvePoolConfig();
      if (base.connectionString) {
        const url = new URL(base.connectionString);
        url.pathname = "/postgres";
        base.connectionString = url.toString();
      } else base.database = "postgres";
      const admin = new Database(base);
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${allocation.database}" WITH (FORCE)`);
      } finally {
        await admin.close();
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("pilot real production composition, fake model boundary only", () => {
  it("requires approval on a valid task before model dispatch or allocation", async () => {
    const setup = await fixture();
    const outcome = await runEngineeringPilot({ ...setup.options, approve: false }).catch(
      (error: unknown) => error,
    );
    expect(scenario.calls).toBe(0);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("E_APPROVAL_REQUIRED");
    await expect(readFile(join(scenario.runDir, "allocation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects a dirty source before allocation and model activity", async () => {
    const setup = await fixture();
    await writeFile(join(setup.source, "untracked.txt"), "owner work");
    await expect(runEngineeringPilot(setup.options)).rejects.toThrow("E_SOURCE_DIRTY");
    expect(scenario.calls).toBe(0);
    await expect(readFile(join(scenario.runDir, "allocation.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(setup.source, "untracked.txt"), "utf8")).toBe("owner work");
  });

  it.each(["source", "workspaces", "baselines", "artifacts"])(
    "rejects run directories inside %s including a symlinked parent",
    async (rootName) => {
      const setup = await fixture();
      const alias = join(setup.root, "alias");
      await symlink(join(setup.root, rootName), alias);
      await expect(
        runEngineeringPilot({ ...setup.options, runDir: join(alias, "new", "run") }),
      ).rejects.toThrow("E_SCOPE");
      expect(scenario.calls).toBe(0);
      await expect(readFile(join(alias, "new", "run", "allocation.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains setup failure and releases its lock before any model call", async () => {
    const setup = await fixture();
    await expect(
      runEngineeringPilot({ ...setup.options, models: join(setup.root, "missing-models.json") }),
    ).rejects.toThrow();
    const result = JSON.parse(await readFile(join(scenario.runDir, "result.json"), "utf8"));
    expect(result.outcome).toBe("FAILED");
    expect(scenario.calls).toBe(0);
    await expect(
      readFile(join(setup.root, "workspaces/.engineering-pilot.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["command", "SIGINT", "SIGTERM"] as const)(
    "durably cancels an active run through %s and rejects a concurrent writer",
    async (method) => {
      const setup = await fixture();
      scenario.hold = true;
      const beforeInt = process.listenerCount("SIGINT");
      const beforeTerm = process.listenerCount("SIGTERM");
      const running = runEngineeringPilot(setup.options).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await vi.waitFor(() => expect(scenario.release).toBeTypeOf("function"), { timeout: 10000 });
        const record = JSON.parse(await readFile(join(scenario.runDir, "run.json"), "utf8")) as {
          run_id: string;
        };
        expect(
          (await engineeringPilotStatus(scenario.runDir, record.run_id)).status
            ?.cancellation_requested,
        ).toBe(false);
        const concurrent = await runEngineeringPilot({
          ...setup.options,
          runDir: join(setup.root, "concurrent"),
        }).catch((error: unknown) => error);
        expect(scenario.calls).toBe(1);
        expect(concurrent).toBeInstanceOf(Error);
        expect((concurrent as Error).message).toBe("E_PILOT_BUSY");
        if (method === "command")
          expect((await stopEngineeringPilot(scenario.runDir, record.run_id)).status).toBe(
            "stopped",
          );
        else {
          process.emit(method);
          process.emit(method);
        }
        await vi.waitFor(
          async () =>
            expect(
              (await engineeringPilotStatus(scenario.runDir, record.run_id)).status
                ?.cancellation_requested,
            ).toBe(true),
          { timeout: 10000 },
        );
        scenario.release!();
        await running;
        const result = JSON.parse(await readFile(join(scenario.runDir, "result.json"), "utf8"));
        expect(result.outcome).not.toBe("COMPLETED");
        expect(result.commit_sha).toBeUndefined();
        expect(scenario.calls).toBe(1);
        expect(process.listenerCount("SIGINT")).toBe(beforeInt);
        expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
        expect((await run("git", ["-C", setup.source, "rev-parse", "HEAD"])).stdout.trim()).toBe(
          setup.baseSha,
        );
      } finally {
        scenario.release?.();
        await running;
      }
    },
    30000,
  );

  it("creates an observed reviewed commit and preserves source plus usable status", async () => {
    const setup = await fixture();
    await runEngineeringPilot(setup.options);
    const record = JSON.parse(await readFile(join(scenario.runDir, "run.json"), "utf8")) as {
      run_id: string;
      case_id: string;
      database: string;
    };
    const result = JSON.parse(await readFile(join(scenario.runDir, "result.json"), "utf8")) as {
      outcome: string;
      commit_sha: string;
      worktree_path: string;
      job_id: string;
    };
    expect(result.outcome).toBe("COMPLETED");
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(
      (await run("git", ["-C", result.worktree_path, "rev-parse", "HEAD"])).stdout.trim(),
    ).toBe(result.commit_sha);
    const db = new Database(pilotDatabaseConfig(resolvePoolConfig(), record.database));
    try {
      expect(
        (
          await db.query<{ status: string }>("SELECT status FROM jobs WHERE job_id=$1", [
            result.job_id,
          ])
        ).rows[0]?.status,
      ).toBe("SUCCEEDED");
    } finally {
      await db.close();
    }
    expect(scenario.calls).toBeGreaterThan(0);
    const status = await engineeringPilotStatus(scenario.runDir, record.run_id);
    expect(status.status.current_stage).toBe("LOCAL_COMMIT");
    expect(status.status.cancellation_requested).toBe(false);
    expect((await run("git", ["-C", setup.source, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      setup.baseSha,
    );
    expect((await run("git", ["-C", setup.source, "status", "--porcelain"])).stdout.trim()).toBe(
      "",
    );
    const { readdir } = await import("node:fs/promises");
    const journalRoot = join(setup.root, "artifacts/engineering-debug");
    const files = await readdir(journalRoot);
    const summaries = files.filter((file) => file.endsWith(".summary.md"));
    expect(summaries).toHaveLength(1);
    expect(await readFile(join(journalRoot, summaries[0]!), "utf8")).toContain("COMPLETED");
  }, 60000);

  it("does not claim success when actual commit observation is refused", async () => {
    const setup = await fixture();
    const observation = vi
      .spyOn(commitObservation, "observeEngineeringLiveCommit")
      .mockRejectedValue(new Error("E_TEST_OBSERVATION"));
    await expect(runEngineeringPilot(setup.options)).rejects.toThrow("E_TEST_OBSERVATION");
    expect(observation).toHaveBeenCalledOnce();
    expect(observation.mock.calls[0]?.[1]).toBe(setup.baseSha);
    const result = JSON.parse(await readFile(join(scenario.runDir, "result.json"), "utf8"));
    expect(result.outcome).not.toBe("COMPLETED");
    expect(result.commit_sha).toBeUndefined();
  }, 60000);

  it("retains failed run evidence and supports durable stop without claiming a commit", async () => {
    const setup = await fixture(true);
    await runEngineeringPilot(setup.options).catch(() => undefined);
    const record = JSON.parse(await readFile(join(scenario.runDir, "run.json"), "utf8")) as {
      run_id: string;
    };
    const result = JSON.parse(await readFile(join(scenario.runDir, "result.json"), "utf8")) as {
      outcome: string;
      run_id: string;
      commit_sha?: string;
    };
    expect(result.outcome).not.toBe("COMPLETED");
    expect(result.run_id).toBe(record.run_id);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-MODEL-FAILURE");
    expect(result.commit_sha ?? null).toBeNull();
    expect(scenario.calls).toBeGreaterThan(0);
    expect(await engineeringPilotStatus(scenario.runDir, record.run_id)).toBeTruthy();
    expect(
      await stopEngineeringPilot(scenario.runDir, record.run_id, "pilot-stop-test"),
    ).toMatchObject({ status: "stopped" });
    expect((await run("git", ["-C", setup.source, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      setup.baseSha,
    );
  }, 60000);
});
