import { canonicalDigest } from "@remoteagent/contracts";
import type {
  RuntimeJsonValue,
  RuntimeOutputSchema,
  RuntimeRequest,
  RuntimeToolDefinition,
} from "@remoteagent/model-runtime";

const TEXT_OUTPUT_SCHEMA: RuntimeOutputSchema = Object.freeze({
  name: "RemoteAgentCodexTextV1",
  schema: Object.freeze({ type: "string", maxLength: 16 * 1024 * 1024 }),
});
const MAX_TOOLS = 64;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const boundedName = /^[A-Za-z0-9._:-]{1,128}$/u;

export type CodexResponseContract = Readonly<{
  schema: RuntimeJsonValue;
  schemaDigest: string;
  finalKind: "json" | "text";
  output: RuntimeOutputSchema;
  tools: readonly RuntimeToolDefinition[];
  toolNames: readonly string[];
}>;

function objectSchema(value: Record<string, RuntimeJsonValue>): RuntimeJsonValue {
  return Object.freeze(value);
}

function arraySchema(values: RuntimeJsonValue[]): RuntimeJsonValue {
  Object.freeze(values);
  return values;
}

function isJsonObject(value: unknown): value is Record<string, RuntimeJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyJson(value: RuntimeJsonValue, state: { nodes: number }, depth = 0): RuntimeJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error("Codex JSON contract exceeds its structural boundary");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Codex JSON contract contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    return arraySchema(value.map((entry) => copyJson(entry, state, depth + 1)));
  }
  const copy = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, copyJson(entry, state, depth + 1)]),
  ) as Record<string, RuntimeJsonValue>;
  return Object.freeze(copy);
}

function copyOutput(output: RuntimeOutputSchema): RuntimeOutputSchema {
  if (!boundedName.test(output.name) || (output.description?.length ?? 0) > 4096) {
    throw new Error("Codex output schema identity is outside its boundary");
  }
  return Object.freeze({
    name: output.name,
    ...(output.description === undefined ? {} : { description: output.description }),
    schema: copyJson(output.schema, { nodes: 0 }),
  });
}

function copyTools(tools: readonly RuntimeToolDefinition[]): readonly RuntimeToolDefinition[] {
  if (tools.length > MAX_TOOLS) throw new Error("Codex tool count exceeds its boundary");
  const names = new Set<string>();
  const copies = tools.map((tool) => {
    if (
      !boundedName.test(tool.name) ||
      names.has(tool.name) ||
      (tool.description?.length ?? 0) > 4096
    ) {
      throw new Error("Codex tool definition is outside its boundary");
    }
    names.add(tool.name);
    return Object.freeze({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: copyJson(tool.inputSchema, { nodes: 0 }),
    });
  });
  return Object.freeze(copies);
}

function schemaAllowsNull(schema: RuntimeJsonValue): boolean {
  if (!isJsonObject(schema)) return false;
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  const anyOf = schema["anyOf"];
  return Array.isArray(anyOf) && anyOf.some(schemaAllowsNull);
}

/**
 * Codex strict structured output requires every object property to appear in
 * `required`. Provider-neutral tool schemas intentionally use omitted fields
 * for optionals, so the response-only schema represents those fields as
 * required nullable placeholders. The original tool schema and authority
 * digest remain unchanged and are sent to the model in the protocol payload.
 */
function codexStrictToolSchema(
  value: RuntimeJsonValue,
  state: { nodes: number } = { nodes: 0 },
  depth = 0,
): RuntimeJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error("Codex strict tool schema exceeds its structural boundary");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) {
    return arraySchema(value.map((entry) => codexStrictToolSchema(entry, state, depth + 1)));
  }

  const properties = value["properties"];
  const propertyEntries = isJsonObject(properties) ? Object.entries(properties) : null;
  const originalRequired = new Set(
    Array.isArray(value["required"])
      ? value["required"].filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const copy: Record<string, RuntimeJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "properties" || key === "required") && propertyEntries !== null) continue;
    copy[key] = codexStrictToolSchema(entry, state, depth + 1);
  }
  if (propertyEntries !== null) {
    const strictProperties: Record<string, RuntimeJsonValue> = {};
    for (const [key, propertySchema] of propertyEntries) {
      const strict = codexStrictToolSchema(propertySchema, state, depth + 1);
      strictProperties[key] =
        originalRequired.has(key) || schemaAllowsNull(propertySchema)
          ? strict
          : objectSchema({ anyOf: arraySchema([strict, objectSchema({ type: "null" })]) });
    }
    copy["properties"] = objectSchema(strictProperties);
    copy["required"] = arraySchema(propertyEntries.map(([key]) => key));
  }
  return objectSchema(copy);
}

function toolCallSchema(tools: readonly RuntimeToolDefinition[]): RuntimeJsonValue {
  if (tools.length === 0) return objectSchema({ type: "null" });
  return objectSchema({
    anyOf: arraySchema([
      ...tools.map((tool) =>
        objectSchema({
          type: "object",
          properties: objectSchema({
            id: objectSchema({ type: "string", pattern: "^[A-Za-z0-9._:-]{1,256}$" }),
            name: objectSchema({ type: "string", const: tool.name }),
            input: codexStrictToolSchema(tool.inputSchema),
          }),
          required: arraySchema(["id", "name", "input"]),
          additionalProperties: false,
        }),
      ),
      objectSchema({ type: "null" }),
    ]),
  });
}

export function createCodexResponseContract(request: RuntimeRequest): CodexResponseContract {
  const output = copyOutput(request.outputSchema ?? TEXT_OUTPUT_SCHEMA);
  const tools = copyTools(request.tools ?? []);
  const finalKind = request.outputSchema === undefined ? "text" : "json";
  const schemaDigest = canonicalDigest({ output, tools });
  const finalSchema =
    tools.length === 0
      ? output.schema
      : objectSchema({
          anyOf: arraySchema([output.schema, objectSchema({ type: "null" })]),
        });
  const schema = objectSchema({
    type: "object",
    properties: objectSchema({
      schema_version: objectSchema({ type: "integer", const: 1 }),
      schema_digest: objectSchema({ type: "string", const: schemaDigest }),
      kind: objectSchema({
        type: "string",
        enum: arraySchema(tools.length === 0 ? [finalKind] : [finalKind, "tool_use"]),
      }),
      final: finalSchema,
      tool_call: toolCallSchema(tools),
    }),
    required: arraySchema(["schema_version", "schema_digest", "kind", "final", "tool_call"]),
    additionalProperties: false,
  });
  return Object.freeze({
    schema,
    schemaDigest,
    finalKind,
    output,
    tools,
    toolNames: Object.freeze(tools.map((tool) => tool.name)),
  });
}

export function serializeCodexRuntimeRequest(input: {
  request: RuntimeRequest;
  contract: CodexResponseContract;
}): string {
  const rebound = createCodexResponseContract(input.request);
  if (rebound.schemaDigest !== input.contract.schemaDigest) {
    throw new Error("Codex runtime request changed after its response contract was bound");
  }
  const payload = {
    schema_version: 1,
    authority: "UNTRUSTED_CONTEXT",
    protocol: {
      authority: "SERVER_OWNED",
      response_schema_digest: input.contract.schemaDigest,
      final_kind: input.contract.finalKind,
      output_schema: input.contract.output,
      tools: input.contract.tools,
      instruction:
        "Return either one final value or one tool request. Tool requests are proposals only; RemoteAgent validates and executes them outside Codex.",
    },
    messages: input.request.messages,
  };
  try {
    return `${JSON.stringify(payload)}\n`;
  } catch {
    throw new Error("Codex runtime request is not serializable JSON");
  }
}
