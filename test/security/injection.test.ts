import { TrustLevel } from "@remoteagent/contracts";
import { neutralizeMentions, sanitizeMessage } from "@remoteagent/discord";
import { isProtectedPath } from "@remoteagent/implementation-tools";
import { describe, expect, it } from "vitest";

/**
 * Prompt injection and exfiltration containment (RA-024-WU-03, AC3).
 *
 * WHAT THIS SUITE DOES NOT TEST: whether hostile text can be recognised. Detection
 * is explicitly not a control (`THREAT_MODEL.md`, "out of scope"), because it fails
 * against any adversary willing to rephrase. Containment here is STRUCTURAL — the
 * model has no authority, so a fully successful injection obtains nothing.
 *
 * `cross-account.test.ts` covers the authority half (scope and policy refusals).
 * This file covers the two surfaces an injection uses when it cannot get authority:
 *
 *   1. rewriting the agent's OWN instructions, so a later run is told to cooperate;
 *   2. pushing content outward through a channel that is not an "action" at all —
 *      a Discord message the owner reads, a thread name, a mention that pings.
 *
 * Both were real findings (`CTF-009`, and the RA-006 mention work), which is why
 * they get a suite rather than a paragraph.
 */

/** Injection payloads, each aimed at a specific structural control. */
const INSTRUCTION_FILES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
  // Nested, because an injection that cannot write the root file will try a
  // subdirectory whose instructions still apply to that subtree.
  "packages/policy/AGENTS.md",
  "docs/CLAUDE.md",
  // Case is not a defence: filesystems differ, and the model chooses the casing.
  "agents.md",
  "Claude.MD",
  // Separator tricks. `a//.git/b` and `a/.git/b` must not differ.
  "packages//policy//AGENTS.md",
  "packages\\policy\\CLAUDE.md",
];

const CREDENTIAL_FILES: readonly string[] = [
  ".env",
  ".env.local",
  ".git/config",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "deploy.pem",
  "server.key",
  "cert.p12",
  "bundle.pfx",
  "config/credentials",
  "infra/secrets/prod",
];

describe("AC3: an injection cannot reach the agent's own instructions", () => {
  it.each(INSTRUCTION_FILES)("protects %s", (path) => {
    // Privilege escalation by way of an ordinary file write: a model that rewrites
    // AGENTS.md edits the contract a later run is given. `CTF-009` found that
    // `isForbiddenPath` (RA-011) does NOT cover these — deliberately, since the
    // planner must read them — so the model-facing layer carries its own gate rather
    // than inheriting one.
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each(CREDENTIAL_FILES)("protects %s", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it("does not over-protect ordinary files that merely resemble instructions", () => {
    // Over-protection is a real cost, not a safe default: a gate that hides half the
    // repository makes the agent useless and invites someone to widen it wholesale.
    // `AGENTS.md` is protected; `docs/agents-guide.md` is not.
    for (const ordinary of [
      "docs/agents-guide.md",
      "src/claude-client.ts",
      "README.md",
      "packages/policy/src/scope.ts",
      "test/security/injection.test.ts",
      "environment.ts",
      "tokenizer.ts",
    ]) {
      expect(isProtectedPath(ordinary), `${ordinary} should not be protected`).toBe(false);
    }
  });

  it("protects a path whether or not it exists", () => {
    // The decision is syntactic and applied BEFORE filesystem access. Otherwise a
    // file could be protected only once created — so the first write, the one that
    // creates a hostile `AGENTS.md`, would be the one that slipped through.
    expect(isProtectedPath("does/not/exist/AGENTS.md")).toBe(true);
  });
});

describe("AC3: exfiltration through the owner-facing channel", () => {
  const CANARY_MENTIONS = [
    "@everyone",
    "@here",
    "<@123456789012345678>",
    "<@!123456789012345678>",
    "<@&987654321098765432>",
  ];

  it.each(CANARY_MENTIONS)("neutralises %s so provider text cannot ping", (mention) => {
    // An injection that cannot obtain an action can still make the SYSTEM shout at
    // people, by putting a mass mention in a Jira comment the status message quotes.
    // The channel is the owner's, so the message carries our authority, not theirs.
    const rendered = neutralizeMentions(`untrusted said: ${mention} deploy now`);
    expect(rendered).not.toContain("@everyone");
    expect(rendered).not.toContain("@here");
    expect(rendered).not.toMatch(/<@[!&]?\d+>/);
  });

  it("neutralises by INSERTING a zero-width space, so the text survives", () => {
    // Worth stating precisely, because the mechanism looks like the attack. The
    // defence is to insert U+200B after the `@`, which stops Discord resolving the
    // mention while leaving the text readable. So `@everyone` in, `@​everyone`
    // out — and a test that strips zero-width spaces before asserting is testing
    // nothing, which is exactly the mistake this case is written to prevent.
    const rendered = neutralizeMentions("@everyone deploy now");
    expect(rendered).not.toContain("@everyone");
    expect(rendered).toBe("@​everyone deploy now");
  });

  it("is idempotent, so re-sanitising already-safe text does not corrupt it", () => {
    // Status messages are rebuilt and re-sent on retry. A neutraliser that inserted
    // another marker each pass would accumulate them until the message was unreadable
    // or exceeded the length limit.
    const once = neutralizeMentions("@everyone @here <@123456789012345678>");
    expect(neutralizeMentions(once)).toBe(once);
  });

  it("keeps the surrounding text readable after neutralisation", () => {
    // Containment must leave the owner able to read what happened; deleting the
    // message would hide the injection attempt itself.
    const rendered = neutralizeMentions("issue MOBL-1 says: @everyone please review");
    expect(rendered).toContain("MOBL-1");
    expect(rendered).toContain("please review");
  });

  it("clamps a hostile oversized message instead of failing the send", () => {
    // A megabyte of provider text is a denial vector against the OWNER's channel:
    // either the send fails (the owner learns nothing) or the channel is flooded.
    const chunks = sanitizeMessage("A".repeat(50_000));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("neutralises mentions in every chunk of a split message", () => {
    // The subtle case: sanitisation applied before splitting can leave a mention in
    // a later chunk, or a split can reassemble one across a boundary.
    const hostile = `${"x".repeat(1990)}@everyone${"y".repeat(1990)}`;
    for (const chunk of sanitizeMessage(hostile)) {
      expect(chunk).not.toContain("@everyone");
    }
  });
});

describe("AC3: untrusted content stays marked as untrusted", () => {
  it("the trust vocabulary has no implicit default", () => {
    // The type system forces a marker, so a contract cannot accidentally treat
    // provider text as trusted (RA-002 AC5). Asserted because "no default" is the
    // property, and a future added default would be silent.
    expect(Object.values(TrustLevel)).toEqual(["TRUSTED", "UNTRUSTED_DATA"]);
  });

  it("TRUSTED means 'produced by our code', never 'safe to act on'", () => {
    // Recorded as an executable statement of the distinction rather than a comment:
    // trust is orthogonal to authority. Even TRUSTED content cannot set scope, which
    // is why the policy engine takes no caller-supplied tier or decision.
    expect(TrustLevel.TRUSTED).not.toBe(TrustLevel.UNTRUSTED_DATA);
  });
});
