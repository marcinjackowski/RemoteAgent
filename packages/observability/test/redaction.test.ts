import { describe, expect, it } from "vitest";

import { SecretRedactor } from "../src/redaction.js";

const CANARY = "ra-canary-secret-7d77c1e9";

describe("SecretRedactor", () => {
  it("removes canary secrets from nested logs, errors and serialized context", () => {
    const redactor = new SecretRedactor({ knownSecrets: [CANARY] });
    const error = new Error(`provider rejected Bearer ${CANARY}`);
    error.cause = { refresh_token: CANARY };
    const serialized = redactor.serialize({
      authorization: `Bearer ${CANARY}`,
      nested: [{ message: `failed for ${CANARY}` }, error],
      url: `https://user:${CANARY}@example.test/path?access_token=${CANARY}`,
      safe: "visible",
    });
    expect(serialized).not.toContain(CANARY);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("visible");
  });

  it("redacts sensitive keys even when a concrete value is not registered", () => {
    const redacted = new SecretRedactor().redact({
      client_secret: "unknown-secret",
      password: "unknown-password",
      normal: "okay",
    });
    expect(redacted).toEqual({
      client_secret: "[REDACTED]",
      password: "[REDACTED]",
      normal: "okay",
    });
  });

  it("redacts a bare or suffixed token key without prior registration", () => {
    // AUDIT-01 HIGH-03: a plain `token` key must be treated as sensitive.
    const serialized = new SecretRedactor().serialize({ token: "audit-canary-secret" });
    expect(serialized).toBe('{"token":"[REDACTED]"}');

    const redacted = new SecretRedactor().redact({
      token: "audit-canary-secret",
      id_token: "id-secret",
      "session-token": "sess-secret",
      normal: "okay",
    });
    expect(redacted).toEqual({
      token: "[REDACTED]",
      id_token: "[REDACTED]",
      "session-token": "[REDACTED]",
      normal: "okay",
    });
  });

  it("does not redact token usage metrics as if they were secrets", () => {
    // Observability data (Master Plan §11) must survive redaction.
    const redacted = new SecretRedactor().redact({
      tokens: 3,
      token_count: 42,
      max_tokens: 100,
      prompt_tokens: 12,
      total_tokens: 54,
    });
    expect(redacted).toEqual({
      tokens: 3,
      token_count: 42,
      max_tokens: 100,
      prompt_tokens: 12,
      total_tokens: 54,
    });
  });

  it("does not mutate the input", () => {
    const input = { token: CANARY, nested: { safe: "yes" } };
    new SecretRedactor({ knownSecrets: [CANARY] }).redact(input);
    expect(input).toEqual({ token: CANARY, nested: { safe: "yes" } });
  });
});
