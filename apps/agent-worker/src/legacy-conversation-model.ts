import { AwsBedrockTransport } from "@remoteagent/bedrock-runtime";
import { resolveModelId, type Database } from "@remoteagent/database";
import {
  createRuntimeConfig,
  type RuntimeConfig,
  type RuntimeTransport,
} from "@remoteagent/model-runtime";

/**
 * Explicit owner for the pre-M10 conversational reply model.
 *
 * This binding is deliberately outside every Engineering composition module.
 * Engineering accepts only the official subscription registry; these legacy
 * Bedrock env variables cannot select or decorate an Engineering route.
 */
export const LEGACY_CONVERSATION_MODEL_OWNER = "CONVERSATION_REPLY_LOOP" as const;

export type LegacyConversationModelBinding = Readonly<{
  owner: typeof LEGACY_CONVERSATION_MODEL_OWNER;
  transport: RuntimeTransport;
  config: RuntimeConfig;
  knownSecrets: readonly string[];
}>;

export function legacyConversationKnownSecretsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const bearerToken = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  return bearerToken === undefined || bearerToken === "" ? Object.freeze([]) : [bearerToken];
}

export function legacyConversationRuntimeConfigFromEnv(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const timeout = env.RA_MODEL_TIMEOUT_MS;
  return createRuntimeConfig({
    model: { provider: "bedrock", model_id: modelId },
    timeoutMs: timeout === undefined ? 120_000 : Number.parseInt(timeout, 10),
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
}

export async function createLegacyConversationModelBinding(input: {
  db: Database;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyConversationModelBinding> {
  const env = input.env ?? process.env;
  const modelId = await resolveModelId(input.db, env);
  const bearerToken = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  const region = env.AWS_REGION?.trim();
  const config = legacyConversationRuntimeConfigFromEnv(modelId, env);
  return Object.freeze({
    owner: LEGACY_CONVERSATION_MODEL_OWNER,
    transport: new AwsBedrockTransport({
      ...(bearerToken === undefined || bearerToken === "" ? {} : { bearerToken }),
      ...(region === undefined || region === "" ? {} : { region }),
    }),
    config,
    knownSecrets: legacyConversationKnownSecretsFromEnv(env),
  });
}
