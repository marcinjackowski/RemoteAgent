/**
 * Trust markers for content that crosses into the system.
 *
 * Per AGENTS.md, all external content from Jira, Gmail, Calendar, GitLab and
 * Discord is `UNTRUSTED_DATA` and must be explicitly labeled as such
 * (RA-002 acceptance criterion 5). The type system forces a marker to be
 * present: there is no implicit default, so a contract cannot accidentally treat
 * external text as trusted.
 *
 * Trust is orthogonal to authority: a `TRUSTED` marker means the content was
 * produced by RemoteAgent itself (deterministic system code), never that a model
 * or an external party may set authoritative scope. Authoritative scope is
 * always assigned outside the model (see external-action / tool contracts).
 */
import * as z from "zod";

import { valueObject } from "./common.js";

export const TrustLevel = {
  /** Produced by deterministic RemoteAgent system code. */
  TRUSTED: "TRUSTED",
  /** Originated outside the trust boundary (external providers, model output). */
  UNTRUSTED_DATA: "UNTRUSTED_DATA",
} as const;

export type TrustLevel = (typeof TrustLevel)[keyof typeof TrustLevel];

export const trustLevelSchema = z.enum([TrustLevel.TRUSTED, TrustLevel.UNTRUSTED_DATA]);

/**
 * Wrap a value schema in an envelope that requires an explicit `trust` marker.
 * The wrapped content lives under `value` so the marker can never be confused
 * with a content field.
 */
export function trustMarked<TSchema extends z.ZodType>(value: TSchema) {
  return valueObject({
    trust: trustLevelSchema,
    value,
  });
}

/** Schema for a block of external, untrusted text (e.g. a Jira comment body). */
export const untrustedText = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: z.string().max(1_048_576),
});
