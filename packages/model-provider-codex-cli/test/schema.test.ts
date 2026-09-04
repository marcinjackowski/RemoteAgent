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
  function assertStrictObjects(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) assertStrictObjects(entry);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const object = value as Record<string, unknown>;
    if (typeof object["properties"] === "object" && object["properties"] !== null) {
      const keys = Object.keys(object["properties"] as Record<string, unknown>).sort();
      expect([...(object["required"] as string[])].sort()).toEqual(keys);
    }
    for (const entry of Object.values(object)) assertStrictObjects(entry);
  }

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

  it("encodes optional tool fields as strict nullable placeholders without changing authority", () => {
    const baseline = requestWithTool();
    const request = {
      ...baseline,
      tools: [
        {
          ...baseline.tools[0]!,
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              relative_path: { type: "string" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    };
    const contract = createCodexResponseContract(request);
    assertStrictObjects(contract.schema);
    const input = (
      contract.schema as {
        properties: {
          tool_call: {
            anyOf: { properties: { input: Record<string, unknown> } }[];
          };
        };
      }
    ).properties.tool_call.anyOf[0]!.properties.input as {
      required: string[];
      properties: { relative_path: unknown };
    };
    expect(input.required).toEqual(["query", "relative_path"]);
    expect(input.properties.relative_path).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(contract.tools[0]!.inputSchema).toEqual(request.tools[0]!.inputSchema);
    expect(JSON.parse(serializeCodexRuntimeRequest({ request, contract }))).toMatchObject({
      protocol: {
        tools: [
          {
            inputSchema: {
              required: ["query"],
              properties: { relative_path: { type: "string" } },
            },
          },
        ],
      },
    });
  });

  it("preserves mutually exclusive patch variants in the strict Codex response schema", () => {
    const baseline = requestWithTool();
    const request = {
      ...baseline,
      tools: [
        {
          name: "patch",
          inputSchema: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["files"],
                properties: {
                  files: { type: "array", items: { type: "string" } },
                  expected_before_digest: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["replacement_files"],
                properties: {
                  replacement_files: { type: "array", items: { type: "string" } },
                  expected_before_digest: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              },
            ],
          },
        },
      ],
    };
    const contract = createCodexResponseContract(request);
    assertStrictObjects(contract.schema);
    const input = (
      contract.schema as {
        properties: {
          tool_call: {
            anyOf: { properties: { input: { anyOf: Record<string, unknown>[] } } }[];
          };
        };
      }
    ).properties.tool_call.anyOf[0]!.properties.input;

    expect(input.anyOf).toHaveLength(2);
    expect(input.anyOf).toEqual([
      expect.objectContaining({
        additionalProperties: false,
        required: ["files", "expected_before_digest"],
      }),
      expect.objectContaining({
        additionalProperties: false,
        required: ["replacement_files", "expected_before_digest"],
      }),
    ]);
    expect(contract.tools[0]!.inputSchema).toEqual(request.tools[0]!.inputSchema);
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
