import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamCommandOutput,
  type Message,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";

import { TransportError } from "./errors.js";
import type { RuntimeConfig, RuntimeContent, RuntimeMessage, RuntimeRequest } from "./types.js";
import type {
  RuntimeStreamEvent,
  RuntimeStreamResponse,
  RuntimeStreamTransport,
} from "./stream.js";

export interface BedrockStreamClientLike {
  send(
    command: ConverseStreamCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<ConverseStreamCommandOutput>;
}

export interface AwsStreamTransportOptions {
  readonly region?: string;
  readonly client?: BedrockStreamClientLike;
}

function textContent(content: readonly RuntimeContent[], index: number): Message["content"] {
  return content.map((item, contentIndex) => {
    if (item.type !== "text") {
      throw new TransportError(
        `Unsupported Bedrock content at message ${index}, item ${contentIndex}`,
      );
    }
    return { text: item.text };
  });
}

function mapMessages(messages: readonly RuntimeMessage[]): Message[] {
  return messages.map((message, index) => {
    if (message.role === "tool")
      throw new TransportError(`Unsupported Bedrock message role at index ${index}`);
    return { role: message.role, content: textContent(message.content, index) };
  });
}

function usage(
  value: NonNullable<Extract<ConverseStreamOutput, { metadata: unknown }>["metadata"]>["usage"],
): RuntimeStreamEvent {
  return {
    type: "metadata",
    ...(value === undefined
      ? {}
      : {
          usage: {
            ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
            ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
            ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
          },
        }),
  };
}

async function* events(output: ConverseStreamCommandOutput): AsyncIterable<RuntimeStreamEvent> {
  if (output.stream === undefined) throw new TransportError("Bedrock stream response was empty");
  let messageStopped = false;
  try {
    for await (const event of output.stream) {
      if (event.contentBlockDelta?.delta?.text !== undefined) {
        yield { type: "text", text: event.contentBlockDelta.delta.text };
      } else if (event.metadata !== undefined) {
        yield usage(event.metadata.usage);
      } else if (event.messageStop !== undefined) {
        messageStopped = true;
      } else if (
        event.internalServerException !== undefined ||
        event.modelStreamErrorException !== undefined ||
        event.serviceUnavailableException !== undefined ||
        event.throttlingException !== undefined ||
        event.validationException !== undefined ||
        event.$unknown !== undefined
      ) {
        throw new TransportError("Bedrock stream returned an error event");
      }
    }
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError("Bedrock ConverseStream failed");
  }
  if (!messageStopped) throw new TransportError("Bedrock stream ended before completion");
  yield { type: "complete" };
}

/** Production ConverseStream transport. The SDK resolves credentials through its default chain. */
export class AwsBedrockStreamTransport implements RuntimeStreamTransport {
  readonly #client: BedrockStreamClientLike;

  public constructor(options: AwsStreamTransportOptions = {}) {
    this.#client =
      options.client ??
      new BedrockRuntimeClient(options.region === undefined ? {} : { region: options.region });
  }

  public async converseStream(
    request: RuntimeRequest,
    config: RuntimeConfig,
  ): Promise<RuntimeStreamResponse> {
    const command = new ConverseStreamCommand({
      modelId: config.model.model_id,
      messages: mapMessages(request.messages),
    });
    try {
      const output =
        request.signal === undefined
          ? await this.#client.send(command)
          : await this.#client.send(command, { abortSignal: request.signal });
      return {
        stream: events(output),
        ...(output.$metadata.requestId === undefined
          ? {}
          : { requestId: output.$metadata.requestId }),
      };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError("Bedrock ConverseStream request failed");
    }
  }
}
