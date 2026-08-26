import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const tempDirectories: string[] = [];
const databaseVariables = [
  "RA_DATABASE_URL",
  "DATABASE_URL",
  "RA_PGHOST",
  "PGHOST",
  "RA_PGPORT",
  "PGPORT",
  "RA_PGUSER",
  "PGUSER",
  "RA_PGPASSWORD",
  "PGPASSWORD",
  "RA_PGDATABASE",
  "PGDATABASE",
] as const;

interface SourceResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
}

function sourceWithProbe(probeBody: string, databaseEnv: NodeJS.ProcessEnv = {}): SourceResult {
  const fakeBin = mkdtempSync(join(tmpdir(), "remoteagent-env-test-"));
  tempDirectories.push(fakeBin);
  const probe = join(fakeBin, "psql");
  const callsPath = join(fakeBin, "calls.log");
  writeFileSync(
    probe,
    `#!/bin/sh
seen_x=0
seen_w=0
seen_query=0
for arg in "$@"; do
  [ "$arg" = "-X" ] && seen_x=1
  [ "$arg" = "-w" ] && seen_w=1
  [ "$arg" = "SELECT 1" ] && seen_query=1
done
[ "$seen_x" = "1" ] && [ "$seen_w" = "1" ] && [ "$seen_query" = "1" ] || exit 90
[ "\${PGCONNECT_TIMEOUT-}" = "2" ] || exit 91
[ "\${PGOPTIONS-}" = "-c statement_timeout=2000" ] || exit 92
printf '%s\\n' "$*" >>"$RA_TEST_PSQL_CALLS"
(${probeBody})
status=$?
[ "$status" = "0" ] && printf '1\\n'
exit "$status"
`,
    "utf8",
  );
  chmodSync(probe, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };
  for (const name of databaseVariables) {
    delete env[name];
  }
  Object.assign(env, databaseEnv);
  env.RA_TEST_EXPECTED_RA_URL = databaseEnv.RA_DATABASE_URL ?? "";
  env.RA_TEST_EXPECTED_DATABASE_URL = databaseEnv.DATABASE_URL ?? "";
  env.RA_TEST_PSQL_CALLS = callsPath;

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -e",
        ". scripts/dev/env.sh",
        '[ "${RA_DATABASE_URL-}" = "${RA_TEST_EXPECTED_RA_URL-}" ] && ra_url=MATCH || ra_url=MISMATCH',
        '[ "${DATABASE_URL-}" = "${RA_TEST_EXPECTED_DATABASE_URL-}" ] && database_url=MATCH || database_url=MISMATCH',
        'printf \'RESULT\\n%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\\n\' "$ra_url" "$database_url" "${RA_PGHOST-}" "${RA_PGPORT-}" "${RA_PGUSER-}" "${RA_PGDATABASE-}" "${PGHOST-}" "${PGPORT-}" "${PGUSER-}" "${PGDATABASE-}"',
      ].join("\n"),
    ],
    { cwd: repoRoot, encoding: "utf8", env },
  );

  const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function resultValues(stdout: string): string[] {
  return stdout
    .slice(stdout.indexOf("RESULT\n") + "RESULT\n".length)
    .trimEnd()
    .split("|");
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("scripts/dev/env.sh PostgreSQL selection", () => {
  it("preserves an explicit database URL without synthesizing discrete overrides", () => {
    const canary = "url-password-canary";
    const url = `postgresql://configured-user:${canary}@example.invalid/configured`;
    const result = sourceWithProbe("true", { RA_DATABASE_URL: url });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pg     up via explicit database URL");
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain("SELECT 1");
    expect(resultValues(result.stdout)).toEqual(["MATCH", "MATCH", "", "", "", "", "", "", "", ""]);
  });

  it("preserves DATABASE_URL as the supported connection-string alias", () => {
    const url = "postgresql://example.invalid/database-url";
    const result = sourceWithProbe("true", { DATABASE_URL: url });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pg     up via explicit database URL");
    expect(result.calls).toHaveLength(1);
    expect(resultValues(result.stdout)).toEqual(["MATCH", "MATCH", "", "", "", "", "", "", "", ""]);
  });

  it("does not fall back after an explicit URL fails its SELECT 1 probe", () => {
    const canary = "unreachable-password-canary";
    const url = `postgresql://configured-user:${canary}@unreachable.invalid/configured`;
    const result = sourceWithProbe("false", { RA_DATABASE_URL: url });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("explicit database URL (unreachable)");
    expect(result.stdout).not.toContain("local fallback");
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
    expect(result.calls).toHaveLength(1);
    expect(resultValues(result.stdout).slice(0, 2)).toEqual(["MATCH", "MATCH"]);
  });

  it("preserves explicit discrete configuration instead of probing local fallbacks", () => {
    const canary = "discrete-password-canary";
    const result = sourceWithProbe('case "$*" in *" -p 6543 "*) true ;; *) false ;; esac', {
      RA_PGHOST: "db.internal",
      RA_PGPORT: "6543",
      RA_PGUSER: "configured-user",
      RA_PGDATABASE: "configured-db",
      RA_PGPASSWORD: canary,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("explicit discrete config (db.internal:6543)");
    expect(resultValues(result.stdout)).toEqual([
      "MATCH",
      "MATCH",
      "db.internal",
      "6543",
      "configured-user",
      "configured-db",
      "",
      "",
      "",
      "",
    ]);
    expect(result.calls).toHaveLength(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
  });

  it("preserves PG variables as the supported discrete aliases", () => {
    const result = sourceWithProbe('case "$*" in *" -p 7654 "*) true ;; *) false ;; esac', {
      PGHOST: "pg.internal",
      PGPORT: "7654",
      PGUSER: "pg-user",
      PGDATABASE: "pg-db",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("explicit discrete config (pg.internal:7654)");
    expect(resultValues(result.stdout)).toEqual([
      "MATCH",
      "MATCH",
      "",
      "",
      "",
      "",
      "pg.internal",
      "7654",
      "pg-user",
      "pg-db",
    ]);
  });

  it("does not fall back after explicit discrete configuration fails SELECT 1", () => {
    const result = sourceWithProbe("false", {
      RA_PGHOST: "unreachable.internal",
      RA_PGPORT: "6543",
      RA_PGUSER: "configured-user",
      RA_PGDATABASE: "configured-db",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "explicit discrete config (unreachable.internal:6543, unreachable)",
    );
    expect(result.stdout).not.toContain("local fallback");
    expect(result.calls).toHaveLength(1);
  });

  it("falls back from the repo default to reachable 5432 using discrete RA_PG variables", () => {
    const result = sourceWithProbe('case "$*" in *" -p 5432 "*) true ;; *) false ;; esac');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pg     up via local fallback 127.0.0.1:5432");
    const values = resultValues(result.stdout);
    expect(values[0]).toBe("MATCH");
    expect(values[1]).toBe("MATCH");
    expect(values[2]).toBe("127.0.0.1");
    expect(values[3]).toBe("5432");
    expect(values[4]).not.toBe("");
    expect(values[5]).toBe("postgres");
    expect(values.slice(6)).toEqual(["", "", "", ""]);
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call.includes("SELECT 1"))).toBe(true);
  });

  it("reports failure and exports no fallback when neither local port is reachable", () => {
    const result = sourceWithProbe("false");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("pg     DOWN");
    expect(result.stderr).toContain("both unreachable");
    expect(result.calls).toHaveLength(2);
    expect(resultValues(result.stdout)).toEqual(["MATCH", "MATCH", "", "", "", "", "", "", "", ""]);
  });
});
