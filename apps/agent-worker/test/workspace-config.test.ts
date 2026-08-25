/**
 * RA-034 WU-02: workspaceConfigFromEnv — server-owned workspace allowlist parsed from env, with the
 * two fail-closed shapes (absent → null; present-but-invalid → throw).
 */
import { describe, expect, it } from "vitest";

import { workspaceConfigFromEnv } from "../src/workspace-config.js";

const base = {
  RA_WORKSPACE_ROOT: "/srv/ws",
  RA_WORKSPACE_REPO_ID: "sondermind-ios",
  RA_WORKSPACE_REPO_PATH: "/Users/o/Sondermind/sondermind-client-native-ios",
  RA_WORKSPACE_BASE_BRANCH: "main",
};

describe("workspaceConfigFromEnv", () => {
  it("parses a single-repo allowlist", () => {
    expect(workspaceConfigFromEnv(base)).toEqual({
      workspaceRoot: "/srv/ws",
      repositories: {
        "sondermind-ios": {
          sourcePath: "/Users/o/Sondermind/sondermind-client-native-ios",
          baseBranch: "main",
        },
      },
    });
  });

  it("defaults the base branch to main", () => {
    const { RA_WORKSPACE_BASE_BRANCH, ...noBranch } = base;
    void RA_WORKSPACE_BASE_BRANCH;
    expect(workspaceConfigFromEnv(noBranch).repositories["sondermind-ios"]!.baseBranch).toBe("main");
  });

  it("returns null when RA_WORKSPACE_ROOT is absent (provisioning not configured)", () => {
    expect(workspaceConfigFromEnv({})).toBeNull();
    expect(workspaceConfigFromEnv({ RA_WORKSPACE_REPO_ID: "x", RA_WORKSPACE_REPO_PATH: "/a" })).toBeNull();
  });

  it("throws on a relative workspace root", () => {
    expect(() => workspaceConfigFromEnv({ ...base, RA_WORKSPACE_ROOT: "relative/ws" })).toThrow(
      "absolute path",
    );
  });

  it("throws on a relative repo source path", () => {
    expect(() => workspaceConfigFromEnv({ ...base, RA_WORKSPACE_REPO_PATH: "rel/repo" })).toThrow(
      "absolute path",
    );
  });

  it("throws on a malformed repo id (charset must match the runner path policy)", () => {
    expect(() => workspaceConfigFromEnv({ ...base, RA_WORKSPACE_REPO_ID: "bad/id" })).toThrow(
      "RA_WORKSPACE_REPO_ID",
    );
  });

  it("throws when the root is set but the repo is not (misconfiguration, not 'no repos')", () => {
    expect(() => workspaceConfigFromEnv({ RA_WORKSPACE_ROOT: "/srv/ws" })).toThrow(
      "RA_WORKSPACE_REPO_ID/RA_WORKSPACE_REPO_PATH",
    );
  });
});
