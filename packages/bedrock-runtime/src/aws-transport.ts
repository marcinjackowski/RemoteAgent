import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";

import { TransportError } from "./errors.js";
import type {
  RuntimeConfig,
  RuntimeContent,
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
}

function textContent(content: readonly RuntimeContent[], messageIndex: number): Message["content"] {
  return content.map((item, contentIndex) => {
    if (item.type !== "text") {
      throw new TransportError(
        `Unsupported Bedrock content at message ${messageIndex}, item ${contentIndex}`,
      );
    }
    return { text: item.text };
  });
}

function mapMessages(messages: readonly RuntimeMessage[]): Message[] {
  return messages.map((message, messageIndex) => {
    if (message.role === "tool") {
      throw new TransportError(`Unsupported Bedrock message role at index ${messageIndex}`);
    }
    return { role: message.role, content: textContent(message.content, messageIndex) };
  });
}

function responseContent(output: ConverseCommandOutput): RuntimeResponse["content"] {
  const message = output.output?.message;
  if (message === undefined) {
    throw new TransportError("Bedrock response did not contain a message");
  }
  return (message.content ?? []).map((block, index) => {
    if (block.text === undefined) {
      throw new TransportError(`Unsupported Bedrock response content at item ${index}`);
    }
    return { type: "text" as const, text: block.text };
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
    const command = new ConverseCommand({ modelId: config.model.model_id, messages });
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
