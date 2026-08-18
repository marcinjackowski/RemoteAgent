import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * These specs prove the repo's compile-time guardrails are actually enforced by
 * running the real tools against deliberately-broken fixtures and asserting they
 * fail with the expected diagnostic. If someone weakens `strict` or removes the
 * dependency-boundary rule, one of these specs turns red.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const bin = (name: string): string => join(repoRoot, "node_modules", ".bin", name);

interface RunResult {
  status: number | null;
  output: string;
}

/** Run a command expecting a non-zero exit; capture combined output. */
function runExpectingFailure(cmd: string, args: string[]): RunResult {
  try {
    execFileSync(cmd, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    return { status: 0, output: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: e.status ?? null,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("strict TypeScript guardrail", () => {
  it("rejects implicit any under the shared strict base config", () => {
    const result = runExpectingFailure(bin("tsc"), [
      "-p",
      "test/guardrails/fixtures/strict/tsconfig.json",
    ]);
    expect(result.status).not.toBe(0);
    // TS7006 == "Parameter implicitly has an 'any' type" (noImplicitAny).
    expect(result.output).toContain("TS7006");
  });
});

describe("dependency-boundary guardrail", () => {
  it("rejects an app importing another app", () => {
    const result = runExpectingFailure(bin("eslint"), [
      "--no-config-lookup",
      "-c",
      "test/guardrails/fixtures/boundary/eslint.config.mjs",
      "test/guardrails/fixtures/boundary/src",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("boundaries/dependencies");
  });
});
