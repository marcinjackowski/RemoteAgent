/** Provider-neutral contracts shared by transports and the tool loop. */

export interface ModelIdentity {
  readonly provider: string;
  readonly model_id: string;
}

export interface ToolLimits {
  /** Maximum model/tool turns in one request. Zero disables tools. */
  readonly maxIterations: number;
  /** Maximum tool invocations in one request. Zero disables tools. */
  readonly maxCalls: number;
}

export interface RuntimeConfig {
  readonly model: ModelIdentity;
  readonly timeoutMs: number;
  readonly toolLimits: ToolLimits;
}

export interface RuntimeMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: readonly RuntimeContent[];
}

export type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | RuntimeJsonValue[]
  | { readonly [key: string]: RuntimeJsonValue };

export interface RuntimeToolDefinition {
  readonly name: string;
  readonly description?: string;
  /** Provider-neutral JSON Schema for the tool input. */
  readonly inputSchema: RuntimeJsonValue;
}

export interface RuntimeOutputSchema {
  readonly name: string;
  readonly description?: string;
  readonly schema: RuntimeJsonValue;
}

export type RuntimeContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "json"; readonly value: RuntimeJsonValue }
  | {
      readonly type: "tool-use";
      readonly id: string;
      readonly name: string;
      readonly input: RuntimeJsonValue;
    }
  | { readonly type: "tool-result"; readonly id: string; readonly output: RuntimeJsonValue };

export interface RuntimeRequest {
  readonly messages: readonly RuntimeMessage[];
  readonly tools?: readonly RuntimeToolDefinition[];
  readonly outputSchema?: RuntimeOutputSchema;
  readonly signal?: AbortSignal;
}

export interface RuntimeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface RuntimeResponse {
  readonly model: ModelIdentity;
  readonly content: readonly RuntimeContent[];
  readonly usage?: RuntimeUsage;
  readonly requestId?: string;
}

export interface RuntimeTransport {
  converse(request: RuntimeRequest, config: RuntimeConfig): Promise<RuntimeResponse>;
}
