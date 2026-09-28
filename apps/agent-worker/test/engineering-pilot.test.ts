import { describe, expect, it } from "vitest";
import {
  parseEngineeringPilotArgs,
  parsePilotRecord,
  pilotDatabaseConfig,
  runEngineeringPilot,
} from "../src/engineering-pilot.js";

const root = "/tmp/engineering-pilot";
const args = [
  "run",
  `--run-dir=${root}`,
  "--config=/tmp/c.json",
  "--models=/tmp/models.json",
  "--task-file=/tmp/task.md",
  "--approve-local-write",
];
const database = "ra_pilot_0123456789abcdef0123456789abcdef";
const record = {
  schema_version: 1,
  run_id: "run_01234567-89ab-cdef-0123-456789abcdef",
  case_id: "case_01234567-89ab-4def-8123-456789abcdef",
  owner_id: "owner_01234567-89ab-4def-8123-456789abcdea",
  database,
  config_path: "/tmp/config.json",
  task_path: "/tmp/task.md",
  artifact_root: "/tmp/artifacts",
  workspace_root: "/tmp/workspaces",
  journal_root: "/tmp/artifacts/engineering-debug",
  created_at: "2026-09-14T12:00:00.000Z",
};

describe("engineering pilot operator boundary", () => {
  it("requires explicit approval and an owner task for run", () => {
    expect(() =>
      parseEngineeringPilotArgs([
        "run",
        `--run-dir=${root}`,
        "--config=/tmp/c.json",
        "--task-file=/tmp/t.md",
      ]),
    ).toThrow("E_APPROVAL_REQUIRED");
    expect(parseEngineeringPilotArgs(args).approve).toBe(true);
  });

  it("rejects unknown and duplicate options", () => {
    expect(() =>
      parseEngineeringPilotArgs([
        "run",
        `--run-dir=${root}`,
        "--config=/tmp/c.json",
        "--task-file=/tmp/t",
        "--approve-local-write",
        "--wat=1",
      ]),
    ).toThrow("E_USAGE");
    expect(() =>
      parseEngineeringPilotArgs([
        "run",
        `--run-dir=${root}`,
        "--config=/tmp/c.json",
        "--config=/tmp/other.json",
        "--task-file=/tmp/t",
        "--approve-local-write",
      ]),
    ).toThrow("E_USAGE");
  });

  it("does not accept caller-selected identity on a new run", () => {
    expect(() =>
      parseEngineeringPilotArgs([
        "run",
        `--run-dir=${root}`,
        "--config=/tmp/c.json",
        "--task-file=/tmp/t",
        "--approve-local-write",
        "--run-id=x",
      ]),
    ).toThrow("E_USAGE");
  });

  it("allows status and stop to use only the private run identity", () => {
    expect(
      parseEngineeringPilotArgs(["status", `--run-dir=${root}`, "--run-id=pilot_abc"]).config,
    ).toBe("");
    expect(
      parseEngineeringPilotArgs(["stop", `--run-dir=${root}`, "--run-id=pilot_abc"]).runId,
    ).toBe("pilot_abc");
  });
});

describe("pilot identity and database isolation", () => {
  it("refuses missing approval before config access or DB/model activity", async () => {
    await expect(
      runEngineeringPilot({
        command: "run",
        config: "/does-not-exist",
        runDir: root,
        task: "/also-does-not-exist",
        models: "/no-models",
        approve: false,
      }),
    ).rejects.toThrow("E_APPROVAL_REQUIRED");
  });
  it("requires explicit model routing", () => {
    expect(() =>
      parseEngineeringPilotArgs(args.filter((arg) => !arg.startsWith("--models="))),
    ).toThrow();
  });
  it("rejects missing model routing before touching config or creating a database", async () => {
    await expect(
      runEngineeringPilot({
        command: "run",
        config: "/does-not-exist",
        runDir: root,
        task: "/also-does-not-exist",
        approve: true,
      }),
    ).rejects.toThrow("E_MODELS");
  });
  it("accepts the complete private identity record", () => {
    expect(parsePilotRecord(record)).toEqual(record);
  });
  it.each([
    { ...record, database: "postgres" },
    { ...record, database: 'ra_pilot_bad"; DROP DATABASE postgres;--' },
    { ...record, owner_id: undefined },
    { ...record, case_id: undefined },
    { ...record, artifact_root: "../../escape" },
    { ...record, additional_secret: "not-allowed" },
  ])("rejects malformed private record %#", (invalid) => {
    expect(() => parsePilotRecord(invalid)).toThrow();
  });
  it("pins the isolated database in a configured URL without mutating its source", () => {
    const base = {
      connectionString:
        "postgresql://user:private-password@localhost:5432/production?sslmode=disable",
    };
    const configured = pilotDatabaseConfig(base, database);
    expect(new URL(configured.connectionString!).pathname).toBe(`/${database}`);
    expect(new URL(configured.connectionString!).searchParams.get("sslmode")).toBe("disable");
    expect(base.connectionString).toContain("/production?");
  });
  it("pins the isolated database for discrete PG config", () => {
    expect(
      pilotDatabaseConfig(
        { host: "localhost", port: 5432, user: "pilot", database: "production" },
        database,
      ),
    ).toMatchObject({ host: "localhost", port: 5432, user: "pilot", database });
    expect(() => pilotDatabaseConfig({}, "postgres")).toThrow();
  });
});
