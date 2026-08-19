import { agentCompletion, toJsonSchema } from "@remoteagent/contracts";
import { ConfigurationError, TransportError } from "./errors.js";
import { runToolLoop, type ToolExecutor } from "./tool-loop.js";
import type {
  RuntimeConfig,
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeMessage,
  RuntimeOutputSchema,
  RuntimeResponse,
  RuntimeToolDefinition,
  RuntimeTransport,
} from "./types.js";

export class StructuredCompletionError extends TransportError {
  constructor() {
    super("Structured completion output remained invalid after repair");
    this.name = "StructuredCompletionError";
  }
}

export interface StructuredCompletionRequest {
  readonly messages: readonly RuntimeMessage[];
  readonly tools?: readonly RuntimeToolDefinition[];
  readonly execute?: ToolExecutor;
  readonly signal?: AbortSignal;
}

export interface StructuredCompletionResult {
  readonly completion: ReturnType<typeof agentCompletion.parse>;
  readonly model: RuntimeResponse["model"];
  readonly usage?: RuntimeResponse["usage"];
  readonly requestId?: string;
  readonly repaired: boolean;
  readonly transportCalls: number;
  readonly toolIterations: number;
  readonly toolCalls: number;
}

function normalizeJson(value: unknown): RuntimeJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object" && value !== null) {
    const result: { [key: string]: RuntimeJsonValue } = {};
    for (const [key, item] of Object.entries(value)) result[key] = normalizeJson(item);
    return result;
  }
  throw new Error("Unsupported JSON value");
}

const outputSchema: RuntimeOutputSchema = {
  name: "AgentCompletion",
  schema: normalizeJson(toJsonSchema("AgentCompletion")),
};

function parseContent(content: readonly RuntimeContent[]): unknown {
  if (content.length !== 1) throw new Error("Expected one JSON content block");
  const [item] = content;
  if (item?.type === "json") return item.value;
  if (item?.type === "text") {
    const parsed: unknown = JSON.parse(item.text.trim());
    return parsed;
  }
  throw new Error("Expected JSON content");
}

function validate(response: RuntimeResponse): ReturnType<typeof agentCompletion.parse> {
  const parsed = parseContent(response.content);
  const result = agentCompletion.safeParse(parsed);
  if (!result.success) throw new Error("Invalid AgentCompletion");
  return result.data;
}

const repairInstruction: RuntimeMessage = {
  role: "user",
  content: [
    {
      type: "text",
      text: "Return only one valid JSON object matching the AgentCompletion schema.",
    },
  ],
};

/** Run a structured completion, with one tools-disabled validation repair. */
export async function runStructuredCompletion(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: StructuredCompletionRequest,
): Promise<StructuredCompletionResult> {
  if ((request.tools?.length ?? 0) > 0 && request.execute === undefined) {
    throw new ConfigurationError("Tool executor is required when tools are provided");
  }
  const loop = await runToolLoop(transport, config, {
    messages: request.messages,
    tools: request.tools ?? [],
    execute: request.execute ?? (async () => null),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    outputSchema,
  });
  try {
    return {
      completion: validate(loop),
      model: loop.model,
      ...(loop.usage === undefined ? {} : { usage: loop.usage }),
      ...(loop.requestId === undefined ? {} : { requestId: loop.requestId }),
      repaired: false,
      transportCalls: loop.iterations + 1,
      toolIterations: loop.iterations,
      toolCalls: loop.calls,
    };
  } catch {
    const repair = await transport.converse(
      {
        messages: [...loop.history, repairInstruction],
        outputSchema,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      config,
    );
    try {
      return {
        completion: validate(repair),
        model: repair.model,
        ...(repair.usage === undefined ? {} : { usage: repair.usage }),
        ...(repair.requestId === undefined ? {} : { requestId: repair.requestId }),
        repaired: true,
        transportCalls: loop.iterations + 2,
        toolIterations: loop.iterations,
        toolCalls: loop.calls,
      };
    } catch {
      throw new StructuredCompletionError();
    }
  }
}

export const runAgentCompletion = runStructuredCompletion;
