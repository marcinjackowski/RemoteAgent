import { describe, expect, it } from "vitest";

import { SecretRedactor } from "../src/redaction.js";
import { SECRET_PATTERNS, containsSecretShape, maskSecretShapes } from "../src/secret-patterns.js";

/**
 * The `CTF-006` probe, promoted from a coordinator's throwaway script to a test.
 *
 * Every line below was a documented LEAK: the finding's evidence block lists these
 * exact strings with `NIE ZREDAGOWANO` against them. They are asserted here rather
 * than described so the finding cannot silently reopen — which is the whole reason
 * `CTF-006` was rated HIGH: the mechanism was partial while reading as total.
 */
const CTF_006_LEAKS: readonly (readonly [string, string])[] = [
  ["absolute macOS host path", "error at /Users/marcinjackowski/Private/RemoteAgent/packages"],
  ["absolute linux host path", "cwd=/home/runner/work/secret-project"],
  ["GitLab personal access token", "glpat-ABCDEFGHIJKLMNOPQRST"],
  ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
  ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----"],
  ["compact JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlXw"],
];

/** Shapes the original `SecretRedactor` already covered; they must stay covered. */
const PREEXISTING_COVERAGE: readonly (readonly [string, string])[] = [
  ["bearer token", "authorization: Bearer abcdefghijklmnop"],
  ["basic auth", "authorization: Basic dXNlcjpwYXNzd29yZA=="],
  ["URL userinfo", "https://user:hunter2@gitlab.example.test/repo.git"],
  ["query-string token", "GET /api?access_token=abcdef123456&page=1"],
  ["assignment", "client_secret=super-secret-value"],
];

/** Shapes added in RA-024 that no previous table knew about. */
const NEWLY_COVERED: readonly (readonly [string, string])[] = [
  ["email PII", "contact owner@example.test now"],
  ["international phone PII", "call +48 501 234 567 now"],
  ["google refresh token", "refresh=1//0eXaMpLeToKeNvAlUe123"],
  ["google access token", "ya29.a0AfB_byC-example-token-value"],
  ["github fine-grained PAT", "github_pat_11ABCDEFG0abcdefghij"],
  ["slack bot token", "xoxb-123456789012-abcdefghijkl"],
  ["windows drive path", 'opening "C:\\Users\\marcin\\secrets.txt" failed'],
  ["file URI", "source file:///Users/marcin/private/notes.md"],
  ["truncated PEM header", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r"],
];

describe("shared secret patterns (CTF-006)", () => {
  it.each(CTF_006_LEAKS)("masks the documented CTF-006 leak: %s", (_name, leak) => {
    const masked = maskSecretShapes(leak);
    expect(masked).not.toBe(leak);
    expect(containsSecretShape(leak)).toBe(true);
  });

  it.each(PREEXISTING_COVERAGE)("keeps preexisting coverage: %s", (_name, value) => {
    expect(maskSecretShapes(value)).not.toBe(value);
  });

  it.each(NEWLY_COVERED)("covers newly added shape: %s", (_name, value) => {
    expect(maskSecretShapes(value)).not.toBe(value);
  });

  it("removes the secret material, not merely some characters", () => {
    // A pattern that matched but replaced too little would still pass a
    // `not.toBe(input)` assertion, so the sensitive substring is checked directly.
    expect(maskSecretShapes("token is glpat-ABCDEFGHIJKLMNOPQRST here")).not.toContain(
      "ABCDEFGHIJKLMNOPQRST",
    );
    expect(maskSecretShapes("key AKIAIOSFODNN7EXAMPLE used")).not.toContain("IOSFODNN7EXAMPLE");
    expect(maskSecretShapes("at /Users/marcin/Private/RemoteAgent/x.ts:1")).not.toContain(
      "marcin/Private",
    );
    expect(
      maskSecretShapes(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----",
      ),
    ).not.toContain("MIIEowIBAAKCAQ");
  });

  it("keeps the prefix so a reader can see WHAT was removed", () => {
    expect(maskSecretShapes("authorization: Bearer abcdefghijklmnop")).toBe(
      "authorization: Bearer [REDACTED]",
    );
    expect(maskSecretShapes("https://user:hunter2@example.test/x")).toBe(
      "https://[REDACTED]example.test/x",
    );
  });

  it("masks EVERY occurrence, not just the first", () => {
    // A pattern missing the `g` flag passes a single-occurrence test and leaks the
    // rest of the line, which is the shape of half-measure this module removes.
    const twice = "a glpat-AAAAAAAAAAAAAAAAAAAA b glpat-BBBBBBBBBBBBBBBBBBBB";
    const masked = maskSecretShapes(twice);
    expect(masked).not.toContain("AAAAAAAAAAAAAAAAAAAA");
    expect(masked).not.toContain("BBBBBBBBBBBBBBBBBBBB");
  });

  it("every pattern carries the global flag", () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.flags).toContain("g");
    }
  });

  it("is safe to call repeatedly despite the shared stateful regexes", () => {
    // `g`-flagged regexes carry `lastIndex`. `String.replace` resets it, but this is
    // load-bearing enough to assert: the frozen array is shared across every caller
    // in the repository, so a leak here would be intermittent and near-undebuggable.
    const value = "token glpat-ABCDEFGHIJKLMNOPQRST at /Users/x/y";
    const first = maskSecretShapes(value);
    for (let i = 0; i < 5; i += 1) {
      expect(maskSecretShapes(value)).toBe(first);
    }
  });

  it("leaves ordinary text alone", () => {
    const benign = "planner discovered 3 commands in package.json and ran pnpm test";
    expect(maskSecretShapes(benign)).toBe(benign);
    expect(containsSecretShape(benign)).toBe(false);
  });

  it("does not treat a relative workspace path as a host path", () => {
    // Workspace-relative paths are the normal, non-sensitive shape in tool output;
    // masking them would make every payload unreadable and push callers to disable
    // redaction entirely.
    const relative = "modified src/index.ts and packages/policy/src/scope.ts";
    expect(maskSecretShapes(relative)).toBe(relative);
  });

  it("does not treat token usage metrics as secrets", () => {
    const metrics = "usage: input_tokens 120, output_tokens 45, total_tokens 165";
    expect(maskSecretShapes(metrics)).toBe(metrics);
  });
});

describe("SecretRedactor consumes the shared table (CTF-006 reachability)", () => {
  it("masks CTF-006 shapes with NO knownSecrets registered", () => {
    // This is the exact construction in `agent-orchestrator/src/context/compaction.ts`,
    // which builds MODEL CONTEXT. `CTF-006` rated the finding HIGH because that call
    // site is reachable in already-accepted code, so the no-argument constructor is
    // what has to be proven, not the configured one.
    const redactor = new SecretRedactor();
    for (const [, leak] of CTF_006_LEAKS) {
      expect(redactor.redactString(leak)).not.toBe(leak);
    }
  });

  it("masks CTF-006 shapes nested inside objects, arrays and errors", () => {
    const redactor = new SecretRedactor();
    const error = new Error("failed at /Users/marcin/Private/RemoteAgent/src/x.ts");
    const serialized = redactor.serialize({
      trace: [{ path: "/home/runner/work/repo" }, error],
      gitlab: "glpat-ABCDEFGHIJKLMNOPQRST",
      safe: "visible",
    });
    expect(serialized).not.toContain("ABCDEFGHIJKLMNOPQRST");
    expect(serialized).not.toContain("/home/runner/work/repo");
    expect(serialized).not.toContain("marcin/Private");
    expect(serialized).toContain("visible");
  });
});
