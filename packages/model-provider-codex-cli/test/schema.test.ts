import { describe, expect, it } from "vitest";

import { createCodexResponseContract, serializeCodexRuntimeRequest } from "../src/index.js";

function requestWithTool() {
  return {
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "task" }] }],
    tools: [
      {
        name: "files.read",
        description: "Read one bounded path",
        inputSchema: {
          type: "object",
          properties: { relative_path: { type: "string" } },
          required: ["relative_path"],
          additionalProperties: false,
        },
      },
    ],
    outputSchema: {
      name: "AnswerV1",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  };
}

describe("Codex structured response contract", () => {
  it("binds the exact final schema and code-owned tool set into schema, digest and stdin", () => {
    const request = requestWithTool();
    const contract = createCodexResponseContract(request);
    const serialized = serializeCodexRuntimeRequest({ request, contract });
    const payload = JSON.parse(serialized) as {
      authority: string;
      protocol: {
        authority: string;
        response_schema_digest: string;
        final_kind: string;
        tools: { name: string }[];
      };
    };

    expect(contract).toMatchObject({
      finalKind: "json",
      toolNames: ["files.read"],
    });
    expect(contract.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(contract.schema)).toContain('"const":"files.read"');
    const schema = contract.schema as {
      properties: {
        schema_version: unknown;
        schema_digest: unknown;
        kind: unknown;
        tool_call: {
          anyOf: { properties: { name: unknown } }[];
        };
      };
    };
    expect(schema.properties.schema_version).toEqual({ type: "integer", const: 1 });
    expect(schema.properties.schema_digest).toEqual({
      type: "string",
      const: contract.schemaDigest,
    });
    expect(schema.properties.kind).toEqual({
      type: "string",
      enum: ["json", "tool_use"],
    });
    expect(schema.properties.tool_call.anyOf[0]!.properties.name).toEqual({
      type: "string",
      const: "files.read",
    });
    expect(payload).toMatchObject({
      authority: "UNTRUSTED_CONTEXT",
      protocol: {
        authority: "SERVER_OWNED",
        response_schema_digest: contract.schemaDigest,
        final_kind: "json",
        tools: [{ name: "files.read" }],
      },
    });
    expect(serialized).not.toContain('"name":"command"');
    expect(Object.isFrozen(contract.tools)).toBe(true);
    expect(Object.isFrozen(contract.schema)).toBe(true);
  });

  it("changes the response digest when any tool authority changes", () => {
    const first = requestWithTool();
    const second = requestWithTool();
    second.tools[0]!.name = "files.list";
    expect(createCodexResponseContract(first).schemaDigest).not.toBe(
      createCodexResponseContract(second).schemaDigest,
    );
  });

  it("rejects duplicate, malformed and excessive tool definitions", () => {
    const duplicate = requestWithTool();
    duplicate.tools.push({ ...duplicate.tools[0]! });
    expect(() => createCodexResponseContract(duplicate)).toThrow(/tool definition/u);

    const malformed = requestWithTool();
    malformed.tools[0]!.name = "../command";
    expect(() => createCodexResponseContract(malformed)).toThrow(/tool definition/u);

    const excessive = requestWithTool();
    excessive.tools = Array.from({ length: 65 }, (_, index) => ({
      ...excessive.tools[0]!,
      name: `tool-${index}`,
    }));
    expect(() => createCodexResponseContract(excessive)).toThrow(/tool count/u);
  });

  it("refuses a request mutated after its response contract was bound", () => {
    const request = requestWithTool();
    const contract = createCodexResponseContract(request);
    request.tools[0]!.name = "files.list";
    expect(() => serializeCodexRuntimeRequest({ request, contract })).toThrow(
      /changed after.*bound/u,
    );
  });
});
