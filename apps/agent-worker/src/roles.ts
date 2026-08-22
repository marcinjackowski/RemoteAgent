import type { AgentRole } from "@remoteagent/contracts";
import {
  createRuntimeConfig,
  runStructuredCompletion,
  type RuntimeConfig,
  type RuntimeTransport,
} from "@remoteagent/bedrock-runtime";

/**
 * Binds an agent role to the model transport (RA-028-WU-02, AC6).
 *
 * THE TRANSPORT IS A PARAMETER, NOT A CONSTRUCTION. It is the single reason this module
 * exists separately from the handlers: if the first handler constructed an
 * `AwsBedrockTransport` inline, every later handler would inherit that, and no test could
 * exercise a role without either reaching AWS or monkey-patching a module. Passing it in
 * means the production path and the test path run the SAME code with a different driver —
 * which is what makes a test about a role's behaviour evidence about production.
 *
 * `runStructuredCompletion` already returns a validated `AgentCompletion` (it parses
 * against the contract and performs one tools-disabled repair), so there is no
 * hand-written model-output parsing here. Adding one would be a second, divergent
 * validator of the same contract.
 */

export interface RoleInvocationInput {
  readonly unit: { readonly workUnit: { readonly objective: string; readonly role: string } };
  readonly run: { readonly runId: string };
}

/** What a role needs beyond the transport: the objective becomes the model's instruction. */
export interface RoleBindingOptions {
  readonly transport: RuntimeTransport;
  readonly config: RuntimeConfig;
}

/**
 * The model is NOT an authorization layer (`AGENTS.md` §4). The objective is
 * supervisor-authored and deterministic; nothing the model returns widens the unit's
 * `authoritative_scope`, and the completion is validated against the contract before it
 * reaches persistence.
 */
export function createRole(options: RoleBindingOptions): {
  invoke: (input: RoleInvocationInput) => Promise<unknown>;
} {
  return {
    invoke: async (input) => {
      const result = await runStructuredCompletion(options.transport, options.config, {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input.unit.workUnit.objective }],
          },
        ],
      });
      return result.completion;
    },
  };
}

/** Bind the same transport to every role the worker can be asked to run. */
export function createRoles(
  roles: readonly AgentRole[],
  options: RoleBindingOptions,
): Readonly<Record<string, { invoke: (input: RoleInvocationInput) => Promise<unknown> }>> {
  const bound: Record<string, ReturnType<typeof createRole>> = {};
  for (const role of roles) bound[role] = createRole(options);
  return bound;
}

/**
 * Model settings for the worker. Read from the environment because the model id is a
 * deployment decision, not a code one — but a PRESENT-BUT-INVALID value throws rather
 * than falling back, matching `workerConfigFromEnv`: a silent fallback to a different
 * model would produce work nobody asked for and be invisible in the logs.
 */
export function roleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const timeoutMs = env.RA_MODEL_TIMEOUT_MS;
  return createRuntimeConfig({
    model: {
      provider: env.RA_MODEL_PROVIDER ?? "bedrock",
      model_id: env.RA_MODEL_ID ?? "anthropic.claude-sonnet-4-5-20250929-v1:0",
    },
    timeoutMs: timeoutMs === undefined ? 120_000 : Number.parseInt(timeoutMs, 10),
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
}
