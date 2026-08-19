import { ToolLimitError, TransportError } from "./errors.js";
import { executeTransportDetailed, type TransportExecutionDependencies } from "./retry.js";
import type {
  RuntimeConfig,
  RuntimeCompletionMetadata,
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeMessage,
  RuntimeOutputSchema,
  RuntimeResponse,
  RuntimeTransport,
  RuntimeToolDefinition,
} from "./types.js";

export type ToolExecutor = (
  name: string,
  input: RuntimeJsonValue,
  signal: AbortSignal | undefined,
) => Promise<RuntimeJsonValue>;

export interface ToolLoopRequest {
  readonly messages: readonly RuntimeMessage[];
  readonly tools: readonly RuntimeToolDefinition[];
  readonly execute: ToolExecutor;
  readonly signal?: AbortSignal;
  readonly outputSchema?: RuntimeOutputSchema;
  readonly execution?: TransportExecutionDependencies;
}

export interface ToolLoopResult extends RuntimeResponse {
  readonly iterations: number;
  readonly calls: number;
  readonly history: readonly RuntimeMessage[];
  readonly transportAttempts: number;
  readonly modelCompletions: readonly RuntimeCompletionMetadata[];
}

function toolUses(content: readonly RuntimeContent[]) {
  return content.filter(
    (item): item is Extract<RuntimeContent, { readonly type: "tool-use" }> =>
      item.type === "tool-use",
  );
}

/** Execute model-proposed tools exactly once, with limits checked before execution. */
export async function runToolLoop(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: ToolLoopRequest,
): Promise<ToolLoopResult> {
  let messages = request.messages.map((message) => ({ ...message, content: [...message.content] }));
  const executed = new Set<string>();
  let iterations = 0;
  let calls = 0;
  let transportAttempts = 0;
  const modelCompletions: RuntimeCompletionMetadata[] = [];
  let response: RuntimeResponse;
  const enabledTools =
    config.toolLimits.maxIterations === 0 || config.toolLimits.maxCalls === 0
      ? undefined
      : request.tools;

  for (;;) {
    const execution = await executeTransportDetailed(
      transport,
      config,
      {
        messages,
        ...(enabledTools === undefined ? {} : { tools: enabledTools }),
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      request.execution,
    );
    response = execution.response;
    transportAttempts += execution.attempts;
    modelCompletions.push({
      model: response.model,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      transportAttempts: execution.attempts,
    });
    const uses = toolUses(response.content);
    if (uses.length === 0) {
      return {
        ...response,
        iterations,
        calls,
        history: [...messages, { role: "assistant", content: [...response.content] }],
        transportAttempts,
        modelCompletions,
      };
    }

    // Validate the entire batch before invoking even the first executor.
    if (config.toolLimits.maxIterations === 0 || config.toolLimits.maxCalls === 0) {
      throw new ToolLimitError("Tool execution is disabled by zero tool limits");
    }
    if (iterations + 1 > config.toolLimits.maxIterations) {
      throw new ToolLimitError("Maximum tool iterations exceeded");
    }
    if (calls + uses.length > config.toolLimits.maxCalls) {
      throw new ToolLimitError("Maximum tool calls exceeded");
    }
    const names = new Set(request.tools.map((tool) => tool.name));
    const batchIds = new Set<string>();
    for (const use of uses) {
      if (use.id.length === 0 || batchIds.has(use.id) || executed.has(use.id)) {
        throw new TransportError(`Duplicate or unknown tool-use id: ${use.id}`);
      }
      if (!names.has(use.name)) throw new TransportError(`Unknown tool: ${use.name}`);
      batchIds.add(use.id);
    }

    messages = [...messages, { role: "assistant", content: [...response.content] }];
    const results: RuntimeContent[] = [];
    for (const use of uses) {
      executed.add(use.id);
      try {
        const output = await request.execute(use.name, use.input, request.signal);
        results.push({ type: "tool-result", id: use.id, output: { ok: true, value: output } });
      } catch {
        // Errors are data, so a failed tool never causes a side-effecting retry.
        results.push({
          type: "tool-result",
          id: use.id,
          output: { ok: false, error: "Tool execution failed" },
        });
      }
    }
    messages = [...messages, { role: "tool", content: results }];
    iterations += 1;
    calls += uses.length;
  }
}

/** Alias retained as a descriptive public entry point. */
export const converseWithTools = runToolLoop;
