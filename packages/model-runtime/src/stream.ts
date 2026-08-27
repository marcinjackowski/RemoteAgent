import { RuntimeCancelledError, TransportError } from "./errors.js";
import type { ModelIdentity, RuntimeConfig, RuntimeMessage, RuntimeUsage } from "./types.js";

export type RuntimeStreamEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "metadata"; readonly usage?: RuntimeUsage }
  | { readonly type: "complete" };

export interface RuntimeStreamResponse {
  readonly stream: AsyncIterable<RuntimeStreamEvent>;
  readonly requestId?: string;
}

export interface RuntimeStreamTransport {
  converseStream(
    request: { readonly messages: readonly RuntimeMessage[]; readonly signal?: AbortSignal },
    config: RuntimeConfig,
  ): Promise<RuntimeStreamResponse>;
}

export interface ConverseStreamRequest {
  readonly messages: readonly RuntimeMessage[];
  readonly signal?: AbortSignal;
}

export interface ConverseStreamResult {
  readonly text: string;
  readonly model: ModelIdentity;
  readonly usage?: RuntimeUsage;
  readonly requestId?: string;
}

/** Consume a model-neutral stream. Completion is valid only after its terminal event. */
export async function converseStream(
  transport: RuntimeStreamTransport,
  config: RuntimeConfig,
  request: ConverseStreamRequest,
): Promise<ConverseStreamResult> {
  const signal = request.signal;
  if (signal?.aborted) throw new RuntimeCancelledError();
  let acquisitionAbort: (() => void) | undefined;
  const acquisitionCancellation =
    signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          acquisitionAbort = () => reject(new RuntimeCancelledError());
          signal.addEventListener("abort", acquisitionAbort, { once: true });
        });
  let response;
  try {
    const acquisition = Promise.resolve().then(() =>
      transport.converseStream(
        signal === undefined ? { messages: request.messages } : request,
        config,
      ),
    );
    response =
      acquisitionCancellation === undefined
        ? await acquisition
        : await Promise.race([acquisition, acquisitionCancellation]);
  } finally {
    if (acquisitionAbort !== undefined && signal !== undefined) {
      signal.removeEventListener("abort", acquisitionAbort);
    }
  }
  const iterator = response.stream[Symbol.asyncIterator]();
  let settled = false;
  let abort: (() => void) | undefined;
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          abort = () => reject(new RuntimeCancelledError());
          signal.addEventListener("abort", abort, { once: true });
        });
  const text: string[] = [];
  let usage: RuntimeUsage | undefined;
  let complete = false;
  try {
    while (!complete) {
      const next = iterator.next();
      const item =
        abortPromise === undefined ? await next : await Promise.race([next, abortPromise]);
      if (item.done) throw new TransportError("Model stream ended before completion");
      if (item.value.type === "text") text.push(item.value.text);
      else if (item.value.type === "metadata") usage = item.value.usage;
      else if (item.value.type === "complete") complete = true;
    }
    settled = true;
    return {
      text: text.join(""),
      model: config.model,
      ...(usage === undefined ? {} : { usage }),
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
    };
  } finally {
    if (abort !== undefined && signal !== undefined) signal.removeEventListener("abort", abort);
    if (!settled) {
      try {
        const cleanup = iterator.return?.();
        if (cleanup !== undefined) void Promise.resolve(cleanup).catch(() => undefined);
      } catch {
        // Iterator cleanup is best-effort and must not replace the primary result.
      }
    }
  }
}
