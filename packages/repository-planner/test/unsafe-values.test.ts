import { describe, expect, it } from "vitest";
import type { DiscoveredCommand, InstructionFact, RepositoryFact } from "@remoteagent/contracts";

import { buildRepositoryProfile, type BuildRepositoryProfileInput } from "../src/profile.js";

/**
 * `unsafeString` moved from a private six-regex table in `profile.ts` to the shared
 * `@remoteagent/observability` table (`CTF-006`, RA-024-WU-01).
 *
 * A shared predicate is only safe here if it is at least as strict as the one it
 * replaced. This suite pins the shapes the private table caught, so a future change
 * to the shared table cannot quietly make the profile builder more permissive —
 * which would be a silent fail-open in the one place that is deliberately
 * fail-closed. `profile.test.ts` already covers the builder's other behaviour; this
 * file covers only the `UNSAFE_DATA` boundary.
 */
const identity = { caseId: "case-1", workspaceId: "workspace-1" } as const;
const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const instruction = (path: string, precedence: number): InstructionFact => ({
  provenance: { relative_path: path, digest, trust: "UNTRUSTED_DATA" },
  scope: precedence === 0 ? "ROOT" : "NESTED",
  precedence,
  content: { trust: "UNTRUSTED_DATA", value: `instruction ${path}` },
});

const command = (name: string): DiscoveredCommand => ({
  kind: "TEST",
  name,
  argv: [name],
  provenance: { relative_path: "package.json", digest, trust: "UNTRUSTED_DATA" },
});

const fact = (kind: string): RepositoryFact => ({
  kind,
  provenance: { relative_path: `${kind}.json`, digest, trust: "UNTRUSTED_DATA" },
  value: { trust: "UNTRUSTED_DATA", value: `fact ${kind}` },
});

function input(overrides: Partial<BuildRepositoryProfileInput> = {}): BuildRepositoryProfileInput {
  return {
    repositoryId: "repo-1",
    baseSha: sha,
    contractVersion: "contracts-v1",
    generatedAt: "2026-08-20T10:00:00.000Z",
    expectedWorkspaceIdentity: identity,
    snapshot: {
      operationId: "snapshot-case-1-workspace-1",
      identity,
      lifecycle: "SNAPSHOTTED",
      treeDigest: digest,
      dirtyState: "CLEAN",
    },
    instructions: [instruction("AGENTS.md", 0)],
    discoveredCommands: [command("test")],
    facts: [fact("manifest")],
    ...overrides,
  };
}

function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** The six host-path / key shapes the private table caught. */
const HOST_AND_KEY_SHAPES: readonly (readonly [string, string])[] = [
  ["macOS host path", "/Users/marcin/Private/RemoteAgent"],
  ["linux host path", "/home/runner/work/repo"],
  ["tmp host path", "/tmp/scratch-dir"],
  ["private host path", "/private/var/folders/x"],
  ["windows drive path", "C:\\Users\\marcin\\repo"],
  ["file URI", "file:///Users/marcin/x"],
  ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----"],
];

/** The credential shapes the private table caught. */
const CREDENTIAL_SHAPES: readonly (readonly [string, string])[] = [
  ["assignment", "access_token=abcdefghijklmnop"],
  ["bearer", "Bearer abcdefghijklmnop"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.c2lnbmF0dXJlXw"],
  ["GitLab PAT", "glpat-ABCDEFGHIJKLMNOPQRST"],
  ["GitHub token", "ghp_ABCDEFGHIJKLMNOPQRST"],
  ["AWS key id", "AKIAIOSFODNN7EXAMPLE"],
];

describe("profile rejects unsafe values via the shared table (CTF-006)", () => {
  it("builds a clean profile", () => {
    expect(thrownCode(() => buildRepositoryProfile(input()))).toBeUndefined();
  });

  it.each([...HOST_AND_KEY_SHAPES, ...CREDENTIAL_SHAPES])(
    "still rejects %s in the contract version",
    (_name, unsafe) => {
      // Asserted on the CODE, not merely on "it threw": a different failure
      // (INVALID_INPUT from an id parse) would otherwise pass this test while the
      // secret check was gone. That is the `CTF-010` finding-1 pattern.
      expect(thrownCode(() => buildRepositoryProfile(input({ contractVersion: unsafe })))).toBe(
        "UNSAFE_DATA",
      );
    },
  );

  it("rejects an unsafe value appended to an otherwise valid field", () => {
    expect(
      thrownCode(() => buildRepositoryProfile(input({ contractVersion: "v1 /Users/marcin/leak" }))),
    ).toBe("UNSAFE_DATA");
  });

  it("rejects an unsafe value in the workspace identity, not only the version", () => {
    expect(
      thrownCode(() =>
        buildRepositoryProfile(
          input({
            expectedWorkspaceIdentity: { caseId: "case-1", workspaceId: "/Users/marcin/ws" },
            snapshot: {
              operationId: "snapshot-case-1-workspace-1",
              identity: { caseId: "case-1", workspaceId: "/Users/marcin/ws" },
              lifecycle: "SNAPSHOTTED",
              treeDigest: digest,
              dirtyState: "CLEAN",
            },
          }),
        ),
      ),
    ).toBe("UNSAFE_DATA");
  });

  it("does not reject a workspace-relative path", () => {
    // The builder must stay usable: relative paths are the normal shape of a
    // profile's own data, and rejecting them would make every profile fail closed.
    expect(
      thrownCode(() => buildRepositoryProfile(input({ contractVersion: "contracts-src/index.ts" }))),
    ).toBeUndefined();
  });
});
