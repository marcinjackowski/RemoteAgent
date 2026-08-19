import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ContentBlock,
  type Message,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";

import { TransportError } from "./errors.js";
import type {
  RuntimeConfig,
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeMessage,
  RuntimeOutputSchema,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeToolDefinition,
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
}

type BedrockToolConfig = NonNullable<ConverseCommandInput["toolConfig"]>;
type BedrockOutputConfig = NonNullable<ConverseCommandInput["outputConfig"]>;

function canonicalJson(value: RuntimeJsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TransportError("Unsupported non-finite JSON schema number");
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TransportError("Unsupported JSON schema value");
  return serialized;
}

function toolDefinitions(
  tools: readonly RuntimeToolDefinition[] | undefined,
): BedrockToolConfig | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: { json: tool.inputSchema },
      },
    })),
  } satisfies BedrockToolConfig;
}

function outputConfig(schema: RuntimeOutputSchema | undefined): BedrockOutputConfig | undefined {
  if (schema === undefined) return undefined;
  return {
    textFormat: {
      type: "json_schema",
      structure: {
        jsonSchema: {
          name: schema.name,
          schema: canonicalJson(schema.schema),
          ...(schema.description === undefined ? {} : { description: schema.description }),
        },
      },
    },
  };
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

function responseContent(output: ConverseCommandOutput): RuntimeResponse["content"] {
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
      return {
        type: "tool-use" as const,
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: block.toolUse.input ?? null,
      };
    }
    throw new TransportError(`Unsupported Bedrock response content at item ${index}`);
  });
}

/** Production Converse transport. The SDK owns credential resolution via its default chain. */
export class AwsBedrockTransport implements RuntimeTransport {
  readonly #client: BedrockRuntimeClientLike;
  readonly #logger: BedrockLogger | undefined;

  public constructor(options: AwsTransportOptions = {}) {
    this.#client =
      options.client ??
      new BedrockRuntimeClient(options.region === undefined ? {} : { region: options.region });
    this.#logger = options.logger;
  }

  public async converse(request: RuntimeRequest, config: RuntimeConfig): Promise<RuntimeResponse> {
    const messages = mapMessages(request.messages);
    const mappedToolConfig = toolDefinitions(request.tools);
    const mappedOutputConfig = outputConfig(request.outputSchema);
    const commandInput: ConverseCommandInput = {
      modelId: config.model.model_id,
      messages,
      ...(mappedToolConfig === undefined ? {} : { toolConfig: mappedToolConfig }),
      ...(mappedOutputConfig === undefined ? {} : { outputConfig: mappedOutputConfig }),
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
        content: responseContent(output),
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
      this.#logger?.error?.({
        operation: "bedrock.converse.failure",
      });
      throw new TransportError("Bedrock Converse request failed");
    }
  }
}
