import { RuntimeCancelledError, RuntimeTimeoutError, ConfigurationError } from "./errors.js";
import { executeTransportDetailed, type TransportExecutionDependencies } from "./retry.js";
import { converseStream, type RuntimeStreamTransport } from "./stream.js";
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from "./structured-completion.js";
import type {
  ModelIdentity,
  RuntimeCompletionMetadata,
  RuntimeConfig,
  RuntimeMessage,
  RuntimeResponse,
  RuntimeTransport,
  RuntimeToolDefinition,
  RuntimeUsage,
} from "./types.js";
import type { ToolExecutor } from "./tool-loop.js";

export type RuntimeMode = "text" | "stream" | "structured";

export interface RuntimeTextRequest {
  readonly mode: "text";
  readonly messages: readonly RuntimeMessage[];
  readonly signal?: AbortSignal;
}

export interface RuntimeStreamRequest {
  readonly mode: "stream";
  readonly messages: readonly RuntimeMessage[];
  readonly signal?: AbortSignal;
}

export interface RuntimeStructuredRequest {
  readonly mode: "structured";
  readonly messages: readonly RuntimeMessage[];
  readonly tools?: readonly RuntimeToolDefinition[];
  readonly execute?: ToolExecutor;
  readonly signal?: AbortSignal;
}

export type RuntimeExecuteRequest =
  RuntimeTextRequest | RuntimeStreamRequest | RuntimeStructuredRequest;

export interface RuntimeMetadata {
  readonly model: ModelIdentity;
  readonly usage?: RuntimeUsage;
  readonly requestId?: string;
  readonly latencyMs: number;
  readonly transportAttempts: number;
  readonly modelCompletions: readonly RuntimeCompletionMetadata[];
}

export interface RuntimeTextResult extends RuntimeMetadata {
  readonly mode: "text";
  readonly text: string;
  readonly content: RuntimeResponse["content"];
}

export interface RuntimeStreamResult extends RuntimeMetadata {
  readonly mode: "stream";
  readonly text: string;
}

export interface RuntimeStructuredResult extends RuntimeMetadata {
  readonly mode: "structured";
  readonly completion: StructuredCompletionResult["completion"];
  readonly repaired: boolean;
  readonly toolIterations: number;
  readonly toolCalls: number;
}

export type RuntimeResult = RuntimeTextResult | RuntimeStreamResult | RuntimeStructuredResult;

export interface RuntimeTimerDependencies {
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface RuntimeOptions {
  readonly config: RuntimeConfig;
  readonly transport: RuntimeTransport;
  readonly streamTransport?: RuntimeStreamTransport;
  readonly execution?: TransportExecutionDependencies;
  readonly now?: () => number;
  readonly timers?: RuntimeTimerDependencies;
}

function metadata(
  config: RuntimeConfig,
  started: number,
  now: () => number,
  values: Omit<RuntimeMetadata, "model" | "latencyMs">,
): RuntimeMetadata {
  const elapsed = now() - started;
  return {
    model: config.model,
    latencyMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0,
    ...values,
  };
}

/** Provider-neutral facade for text, assembled stream, and structured completions. */
export class Runtime {
  private readonly config: RuntimeConfig;
  private readonly transport: RuntimeTransport;
  private readonly streamTransport: RuntimeStreamTransport | undefined;
  private readonly execution: TransportExecutionDependencies;
  private readonly now: () => number;
  private readonly timers: Required<RuntimeTimerDependencies>;

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.streamTransport = options.streamTransport;
    this.execution = options.execution ?? {};
    this.now = options.now ?? (() => Date.now());
    this.timers = {
      setTimeout:
        options.timers?.setTimeout ??
        this.execution.setTimeout ??
        ((callback, delay) => globalThis.setTimeout(callback, delay)),
      clearTimeout:
        options.timers?.clearTimeout ??
        this.execution.clearTimeout ??
        ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  async execute(request: RuntimeExecuteRequest): Promise<RuntimeResult> {
    const started = this.now();
    if (request.mode === "text") {
      const result = await executeTransportDetailed(
        this.transport,
        this.config,
        {
          messages: request.messages,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
        this.execution,
      );
      const text = result.response.content
        .filter(
          (item): item is Extract<RuntimeResponse["content"][number], { type: "text" }> =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("");
      return {
        mode: "text",
        text,
        content: result.response.content,
        ...metadata(this.config, started, this.now, {
          ...(result.response.usage === undefined ? {} : { usage: result.response.usage }),
          ...(result.response.requestId === undefined
            ? {}
            : { requestId: result.response.requestId }),
          transportAttempts: result.attempts,
          modelCompletions: [
            {
              model: result.response.model,
              ...(result.response.usage === undefined ? {} : { usage: result.response.usage }),
              ...(result.response.requestId === undefined
                ? {}
                : { requestId: result.response.requestId }),
              transportAttempts: result.attempts,
            },
          ],
        }),
      };
    }

    if (request.mode === "structured") {
      const result = await runStructuredCompletion(this.transport, this.config, {
        messages: request.messages,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.execute === undefined ? {} : { execute: request.execute }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        execution: this.execution,
      });
      return {
        mode: "structured",
        completion: result.completion,
        repaired: result.repaired,
        toolIterations: result.toolIterations,
        toolCalls: result.toolCalls,
        ...metadata(this.config, started, this.now, {
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.requestId === undefined ? {} : { requestId: result.requestId }),
          transportAttempts: result.transportCalls,
          modelCompletions: result.modelCompletions,
        }),
      };
    }

    return this.executeStream(request, started);
  }

  invoke(request: RuntimeExecuteRequest): Promise<RuntimeResult> {
    return this.execute(request);
  }

  private async executeStream(
    request: RuntimeStreamRequest,
    started: number,
  ): Promise<RuntimeStreamResult> {
    if (this.streamTransport === undefined) {
      throw new ConfigurationError("stream transport is required for stream mode");
    }
    const streamTransport = this.streamTransport;
    const controller = new AbortController();
    let timer: unknown;
    let upstreamAbort: (() => void) | undefined;
    let settled = false;
    const result = new Promise<RuntimeStreamResult>((resolve, reject) => {
      const finish = (
        outcome: { readonly error: unknown } | { readonly value: RuntimeStreamResult },
      ) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.timers.clearTimeout(timer);
        if (upstreamAbort !== undefined && request.signal !== undefined) {
          request.signal.removeEventListener("abort", upstreamAbort);
        }
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      upstreamAbort = () => {
        controller.abort();
        finish({ error: new RuntimeCancelledError() });
      };
      if (request.signal?.aborted) {
        upstreamAbort();
        return;
      }
      request.signal?.addEventListener("abort", upstreamAbort, { once: true });
      timer = this.timers.setTimeout(() => {
        controller.abort();
        finish({ error: new RuntimeTimeoutError() });
      }, this.config.timeoutMs);
      const operation = converseStream(streamTransport, this.config, {
        messages: request.messages,
        signal: controller.signal,
      });
      operation.then(
        (stream) =>
          finish({
            value: {
              mode: "stream",
              text: stream.text,
              ...metadata(this.config, started, this.now, {
                ...(stream.usage === undefined ? {} : { usage: stream.usage }),
                ...(stream.requestId === undefined ? {} : { requestId: stream.requestId }),
                transportAttempts: 1,
                modelCompletions: [
                  {
                    model: stream.model,
                    ...(stream.usage === undefined ? {} : { usage: stream.usage }),
                    ...(stream.requestId === undefined ? {} : { requestId: stream.requestId }),
                    transportAttempts: 1,
                  },
                ],
              }),
            },
          }),
        (error: unknown) => finish({ error }),
      );
    });
    return result;
  }
}

export function createRuntime(options: RuntimeOptions): Runtime {
  return new Runtime(options);
}
