import * as z from "zod";

import { idString, isoTimestamp, text, valueObject, versionedContract } from "./common.js";
import { plannerCapabilityManifest } from "./planner-port.js";
import { relativeRepositoryPath, sha256Digest } from "./repository-profile.js";

const planRequirement = valueObject({
  requirement_id: idString,
  summary: text,
  authority: z.literal("SERVER_OWNED"),
});

const evidenceReference = valueObject({
  kind: idString,
  reference: idString,
});

const planStep = valueObject({
  step_id: idString,
  requirement_ids: z.array(idString).min(1).max(64),
  objective: text,
  file_areas: z.array(relativeRepositoryPath).max(128),
  depends_on: z.array(idString).max(64),
  evidence: z.array(evidenceReference).min(1).max(128),
  risks: z.array(text).max(64),
  definition_of_done: z.array(text).min(1).max(64),
});

const decisionReference = valueObject({
  decision_id: idString,
  requirement_id: idString,
});

export const implementationPlan = versionedContract({
  plan_id: idString,
  task_id: idString,
  profile_id: idString,
  profile_digest: sha256Digest,
  contract_version: idString,
  created_at: isoTimestamp,
  requirements: z.array(planRequirement).max(512),
  steps: z.array(planStep).max(512),
  decisions: z.array(decisionReference).max(256),
  tool_manifest: plannerCapabilityManifest,
});

export type PlanRequirement = z.infer<typeof planRequirement>;
export type EvidenceReference = z.infer<typeof evidenceReference>;
export type PlanStep = z.infer<typeof planStep>;
export type DecisionReference = z.infer<typeof decisionReference>;
export type ImplementationPlan = z.infer<typeof implementationPlan>;
