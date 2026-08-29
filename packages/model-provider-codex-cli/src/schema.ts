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
            input: tool.inputSchema,
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
