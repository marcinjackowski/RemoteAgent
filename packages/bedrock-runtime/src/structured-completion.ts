import {
  agentCompletion,
  canonicalDigest,
  EngineeringStage,
  engineeringStage,
  toJsonSchema,
} from "@remoteagent/contracts";
import * as z from "zod";
import {
  ConfigurationError,
  StructuredContractOutputError,
  StructuredModelIdentityError,
  StructuredSchemaIdentityError,
  TransportError,
} from "./errors.js";
import { executeTransportDetailed, type TransportExecutionDependencies } from "./retry.js";
import { runToolLoop, type ToolExecutor } from "./tool-loop.js";
import type {
  RuntimeConfig,
  RuntimeCompletionMetadata,
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
  readonly execution?: TransportExecutionDependencies;
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
  readonly modelCompletions: readonly RuntimeCompletionMetadata[];
}

export interface StructuredContractDefinition<TSchema extends z.ZodType> {
  /** Provider-safe, stable name included in Bedrock's output-schema request. */
  readonly name: string;
  /** Exact version this runtime is able to parse. */
  readonly version: number;
  /** The single schema authority used both for parsing and JSON Schema generation. */
  readonly schema: TSchema;
  /** Provider projection generated from `schema`, never supplied independently. */
  readonly outputSchema: RuntimeOutputSchema;
  /** Canonical digest of the provider projection. */
  readonly schemaDigest: string;
  /** Parse through the owning schema and fail closed on a version mismatch. */
  parse(input: unknown): z.output<TSchema>;
}

export interface StructuredContractDefinitionInput<TSchema extends z.ZodType> {
  readonly name: string;
  readonly version: number;
  readonly schema: TSchema;
  readonly description?: string;
}

export interface StructuredContractRequest<
  TSchema extends z.ZodType,
> extends StructuredCompletionRequest {
  readonly definition: StructuredContractDefinition<TSchema>;
  readonly stage: EngineeringStage;
  readonly expectedSchemaDigest: string;
  readonly promptVersion: string;
}

export interface StructuredContractResult<TSchema extends z.ZodType> {
  readonly value: z.output<TSchema>;
  readonly model: RuntimeResponse["model"];
  readonly stage: EngineeringStage;
  readonly schemaName: string;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly promptVersion: string;
  readonly usage?: RuntimeResponse["usage"];
  readonly requestId?: string;
  readonly repaired: boolean;
  readonly transportCalls: number;
  readonly toolIterations: number;
  readonly toolCalls: number;
  readonly modelCompletions: readonly RuntimeCompletionMetadata[];
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

function freezeJson(value: RuntimeJsonValue): RuntimeJsonValue {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    Object.freeze(value);
    return value;
  }
  if (isJsonObject(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function isJsonObject(value: unknown): value is { readonly [key: string]: RuntimeJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStructuredContractName(name: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new ConfigurationError(
      "Structured contract name must be 1-64 ASCII letters, digits, underscores, or hyphens",
    );
  }
}

function assertStructuredContractVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new ConfigurationError("Structured contract version must be a positive safe integer");
  }
}

function assertStrictVersionedJsonSchema(schema: RuntimeJsonValue, version: number): void {
  if (!isJsonObject(schema) || schema["type"] !== "object") {
    throw new ConfigurationError("Structured contract schema must describe an object");
  }
  if (schema["additionalProperties"] !== false) {
    throw new ConfigurationError("Structured contract schema must reject unknown properties");
  }
  const required = schema["required"];
  if (!Array.isArray(required) || !required.includes("schema_version")) {
    throw new ConfigurationError("Structured contract schema must require schema_version");
  }
  const properties = schema["properties"];
  if (!isJsonObject(properties)) {
    throw new ConfigurationError("Structured contract schema must define properties");
  }
  const versionSchema = properties["schema_version"];
  if (!isJsonObject(versionSchema) || versionSchema["const"] !== version) {
    throw new ConfigurationError(
      "Structured contract schema_version must equal the declared contract version",
    );
  }
}

/**
 * Define one schema-owned structured-output boundary.
 *
 * The Zod schema is the only authored representation: the provider projection,
 * digest and typed parser are all derived here so they cannot drift apart.
 */
export function defineStructuredContract<TSchema extends z.ZodType>(
  input: StructuredContractDefinitionInput<TSchema>,
): StructuredContractDefinition<TSchema> {
  const name = input.name;
  const version = input.version;
  const schema = input.schema;
  const description = input.description;
  assertStructuredContractName(name);
  assertStructuredContractVersion(version);

  const providerSchema = freezeJson(normalizeJson(z.toJSONSchema(schema, { io: "input" })));
  assertStrictVersionedJsonSchema(providerSchema, version);

  const outputSchema: RuntimeOutputSchema = Object.freeze({
    name,
    ...(description === undefined ? {} : { description }),
    schema: providerSchema,
  });
  const schemaDigest = canonicalDigest(providerSchema);

  return Object.freeze({
    name,
    version,
    schema,
    outputSchema,
    schemaDigest,
    parse(value: unknown): z.output<TSchema> {
      const parsed = schema.parse(value);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("schema_version" in parsed) ||
        parsed.schema_version !== version
      ) {
        throw new ConfigurationError(
          "Structured contract output schema_version does not match the declared version",
        );
      }
      return parsed;
    },
  });
}

function assertPromptVersion(promptVersion: string): void {
  if (
    promptVersion.length === 0 ||
    promptVersion.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(promptVersion)
  ) {
    throw new ConfigurationError("Prompt version must be a bounded stable identifier");
  }
}

function pinModelIdentity(transport: RuntimeTransport, config: RuntimeConfig): RuntimeTransport {
  return {
    async converse(request, callConfig) {
      const response = await transport.converse(request, callConfig);
      if (
        response.model.provider !== config.model.provider ||
        response.model.model_id !== config.model.model_id
      ) {
        throw new StructuredModelIdentityError();
      }
      return response;
    },
  };
}

function structuredRepairInstruction(
  definition: StructuredContractDefinition<z.ZodType>,
): RuntimeMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `Return only one valid JSON object matching ${definition.name} schema version ${definition.version}.`,
      },
    ],
  };
}

/** Run any server-owned structured contract through the existing Bedrock tool loop. */
export async function runStructuredContract<TSchema extends z.ZodType>(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: StructuredContractRequest<TSchema>,
): Promise<StructuredContractResult<TSchema>> {
  if (request.expectedSchemaDigest !== request.definition.schemaDigest) {
    throw new StructuredSchemaIdentityError();
  }
  assertPromptVersion(request.promptVersion);
  const stage = engineeringStage.safeParse(request.stage);
  if (!stage.success) throw new ConfigurationError("Unknown engineering stage");
  if ((request.tools?.length ?? 0) > 0 && request.execute === undefined) {
    throw new ConfigurationError("Tool executor is required when tools are provided");
  }

  const pinnedTransport = pinModelIdentity(transport, config);
  const loop = await runToolLoop(pinnedTransport, config, {
    messages: request.messages,
    tools: request.tools ?? [],
    execute: request.execute ?? (async () => null),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    outputSchema: request.definition.outputSchema,
    ...(request.execution === undefined ? {} : { execution: request.execution }),
  });
  try {
    return {
      value: request.definition.parse(parseContent(loop.content)),
      model: loop.model,
      stage: stage.data,
      schemaName: request.definition.name,
      schemaVersion: request.definition.version,
      schemaDigest: request.definition.schemaDigest,
      promptVersion: request.promptVersion,
      ...(loop.usage === undefined ? {} : { usage: loop.usage }),
      ...(loop.requestId === undefined ? {} : { requestId: loop.requestId }),
      repaired: false,
      transportCalls: loop.transportAttempts,
      toolIterations: loop.iterations,
      toolCalls: loop.calls,
      modelCompletions: loop.modelCompletions,
    };
  } catch {
    if (stage.data === EngineeringStage.SLICE_IMPLEMENTATION) {
      throw new StructuredContractOutputError();
    }
    const repairExecution = await executeTransportDetailed(
      pinnedTransport,
      config,
      {
        messages: [...loop.history, structuredRepairInstruction(request.definition)],
        outputSchema: request.definition.outputSchema,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      request.execution,
    );
    const repair = repairExecution.response;
    const repairMetadata: RuntimeCompletionMetadata = {
      model: repair.model,
      ...(repair.usage === undefined ? {} : { usage: repair.usage }),
      ...(repair.requestId === undefined ? {} : { requestId: repair.requestId }),
      transportAttempts: repairExecution.attempts,
    };
    try {
      return {
        value: request.definition.parse(parseContent(repair.content)),
        model: repair.model,
        stage: stage.data,
        schemaName: request.definition.name,
        schemaVersion: request.definition.version,
        schemaDigest: request.definition.schemaDigest,
        promptVersion: request.promptVersion,
        ...(repair.usage === undefined ? {} : { usage: repair.usage }),
        ...(repair.requestId === undefined ? {} : { requestId: repair.requestId }),
        repaired: true,
        transportCalls: loop.transportAttempts + repairExecution.attempts,
        toolIterations: loop.iterations,
        toolCalls: loop.calls,
        modelCompletions: [...loop.modelCompletions, repairMetadata],
      };
    } catch {
      throw new StructuredContractOutputError();
    }
  }
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
    ...(request.execution === undefined ? {} : { execution: request.execution }),
  });
  try {
    return {
      completion: validate(loop),
      model: loop.model,
      ...(loop.usage === undefined ? {} : { usage: loop.usage }),
      ...(loop.requestId === undefined ? {} : { requestId: loop.requestId }),
      repaired: false,
      transportCalls: loop.transportAttempts,
      toolIterations: loop.iterations,
      toolCalls: loop.calls,
      modelCompletions: loop.modelCompletions,
    };
  } catch {
    const repairExecution = await executeTransportDetailed(
      transport,
      config,
      {
        messages: [...loop.history, repairInstruction],
        outputSchema,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      request.execution,
    );
    const repair = repairExecution.response;
    const repairMetadata: RuntimeCompletionMetadata = {
      model: repair.model,
      ...(repair.usage === undefined ? {} : { usage: repair.usage }),
      ...(repair.requestId === undefined ? {} : { requestId: repair.requestId }),
      transportAttempts: repairExecution.attempts,
    };
    try {
      return {
        completion: validate(repair),
        model: repair.model,
        ...(repair.usage === undefined ? {} : { usage: repair.usage }),
        ...(repair.requestId === undefined ? {} : { requestId: repair.requestId }),
        repaired: true,
        transportCalls: loop.transportAttempts + repairExecution.attempts,
        toolIterations: loop.iterations,
        toolCalls: loop.calls,
        modelCompletions: [...loop.modelCompletions, repairMetadata],
      };
    } catch {
      throw new StructuredCompletionError();
    }
  }
}

export const runAgentCompletion = runStructuredCompletion;
