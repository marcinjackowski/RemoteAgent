import type { AgentRole } from "@remoteagent/contracts";
import {
  createRuntimeConfig,
  runStructuredCompletion,
  type RuntimeConfig,
  type RuntimeMessage,
  type RuntimeTransport,
} from "@remoteagent/bedrock-runtime";
import { MetricName, type MetricRegistry } from "@remoteagent/observability";

import type { RoleContextReader } from "./context.js";

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
  readonly unit: {
    readonly workUnit: {
      readonly objective: string;
      readonly role: string;
      readonly case_id: string;
      readonly work_unit_id: string;
    };
  };
  readonly run: { readonly runId: string };
}

/** What a role needs beyond the transport: the objective becomes the model's instruction. */
export interface RoleBindingOptions {
  readonly transport: RuntimeTransport;
  readonly config: RuntimeConfig;
  /** Fresh, authority-pinned context. Optional keeps isolated role callers compatible. */
  readonly readContext?: RoleContextReader;
  readonly metrics?: MetricRegistry;
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
      // The worker's model call has NO system-prompt channel: `RuntimeMessage` is user/assistant/
      // tool only and the transport sends no Bedrock `system` block, so the RoleRegistry prompt
      // (agent-orchestrator) never reaches this path. The conversational directive therefore has to
      // ride in the first user turn. Without it the model fills the AgentCompletion `summary` with a
      // third-person report ("Owner asked… I provided…") instead of a direct chat reply — observed
      // live 2026-08-25.
      const replyStyle =
        "You are a helpful assistant talking WITH the owner in a chat thread. Reply DIRECTLY to " +
        "their latest message in a natural, first-person, conversational tone. The `summary` field " +
        "of your JSON response is the EXACT text delivered to the owner — write it as a chat reply, " +
        'never a third-person report of what you did (no "Owner asked…", no "I provided…").\n\n';
      // Prepend case_id and run_id so the model can echo them back in its completion JSON;
      // without these it has no way to know the values and will hallucinate them, causing a
      // "role completion binding mismatch" in the runtime (found in live test 2026-08-25).
      const bindingContext =
        `[Required JSON fields — copy exactly as given]\n` +
        `case_id: "${input.unit.workUnit.case_id}"\n` +
        `run_id: "${input.run.runId}"\n\n`;
      const messages: RuntimeMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: replyStyle + bindingContext + input.unit.workUnit.objective },
          ],
        },
      ];
      if (options.readContext !== undefined) {
        const context = await options.readContext({
          caseId: input.unit.workUnit.case_id,
          runId: input.run.runId,
          workUnitId: input.unit.workUnit.work_unit_id,
        });
        messages.push({ role: "user", content: [{ type: "text", text: context.packet }] });
      }
      const result = await runStructuredCompletion(options.transport, options.config, { messages });
      if (result.usage?.inputTokens !== undefined) {
        options.metrics?.increment(MetricName.MODEL_INPUT_TOKENS, result.usage.inputTokens, {
          kind: input.unit.workUnit.role,
        });
      }
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
      // `us.` inference profile: the bare model id fails on-demand (Bedrock ValidationException).
      model_id: env.RA_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    },
    timeoutMs: timeoutMs === undefined ? 120_000 : Number.parseInt(timeoutMs, 10),
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
}
