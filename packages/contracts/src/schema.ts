/**
 * Runtime JSON Schema generation for the RA-002 contracts.
 *
 * The Zod schemas are the single source of truth; this module derives JSON
 * Schema (draft 2020-12) from them via `z.toJSONSchema`. The generated map is
 * snapshotted in tests so any contract change surfaces as a reviewed schema diff
 * (RA-002 required verification: schema snapshots with justified updates).
 */
import * as z from "zod";

import { agentCompletion } from "./agent-completion.js";
import { agentRun } from "./agent-run.js";
import { caseContract } from "./case.js";
import { caseCheckpoint } from "./checkpoint.js";
import { connectionContract } from "./connection.js";
import { decisionAnswer, decisionRequest } from "./decision.js";
import { eventEnvelope } from "./event-envelope.js";
import { externalEntityRef } from "./external-entity.js";
import { approval, externalAction, externalReceipt } from "./external-action.js";
import { resolvedToolIntent, toolIntent, toolResult } from "./tool.js";
import { workUnit } from "./work-unit.js";

/**
 * Every standalone boundary contract keyed by a stable name.
 *
 * Membership rule: only *versioned* boundary contracts (carrying a
 * `schema_version`) belong here. Nested value objects that are only ever
 * embedded in a parent boundary — e.g. `CheckpointPatch`, which lives inside an
 * `AgentCompletion` — are intentionally excluded so the registry never
 * advertises an unversioned shape as if it were an independent boundary.
 */
export const contractSchemas = {
  EventEnvelope: eventEnvelope,
  ExternalEntityRef: externalEntityRef,
  Connection: connectionContract,
  Case: caseContract,
  CaseCheckpoint: caseCheckpoint,
  AgentRun: agentRun,
  AgentCompletion: agentCompletion,
  DecisionRequest: decisionRequest,
  DecisionAnswer: decisionAnswer,
  WorkUnit: workUnit,
  ToolIntent: toolIntent,
  ResolvedToolIntent: resolvedToolIntent,
  ToolResult: toolResult,
  ExternalAction: externalAction,
  ExternalReceipt: externalReceipt,
  Approval: approval,
} as const;

export type ContractName = keyof typeof contractSchemas;

/** Build the JSON Schema for a single named contract. */
export function toJsonSchema(name: ContractName): unknown {
  return z.toJSONSchema(contractSchemas[name], { io: "input" });
}

/** Build the full map of JSON Schemas for all contracts (stable key order). */
export function buildJsonSchemaMap(): Record<string, unknown> {
  const names = Object.keys(contractSchemas).sort() as ContractName[];
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = z.toJSONSchema(contractSchemas[name], { io: "input" });
  }
  return out;
}
