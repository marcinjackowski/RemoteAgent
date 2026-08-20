import { describe, expect, it } from "vitest";
import {
  repositoryProfile,
  type DiscoveredCommand,
  type InstructionFact,
  type RepositoryFact,
} from "@remoteagent/contracts";
import {
  buildRepositoryProfile,
  RepositoryProfileBuildError,
  type BuildRepositoryProfileInput,
} from "../src/profile.js";
import { canonicalJson } from "../src/digest.js";

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
    instructions: [instruction("nested/AGENTS.md", 1), instruction("AGENTS.md", 0)],
    discoveredCommands: [command("lint"), command("test")],
    facts: [fact("manifest"), fact("readme")],
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

describe("RepositoryProfile builder", () => {
  it("is deterministic across permutations and excludes generatedAt from digests", () => {
    const first = buildRepositoryProfile(input());
    const second = buildRepositoryProfile(
      input({
        generatedAt: "2026-08-21T10:00:00.000Z",
        instructions: [instruction("AGENTS.md", 0), instruction("nested/AGENTS.md", 1)],
        discoveredCommands: [command("test"), command("lint")],
        facts: [fact("readme"), fact("manifest")],
      }),
    );
    expect(first.profile.profile_id).toBe(second.profile.profile_id);
    expect(first.profileDigest).toBe(second.profileDigest);
    expect(first.bindingDigest).toBe(second.bindingDigest);
    expect(first.profile.generated_at).not.toBe(second.profile.generated_at);
    expect(repositoryProfile.parse(first.profile)).toEqual(first.profile);
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it("fails closed for foreign/dirty snapshots and invalid digests or provenance", () => {
    expect(() =>
      buildRepositoryProfile(
        input({ expectedWorkspaceIdentity: { ...identity, caseId: "foreign" } }),
      ),
    ).toThrowError(
      new RepositoryProfileBuildError(
        "INVALID_INPUT",
        "Workspace identity does not match the expected identity",
      ),
    );
    expect(
      thrownCode(() =>
        buildRepositoryProfile(input({ snapshot: { ...input().snapshot, dirtyState: "DIRTY" } })),
      ),
    ).toBe("SNAPSHOT_NOT_CLEAN");
    expect(
      thrownCode(() =>
        buildRepositoryProfile(input({ snapshot: { ...input().snapshot, lifecycle: "RESUMED" } })),
      ),
    ).toBe("SNAPSHOT_NOT_CLEAN");
    expect(
      thrownCode(() =>
        buildRepositoryProfile(
          input({ snapshot: { ...input().snapshot, treeDigest: "not-a-digest" } }),
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      thrownCode(() =>
        buildRepositoryProfile(input({ instructions: [instruction("/private/AGENTS.md", 0)] })),
      ),
    ).toBe("INVALID_INPUT");
    expect(thrownCode(() => buildRepositoryProfile(input({ instructions: [] })))).toBe(
      "INCOMPLETE_PROFILE",
    );
  });

  it("rejects obvious credentials/private keys without rejecting legal tool names", () => {
    expect(() => buildRepositoryProfile(input({ facts: [fact("tokenizer")] }))).not.toThrow();
    expect(
      thrownCode(() =>
        buildRepositoryProfile(
          input({
            facts: [
              {
                ...fact("credentials"),
                value: { trust: "UNTRUSTED_DATA", value: "token=secret-value" },
              },
            ],
          }),
        ),
      ),
    ).toBe("UNSAFE_DATA");
    expect(
      thrownCode(() =>
        buildRepositoryProfile(
          input({
            facts: [
              {
                ...fact("key"),
                value: { trust: "UNTRUSTED_DATA", value: "-----BEGIN PRIVATE KEY-----" },
              },
            ],
          }),
        ),
      ),
    ).toBe("UNSAFE_DATA");
    for (const value of [
      "Authorization: Bearer abcdefghijklmnop",
      "eyJabcdefghijklmnop.abcdefghijkl.abcdefghijkl",
      "glpat-abcdefghijklmnop",
      "ghp_abcdefghijklmnop",
      "AKIAABCDEFGHIJKLMNOP",
    ]) {
      expect(
        thrownCode(() =>
          buildRepositoryProfile(
            input({ facts: [{ ...fact("external"), value: { trust: "UNTRUSTED_DATA", value } }] }),
          ),
        ),
      ).toBe("UNSAFE_DATA");
    }
  });

  it("sorts elements with equal primary fields by their full canonical value", () => {
    const first = buildRepositoryProfile(
      input({
        discoveredCommands: [
          { ...command("same"), argv: ["z"] },
          { ...command("same"), argv: ["a"] },
        ],
      }),
    );
    const second = buildRepositoryProfile(
      input({
        discoveredCommands: [
          { ...command("same"), argv: ["a"] },
          { ...command("same"), argv: ["z"] },
        ],
      }),
    );
    expect(first.profileDigest).toBe(second.profileDigest);
    expect(first.bindingDigest).toBe(second.bindingDigest);
  });

  it("deep-freezes the profile result and preserves its digests", () => {
    const result = buildRepositoryProfile(input());
    const profileDigest = result.profileDigest;
    const bindingDigest = result.bindingDigest;
    const mutable = result as unknown as {
      profile: { instructions: Array<{ content: { value: string } }> };
      snapshotBinding: { identity: { caseId: string } };
    };

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(Object.isFrozen(result.profile.instructions)).toBe(true);
    expect(Object.isFrozen(result.profile.instructions[0]?.content)).toBe(true);
    expect(Object.isFrozen(result.snapshotBinding)).toBe(true);
    expect(Object.isFrozen(result.snapshotBinding.identity)).toBe(true);
    expect(() => {
      mutable.profile.instructions[0]!.content.value = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (result.profile.facts[0]!.value as { value: string }).value = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      mutable.snapshotBinding.identity.caseId = "foreign";
    }).toThrow(TypeError);
    expect(result.profileDigest).toBe(profileDigest);
    expect(result.bindingDigest).toBe(bindingDigest);
  });
});
