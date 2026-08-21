/**
 * WU-05 — sealed credential-use and explicit fallback selection.
 *
 * The serialization tests are the point of this file. "The credential is sealed" is
 * easy to assert about an interface and hard to assert about an object, so these
 * drive the actual leak channels: `JSON.stringify`, string coercion, template
 * interpolation, `Object.keys`, and `util.inspect` (what a structured logger reaches
 * for). A property-based token passes an interface review and fails these.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  InMemorySealedCredentialBroker,
  TransportKind,
  resolveToolTransport,
} from "../src/credential.js";
import type { ToolTransport } from "../src/transport.js";

const TOKEN = "glpat-SECRETSECRETSECRET1234";

function fakeTransport(label: string): ToolTransport {
  return {
    protocolVersion: async () => "2025-06-18",
    listTools: async () => [{ name: label }],
    call: async (input) => {
      input.onDispatch();
      return { served_by: label };
    },
  };
}

describe("sealed credential-use", () => {
  it("hands the value to a callback and returns the callback's result", async () => {
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    const seen = await broker.use({ connectionId: "conn-1" }, async (secret) => secret.length);
    expect(seen).toBe(TOKEN.length);
  });

  it("exposes no property, getter or key carrying the secret", () => {
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    expect(Object.keys(broker)).toEqual([]);
    expect(Object.values(broker as unknown as Record<string, unknown>)).toEqual([]);
    expect(Object.getOwnPropertyNames(broker)).toEqual([]);
  });

  it("does not leak through JSON.stringify", () => {
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    expect(JSON.stringify(broker)).not.toContain(TOKEN);
    // Also as a nested field, which is how it would appear in a log record.
    expect(JSON.stringify({ broker, event: "tool_call" })).not.toContain(TOKEN);
  });

  it("does not leak through string coercion or interpolation", () => {
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    expect(String(broker)).not.toContain(TOKEN);
    expect(`${broker}`).not.toContain(TOKEN);
  });

  it("does not leak through util.inspect, which is what loggers use", () => {
    // The channel an interface review misses: `inspect` walks private fields.
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    expect(inspect(broker, { depth: 10, showHidden: true })).not.toContain(TOKEN);
  });

  it("throws for an unknown connection rather than yielding an empty secret", async () => {
    // A blank credential would surface as a confusing provider 401 instead of a
    // clear local failure.
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    await expect(
      broker.use({ connectionId: "conn-missing" }, async () => "unreachable"),
    ).rejects.toThrow(/no credential is available/);
  });

  it("offers redaction literals without requiring the caller to hold the secret", () => {
    const broker = new InMemorySealedCredentialBroker({ "conn-1": TOKEN });
    expect(broker.redactionLiterals()).toContain(TOKEN);
  });
});

describe("explicit fallback adapter selection", () => {
  const remote = fakeTransport("remote-mcp");
  const fallback = fakeTransport("first-party");

  it("uses the remote MCP only when the provider is explicitly approved", () => {
    const selection = resolveToolTransport({
      provider: "jira",
      remoteApproved: ["jira"],
      remote,
      fallback,
    });
    expect(selection.kind).toBe(TransportKind.REMOTE_MCP);
    expect(selection.transport).toBe(remote);
  });

  it("falls back when the provider is not approved", () => {
    const selection = resolveToolTransport({
      provider: "gmail",
      remoteApproved: ["jira"],
      remote,
      fallback,
    });
    expect(selection.kind).toBe(TransportKind.FALLBACK_ADAPTER);
    expect(selection.transport).toBe(fallback);
  });

  it("falls back when no remote transport is configured", () => {
    const selection = resolveToolTransport({
      provider: "jira",
      remoteApproved: ["jira"],
      remote: null,
      fallback,
    });
    expect(selection.kind).toBe(TransportKind.FALLBACK_ADAPTER);
  });

  it("never selects an unapproved remote even when one is supplied", () => {
    // The fail-closed direction: approval is the gate, availability is not.
    const selection = resolveToolTransport({
      provider: "calendar",
      remoteApproved: [],
      remote,
      fallback,
    });
    expect(selection.transport).toBe(fallback);
  });

  it("reports which transport served the call so provenance stays legible", async () => {
    // Selection is not automatic failover: an operator must be able to distinguish
    // a remote-MCP read from a first-party read, because the failure modes this
    // task detects are properties of the remote.
    const chosen = resolveToolTransport({
      provider: "gitlab",
      remoteApproved: [],
      remote,
      fallback,
    });
    const served = await chosen.transport.call({
      toolName: "gitlab.read_merge_request",
      arguments: {},
      onDispatch: () => undefined,
      signal: new AbortController().signal,
    });
    expect(served).toEqual({ served_by: "first-party" });
    expect(chosen.kind).toBe(TransportKind.FALLBACK_ADAPTER);
  });
});
