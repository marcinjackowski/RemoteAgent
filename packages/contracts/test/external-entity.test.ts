import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import { eventEnvelope } from "../src/event-envelope.js";
import { externalEntityRef, Provider, ExternalEntityKind } from "../src/external-entity.js";

/**
 * Closed provider→kind matrix (single source of truth mirrored from the
 * contract). A ref may only pair a provider with one of its own kinds; every
 * other pair is a cross-provider identity and must fail closed in both the
 * standalone `ExternalEntityRef` and the nested `EventEnvelope.entity_ref`.
 */
const ALLOWED: Record<Provider, readonly ExternalEntityKind[]> = {
  [Provider.JIRA]: [ExternalEntityKind.JIRA_ISSUE],
  [Provider.GMAIL]: [ExternalEntityKind.GMAIL_THREAD, ExternalEntityKind.GMAIL_MESSAGE],
  [Provider.CALENDAR]: [ExternalEntityKind.CALENDAR_EVENT],
  [Provider.GITLAB]: [
    ExternalEntityKind.GITLAB_PROJECT,
    ExternalEntityKind.GITLAB_BRANCH,
    ExternalEntityKind.GITLAB_MERGE_REQUEST,
    ExternalEntityKind.GITLAB_PIPELINE,
  ],
  [Provider.DISCORD]: [ExternalEntityKind.DISCORD_THREAD],
};

const ALL_PROVIDERS = Object.values(Provider);
const ALL_KINDS = Object.values(ExternalEntityKind);

function standaloneRef(provider: Provider, kind: ExternalEntityKind) {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    provider,
    connection_id: "conn-1",
    kind,
    external_id: "ext-1",
  };
}

function envelopeWith(provider: Provider, kind: ExternalEntityKind) {
  // Top-level provider/connection intentionally match entity_ref, so the ONLY
  // possible failure cause is the provider→kind pairing (isolating finding 1
  // from the existing provider/connection equality invariant).
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    event_id: "evt-1",
    provider,
    connection_id: "conn-1",
    external_event_id: "x-1",
    event_type: "updated",
    occurred_at: "2026-01-01T00:00:00Z",
    received_at: "2026-01-01T00:00:01Z",
    actor: { external_actor_id: "u-1" },
    entity_ref: { provider, connection_id: "conn-1", kind, external_id: "ext-1" },
    dedupe_key: "d-1",
    payload_ref: { ref: "s3://raw/1", digest: `sha256:${"0".repeat(64)}` },
    trace_id: "trace-1",
    sensitivity: "internal",
  };
}

describe("ExternalEntityRef provider→kind matrix (positive)", () => {
  for (const provider of ALL_PROVIDERS) {
    for (const kind of ALLOWED[provider]) {
      it(`accepts ${provider} + ${kind} (standalone and nested)`, () => {
        expect(externalEntityRef.safeParse(standaloneRef(provider, kind)).success).toBe(true);
        expect(eventEnvelope.safeParse(envelopeWith(provider, kind)).success).toBe(true);
      });
    }
  }
});

describe("ExternalEntityRef provider→kind matrix (all-pairs negative)", () => {
  for (const provider of ALL_PROVIDERS) {
    const allowed = new Set<string>(ALLOWED[provider]);
    for (const kind of ALL_KINDS) {
      if (allowed.has(kind)) continue;
      it(`rejects cross-provider ${provider} + ${kind} (standalone and nested)`, () => {
        expect(
          externalEntityRef.safeParse(standaloneRef(provider, kind)).success,
          `standalone ${provider}+${kind} must be rejected`,
        ).toBe(false);
        expect(
          eventEnvelope.safeParse(envelopeWith(provider, kind)).success,
          `nested ${provider}+${kind} must be rejected`,
        ).toBe(false);
      });
    }
  }
});
