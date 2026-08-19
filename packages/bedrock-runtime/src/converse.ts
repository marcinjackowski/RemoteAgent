import type {
  ModelIdentity,
  RuntimeConfig,
  RuntimeContent,
  RuntimeMessage,
  RuntimeResponse,
  RuntimeTransport,
  RuntimeUsage,
} from "./types.js";

export interface ConverseTextRequest {
  readonly messages: readonly RuntimeMessage[];
  readonly signal?: AbortSignal;
}

export interface ConverseTextResult {
  readonly text: string;
  readonly model: ModelIdentity;
  readonly content: readonly RuntimeContent[];
  readonly usage?: RuntimeUsage;
  readonly requestId?: string;
}

function textFromContent(content: readonly RuntimeContent[]): string {
  return content
    .filter(
      (item): item is Extract<RuntimeContent, { readonly type: "text" }> => item.type === "text",
    )
    .map((item) => item.text)
    .join("");
}

/** Perform one non-streaming text turn using the caller-provided full history. */
export async function converseText(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: ConverseTextRequest,
): Promise<ConverseTextResult> {
  const transportRequest =
    request.signal === undefined
      ? { messages: request.messages }
      : { messages: request.messages, signal: request.signal };
  const response: RuntimeResponse = await transport.converse(transportRequest, config);

  return {
    text: textFromContent(response.content),
    model: response.model,
    content: response.content,
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
  };
}
