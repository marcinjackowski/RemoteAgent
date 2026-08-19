/**
 * `ToolIntent` and `ToolResult` (Master Plan §9).
 *
 * The model *proposes* a tool call by name plus arguments. It never supplies the
 * authoritative scope (owner, connection, repo): those are injected server-side
 * by the broker. To make that impossible to violate at the type level, the
 * model-proposed intent has no scope field at all; the *resolved* intent — built
 * only by the broker — carries the authoritative scope separately.
 */
import * as z from "zod";

import { idString, isoTimestamp, text, valueObject, versionedContract } from "./common.js";
import { TrustLevel } from "./trust.js";

/** Arbitrary JSON arguments proposed by the model (opaque, validated per-tool). */
const jsonValue: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/**
 * Model-proposed tool intent. Deliberately has NO scope/owner/connection field:
 * authoritative scope must not originate from model output.
 */
export const toolIntent = versionedContract({
  intent_id: idString,
  tool_name: idString,
  /** Model-proposed arguments; untrusted until validated by the broker. */
  arguments: valueObject({
    trust: z.literal("UNTRUSTED_DATA"),
    value: z.record(z.string(), jsonValue),
  }),
});

export type ToolIntent = z.infer<typeof toolIntent>;

/**
 * Authoritative scope injected by the broker. Built by deterministic code from
 * the case/connection context — never parsed from model output.
 */
export const resolvedToolScope = valueObject({
  owner_id: idString,
  connection_ids: z.array(idString).max(64).default([]),
  repo_allowlist: z.array(idString).max(64).default([]),
});

export type ResolvedToolScope = z.infer<typeof resolvedToolScope>;

/**
 * Broker-resolved intent: the model's proposal plus the server-injected scope.
 * Only the broker constructs this; it is the input the executor trusts.
 */
export const resolvedToolIntent = versionedContract({
  intent_id: idString,
  case_id: idString,
  tool_name: idString,
  arguments: z.record(z.string(), jsonValue),
  scope: resolvedToolScope,
});

export type ResolvedToolIntent = z.infer<typeof resolvedToolIntent>;

export const ToolResultStatus = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
} as const;

export type ToolResultStatus = (typeof ToolResultStatus)[keyof typeof ToolResultStatus];

export const toolResult = versionedContract({
  intent_id: idString,
  status: z.enum([ToolResultStatus.SUCCEEDED, ToolResultStatus.FAILED]),
  /**
   * Normalized, size-bounded output. Tool output is external-derived content, so
   * the trust marker is a fixed literal `UNTRUSTED_DATA`: a tool result can never
   * relabel its own output as `TRUSTED`. Trust is assigned by the boundary, not
   * chosen by the sender.
   */
  output: valueObject({
    trust: z.literal(TrustLevel.UNTRUSTED_DATA),
    value: z.record(z.string(), jsonValue),
  }),
  error_message: text.optional(),
  latency_ms: z.int().nonnegative(),
  correlation_id: idString,
  observed_at: isoTimestamp,
});

export type ToolResult = z.infer<typeof toolResult>;
