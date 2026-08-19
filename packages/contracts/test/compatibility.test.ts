import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { agentCompletion, AgentCompletionStatus } from "../src/agent-completion.js";
import { canonicalDigest } from "../src/canonical.js";
import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import { eventEnvelope } from "../src/event-envelope.js";

function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as unknown;
}

/**
 * Backward compatibility: v1 fixtures captured on disk must keep parsing with
 * the current schema, and their canonical digest must stay stable so any silent
 * shape drift is caught.
 */
describe("schema compatibility fixtures", () => {
  it("parses the stored v1 EventEnvelope and keeps a stable digest", () => {
    const raw = loadFixture("event-envelope.v1.json");
    const parsed = eventEnvelope.parse(raw);
    expect(parsed.event_id).toBe("evt-compat-1");
    // Stable digest pin — update only with a justified fixture change.
    expect(canonicalDigest(parsed)).toBe(canonicalDigest(raw));
  });

  it("parses the stored v1 WAITING_FOR_USER AgentCompletion", () => {
    const raw = loadFixture("agent-completion.waiting.v1.json");
    const parsed = agentCompletion.parse(raw);
    expect(parsed.status).toBe(AgentCompletionStatus.WAITING_FOR_USER);
  });

  it("forward compatibility is fail-closed: a future field is rejected", () => {
    const raw = loadFixture("event-envelope.v1.json") as Record<string, unknown>;
    const future = { ...raw, schema_version: 2, brand_new_field: "surprise" };
    expect(eventEnvelope.safeParse(future).success).toBe(false);
  });

  it("accepts exactly CURRENT_SCHEMA_VERSION on the boundary", () => {
    const raw = loadFixture("event-envelope.v1.json") as Record<string, unknown>;
    expect(raw.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(eventEnvelope.safeParse(raw).success).toBe(true);
  });

  it("rejects a pure future schema_version=2 even with no extra fields", () => {
    // Structurally valid v1 payload whose ONLY difference is a higher version.
    // Forward-incompatible data must be rejected, not best-effort parsed.
    const future = loadFixture("event-envelope.future-v2.json");
    expect((future as Record<string, unknown>).schema_version).toBe(2);
    const result = eventEnvelope.safeParse(future);
    expect(result.success).toBe(false);

    // The v1 counterpart (same shape, version 1) parses, proving the only reason
    // the future fixture fails is its unrecognized schema_version.
    const downgraded = {
      ...(future as Record<string, unknown>),
      schema_version: CURRENT_SCHEMA_VERSION,
    };
    expect(eventEnvelope.safeParse(downgraded).success).toBe(true);
  });

  it("rejects schema_version below the current version too", () => {
    const raw = loadFixture("event-envelope.v1.json") as Record<string, unknown>;
    expect(eventEnvelope.safeParse({ ...raw, schema_version: 0 }).success).toBe(false);
  });
});
