/**
 * `EventEnvelope` — the normalized, routable envelope produced by ingress for
 * every external event (Master Plan §5.1).
 *
 * The raw provider payload is never inlined: it is encrypted and referenced by
 * `payload_ref`. The envelope's routing/identity fields are authoritative and
 * assigned by deterministic ingress code. Any human-readable actor label that
 * came from the provider is carried as untrusted.
 */
import * as z from "zod";

import { idString, isoTimestamp, valueObject, versionedContract } from "./common.js";
import { externalEntityRefValue, providerSchema } from "./external-entity.js";
import { TrustLevel } from "./trust.js";

/** Sensitivity classification drives retention and redaction downstream. */
export const Sensitivity = {
  PUBLIC: "public",
  INTERNAL: "internal",
  CONFIDENTIAL: "confidential",
  RESTRICTED: "restricted",
} as const;

export type Sensitivity = (typeof Sensitivity)[keyof typeof Sensitivity];

export const sensitivitySchema = z.enum([
  Sensitivity.PUBLIC,
  Sensitivity.INTERNAL,
  Sensitivity.CONFIDENTIAL,
  Sensitivity.RESTRICTED,
]);

/** Pointer to the encrypted raw payload stored outside the envelope. */
export const payloadRef = valueObject({
  /** Opaque storage locator (bucket key, row id, …). */
  ref: idString,
  /** Digest of the stored raw payload for integrity checks. */
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** Bytes of the stored payload; informational. */
  size_bytes: z.int().nonnegative().optional(),
});

/**
 * Actor as reported by the provider. The display name is provider-controlled
 * and therefore always `UNTRUSTED_DATA`: the marker is a fixed literal, not a
 * free trust choice, so external-supplied text can never be relabeled as
 * trusted. The id/connection are system routing values.
 */
export const eventActor = valueObject({
  /** Provider-native actor id (may be absent for system events). */
  external_actor_id: idString.optional(),
  /** Provider-supplied display label — always untrusted external content. */
  display_name: z
    .object({
      trust: z.literal(TrustLevel.UNTRUSTED_DATA),
      value: z.string().max(1024),
    })
    .strict()
    .optional(),
});

export const eventEnvelope = versionedContract({
  event_id: idString,
  provider: providerSchema,
  /** Authoritative connection assigned server-side, never from payload. */
  connection_id: idString,
  external_event_id: idString,
  event_type: idString,
  occurred_at: isoTimestamp,
  received_at: isoTimestamp,
  actor: eventActor,
  entity_ref: externalEntityRefValue,
  /** Additional correlation hints (e.g. issue key, thread id). */
  correlation_keys: z.array(idString).max(64).default([]),
  /** Stable key used to deduplicate redelivered events. */
  dedupe_key: idString,
  payload_ref: payloadRef,
  trace_id: idString,
  sensitivity: sensitivitySchema,
}).superRefine((value, ctx) => {
  // The top-level provider/connection_id are the authoritative routing values.
  // The referenced entity MUST belong to the same provider and connection,
  // otherwise a resolver could correlate one account's event with another
  // account's entity — a cross-account/cross-provider leak on the shared
  // contract, before any later scope layer sees the data.
  //
  // NOTE (JSON Schema projection limitation): equality between top-level fields
  // and nested `entity_ref` fields is a cross-field invariant that
  // `z.toJSONSchema` cannot express; the projected schema only advertises the
  // per-field shapes, so this runtime Zod schema is the authoritative validator.
  if (value.entity_ref.provider !== value.provider) {
    ctx.addIssue({
      code: "custom",
      path: ["entity_ref", "provider"],
      message: "entity_ref.provider must equal the envelope provider",
    });
  }
  if (value.entity_ref.connection_id !== value.connection_id) {
    ctx.addIssue({
      code: "custom",
      path: ["entity_ref", "connection_id"],
      message: "entity_ref.connection_id must equal the envelope connection_id",
    });
  }
});

export type EventEnvelope = z.infer<typeof eventEnvelope>;
export type PayloadRef = z.infer<typeof payloadRef>;
export type EventActor = z.infer<typeof eventActor>;
