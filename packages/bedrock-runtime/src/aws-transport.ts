import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ContentBlock,
  type Message,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

import { RuntimeCancelledError, TransportError } from "./errors.js";
import { classifyTransportFailure } from "./retry.js";
import type {
  RuntimeConfig,
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeMessage,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeTransport,
} from "./types.js";

export interface BedrockRuntimeClientLike {
  send(
    command: ConverseCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}

export interface BedrockLogger {
  debug?(metadata: Record<string, unknown>): void;
  error?(metadata: Record<string, unknown>): void;
}

export interface AwsTransportOptions {
  readonly region?: string;
  readonly client?: BedrockRuntimeClientLike;
  readonly logger?: BedrockLogger;
  /**
   * Bedrock API key (bearer token). When set, the client authenticates via httpBearerAuth instead
   * of the SigV4 credential chain — no AWS access keys needed. The installed SDK does not auto-read
   * `AWS_BEARER_TOKEN_BEDROCK`, so the composition root passes it here explicitly.
   */
  readonly bearerToken?: string;
}

type BedrockToolConfig = NonNullable<ConverseCommandInput["toolConfig"]>;

/** The single object property the structured-output schema is wrapped under (see buildToolConfig). */
const OUTPUT_WRAPPER_KEY = "output";

/**
 * Build the Bedrock `toolConfig` from the request's tools AND its output schema.
 *
 * Structured output is requested as a FORCED TOOL, not `outputConfig` — verified live
 * (2026-08-24) that Bedrock rejects `outputConfig` (`output_config.format: Extra inputs are not
 * permitted`) while a tool with a `json` input schema is the supported path. The output schema
 * becomes a tool; `responseContent` surfaces that tool's input as the completion.
 *
 * `toolChoice` forces the output tool ONLY when it is the sole tool (a conversational structured
 * completion). When the request also carries work tools (the tool loop, RA-033), forcing would
 * stop the model from calling them, so the model chooses — it is expected to end by calling the
 * output tool.
 */
function buildToolConfig(request: RuntimeRequest): BedrockToolConfig | undefined {
  const specs: BedrockToolConfig["tools"] = (request.tools ?? []).map((tool) => ({
    toolSpec: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: { json: tool.inputSchema },
    },
  }));
  const schema = request.outputSchema;
  if (schema !== undefined) {
    specs.push({
      toolSpec: {
        name: schema.name,
        ...(schema.description === undefined ? {} : { description: schema.description }),
        // Bedrock requires a tool input schema to be a top-level `type: "object"`. Contract
        // schemas can be a top-level `oneOf` (discriminated unions like AgentCompletion), which
        // Bedrock rejects — verified live. Wrap the schema under a single `output` property and
        // unwrap it in `responseContent`.
        inputSchema: {
          json: {
            type: "object",
            properties: { [OUTPUT_WRAPPER_KEY]: schema.schema },
            required: [OUTPUT_WRAPPER_KEY],
            additionalProperties: false,
          },
        },
      },
    });
  }
  if (specs.length === 0) return undefined;
  const forceOutput = schema !== undefined && (request.tools ?? []).length === 0;
  return {
    tools: specs,
    ...(forceOutput ? { toolChoice: { tool: { name: schema.name } } } : {}),
  } satisfies BedrockToolConfig;
}

function textContent(content: readonly RuntimeContent[], messageIndex: number): Message["content"] {
  return content.map((item, contentIndex) => {
    if (item.type === "text") return { text: item.text };
    if (item.type === "tool-use") {
      const toolUse: ContentBlock.ToolUseMember = {
        toolUse: {
          toolUseId: item.id,
          name: item.name,
          input: item.input,
        },
      };
      return toolUse;
    }
    if (item.type === "tool-result") {
      const result: ToolResultContentBlock.JsonMember = { json: item.output };
      return {
        toolResult: {
          toolUseId: item.id,
          content: [result],
        },
      } satisfies ContentBlock.ToolResultMember;
    }
    throw new TransportError(
      `Unsupported Bedrock content at message ${messageIndex}, item ${contentIndex}`,
    );
  });
}

function mapMessages(messages: readonly RuntimeMessage[]): Message[] {
  return messages.map((message, messageIndex) => {
    const role = message.role === "tool" ? "user" : message.role;
    return { role, content: textContent(message.content, messageIndex) };
  });
}

function responseContent(
  output: ConverseCommandOutput,
  outputToolName: string | undefined,
): RuntimeResponse["content"] {
  const message = output.output?.message;
  if (message === undefined) {
    throw new TransportError("Bedrock response did not contain a message");
  }
  return (message.content ?? []).map((block, index) => {
    if (block.text !== undefined) return { type: "text" as const, text: block.text };
    if (
      block.toolUse !== undefined &&
      block.toolUse.toolUseId !== undefined &&
      block.toolUse.name !== undefined
    ) {
      const input = (block.toolUse.input ?? null) as RuntimeJsonValue;
      // The structured-output tool's input IS the completion; surface it as json so
      // `runStructuredCompletion` parses it directly rather than treating it as a tool call.
      // The schema was wrapped under `output` (buildToolConfig), so unwrap it here.
      if (outputToolName !== undefined && block.toolUse.name === outputToolName) {
        const unwrapped =
          input !== null && typeof input === "object" && !Array.isArray(input)
            ? ((input as Record<string, RuntimeJsonValue>)[OUTPUT_WRAPPER_KEY] ?? null)
            : input;
        return { type: "json" as const, value: unwrapped };
      }
      return {
        type: "tool-use" as const,
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input,
      };
    }
    throw new TransportError(`Unsupported Bedrock response content at item ${index}`);
  });
}

/**
 * Build the `BedrockRuntimeClient` config from transport options. Pure and exported so the auth
 * wiring is unit-testable without instantiating the SDK client: a `bearerToken` selects
 * httpBearerAuth (no IAM keys); its absence leaves the SDK's default credential chain (SigV4).
 */
export function bedrockClientConfig(options: AwsTransportOptions): BedrockRuntimeClientConfig {
  const config: BedrockRuntimeClientConfig = {};
  if (options.region !== undefined) config.region = options.region;
  if (options.bearerToken !== undefined && options.bearerToken !== "") {
    config.token = { token: options.bearerToken };
  }
  return config;
}

/** Production Converse transport. The SDK owns credential resolution via its default chain. */
export class AwsBedrockTransport implements RuntimeTransport {
  readonly #client: BedrockRuntimeClientLike;
  readonly #logger: BedrockLogger | undefined;

  public constructor(options: AwsTransportOptions = {}) {
    this.#client = options.client ?? new BedrockRuntimeClient(bedrockClientConfig(options));
    this.#logger = options.logger;
  }

  public async converse(request: RuntimeRequest, config: RuntimeConfig): Promise<RuntimeResponse> {
    const messages = mapMessages(request.messages);
    const toolConfig = buildToolConfig(request);
    const commandInput: ConverseCommandInput = {
      modelId: config.model.model_id,
      messages,
      ...(toolConfig === undefined ? {} : { toolConfig }),
    };
    const command = new ConverseCommand(commandInput);
    try {
      this.#logger?.debug?.({ operation: "bedrock.converse" });
      const output =
        request.signal === undefined
          ? await this.#client.send(command)
          : await this.#client.send(command, { abortSignal: request.signal });
      const usage = output.usage;
      return {
        model: config.model,
        content: responseContent(output, request.outputSchema?.name),
        ...(usage === undefined
          ? {}
          : {
              usage: {
                ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
                ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
                ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
              },
            }),
        ...(output.$metadata.requestId === undefined
          ? {}
          : { requestId: output.$metadata.requestId }),
      };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      const kind = classifyTransportFailure(error);
      if (kind === "CANCELLED") throw new RuntimeCancelledError();
      this.#logger?.error?.({
        operation: "bedrock.converse.failure",
      });
      throw new TransportError("Bedrock Converse request failed", kind);
    }
  }
}
