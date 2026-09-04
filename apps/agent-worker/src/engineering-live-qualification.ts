import { canonicalDigest, sha256Digest } from "@remoteagent/contracts";
import * as z from "zod";

import type { EngineeringExecutionConfig } from "./engineering-execution.js";
import { ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER } from "./engineering-debug-journal.js";
import type { ProductionEngineeringModelRouting } from "./engineering-model-routing.js";

const selection = z
  .object({
    invocation_id: z.string().min(1).max(512),
    implementer_profile: z.string().min(1).max(128),
    reviewer_profile: z.string().min(1).max(128),
  })
  .strict();

export type EngineeringLiveQualificationSelection = z.infer<typeof selection>;

export const ENGINEERING_LIVE_ENV = Object.freeze({
  enabled: "RA_RUN_LIVE_IOS_ENGINEERING",
  invocationId: "RA_LIVE_ENGINEERING_INVOCATION_ID",
  implementerProfile: "RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE",
  reviewerProfile: "RA_LIVE_ENGINEERING_REVIEWER_PROFILE",
});

/**
 * The live harness is only an outer process backstop. Keep it proportional to
 * the explicitly enlarged diagnostic token budget so it cannot terminate a
 * bounded Engineering run while its own stage, attempt, token, and deadline
 * guards still permit progress.
 */
export const ENGINEERING_LIVE_EXECUTION_BUDGET_MS =
  2 * 60 * 60_000 * ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER;
export const ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS =
  ENGINEERING_LIVE_EXECUTION_BUDGET_MS + 15 * 60_000;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for live Engineering qualification`);
  }
  return value;
}

/** Parse the live-only contract. The default/non-live test path never authenticates a provider. */
export function engineeringLiveQualificationSelectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EngineeringLiveQualificationSelection | null {
  if (env[ENGINEERING_LIVE_ENV.enabled] !== "1") return null;
  return selection.parse({
    invocation_id: required(env, ENGINEERING_LIVE_ENV.invocationId),
    implementer_profile: required(env, ENGINEERING_LIVE_ENV.implementerProfile),
    reviewer_profile: required(env, ENGINEERING_LIVE_ENV.reviewerProfile),
  });
}

export type EngineeringLiveQualificationAuthority = Readonly<{
  authority: "EXPLICIT_SUBSCRIPTION_ROUTE";
  invocation_id: string;
  implementer_invocation_digest: string;
  reviewer_invocation_digest: string;
  execution_config_digest: string;
  external_writes: "FORBIDDEN";
}>;

/**
 * Bind the owner's explicit live selection to the already authenticated role registry.
 * Neither a config default nor provider output can change the two compared profiles.
 */
export function assertEngineeringLiveQualificationAuthority(input: {
  selection: EngineeringLiveQualificationSelection;
  routing: ProductionEngineeringModelRouting;
  executionConfig: EngineeringExecutionConfig;
}): EngineeringLiveQualificationAuthority {
  const parsed = selection.parse(input.selection);
  const implementer = input.routing.forRole("IMPLEMENTER").invocation;
  const reviewer = input.routing.forRole("REVIEWER").invocation;
  if (implementer.profile_name !== parsed.implementer_profile) {
    throw new Error("live Engineering IMPLEMENTER profile does not match the explicit selection");
  }
  if (reviewer.profile_name !== parsed.reviewer_profile) {
    throw new Error("live Engineering REVIEWER profile does not match the explicit selection");
  }
  return Object.freeze({
    authority: "EXPLICIT_SUBSCRIPTION_ROUTE" as const,
    invocation_id: parsed.invocation_id,
    implementer_invocation_digest: sha256Digest.parse(canonicalDigest(implementer)),
    reviewer_invocation_digest: sha256Digest.parse(canonicalDigest(reviewer)),
    execution_config_digest: input.executionConfig.configDigest,
    external_writes: "FORBIDDEN" as const,
  });
}
