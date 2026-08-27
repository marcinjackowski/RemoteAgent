import {
  canonicalDigest,
  EngineeringStage,
  engineeringProgramDesign,
  engineeringReviewDecision,
} from "@remoteagent/contracts";
import * as z from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  StructuredCompletionError,
  StructuredContractOutputError,
  StructuredModelIdentityError,
  StructuredSchemaIdentityError,
  RuntimeCancelledError,
  RuntimeTimeoutError,
  TransportError,
  createRuntimeConfig,
  defineStructuredContract,
  runAgentCompletion,
  runStructuredContract,
  runStructuredCompletion,
  type RuntimeConfig,
  type RuntimeJsonValue,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeTransport,
} from "../src/index.js";

const planReportSchema = engineeringProgramDesign;
const reviewReportSchema = engineeringReviewDecision;
const sha = `sha256:${"a".repeat(64)}`;
const validProgramDesign = {
  schema_version: 1,
  artifact_kind: "ProgramDesign",
  case_id: "case",
  run_id: "run",
  revision: 1,
  call_flow: ["entry -> result"],
  file_tree_delta: ["src/feature.ts"],
  key_types_and_signatures: ["run(): Result"],
  uncertainty_review: ["none"],
  expected_tests: ["feature test"],
  slice_order: ["slice-a"],
  source_digest: sha,
};
const validReviewDecision = {
  schema_version: 1,
  artifact_kind: "ReviewDecision",
  case_id: "case",
  run_id: "run",
  revision: 1,
  decision_id: "decision",
  rationale: "evidence is complete",
  decision: "PASS",
  findings: [],
  reviewed_digest: sha,
};

const programDesignDefinition = defineStructuredContract({
  name: "ProgramDesign_v1",
  version: 1,
  schema: planReportSchema,
});

const config: RuntimeConfig = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 1000,
  toolLimits: { maxIterations: 2, maxCalls: 2 },
});
const completion = {
  schema_version: 1,
  run_id: "run",
  case_id: "case",
  status: "COMPLETED",
  summary: "done",
  completed_steps: [],
  evidence: [],
  checkpoint_patch: {},
  next_actions: [],
};

class ScriptTransport implements RuntimeTransport {
  readonly requests: RuntimeRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly RuntimeResponse[]) {}

  async converse(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    const response = this.responses[this.index++];
    if (response === undefined) throw new Error("script exhausted");
    return response;
  }
}

const response = (value: RuntimeJsonValue, requestId = "request"): RuntimeResponse => ({
  model: config.model,
  content: [{ type: "json", value }],
  requestId,
  usage: { totalTokens: 1 },
});
const textResponse = (text: string, requestId = "request"): RuntimeResponse => ({
  model: config.model,
  content: [{ type: "text", text }],
  requestId,
  usage: { totalTokens: 1 },
});

describe("runStructuredCompletion", () => {
  it("retries repair without repeating a tool executor", async () => {
    const repairConfig = createRuntimeConfig({
      model: config.model,
      timeoutMs: 1000,
      toolLimits: config.toolLimits,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 5 },
    });
    const invalid = response({ invalid: true }, "bad");
    let calls = 0;
    let repairAttempts = 0;
    const requests: RuntimeRequest[] = [];
    const transport: RuntimeTransport = {
      converse: async (request) => {
        requests.push(request);
        calls += 1;
        if (calls === 1)
          return {
            model: config.model,
            content: [{ type: "tool-use" as const, id: "u1", name: "lookup", input: {} }],
            requestId: "tool",
            usage: { totalTokens: 1 },
          };
        if (calls === 2) return { ...invalid, usage: { totalTokens: 2 } };
        repairAttempts += 1;
        if (repairAttempts === 1) throw new TransportError("transient", "TRANSIENT");
        return { ...response(completion, "repair"), usage: { totalTokens: 3 } };
      },
    };
    let executions = 0;
    const delays: number[] = [];
    const result = await runStructuredCompletion(transport, repairConfig, {
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { found: true };
      },
      execution: {
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    });
    expect(executions).toBe(1);
    expect(calls).toBe(4);
    expect(delays).toEqual([5]);
    expect(result).toMatchObject({ repaired: true, requestId: "repair" });
    expect(result.transportCalls).toBe(4);
    expect(result.modelCompletions).toEqual([
      { model: config.model, requestId: "tool", usage: { totalTokens: 1 }, transportAttempts: 1 },
      { model: config.model, requestId: "bad", usage: { totalTokens: 2 }, transportAttempts: 1 },
      { model: config.model, requestId: "repair", usage: { totalTokens: 3 }, transportAttempts: 2 },
    ]);
    expect(requests[2]?.tools).toBeUndefined();
    expect(requests[3]?.tools).toBeUndefined();
    expect(requests[2]?.outputSchema).toEqual(requests[3]?.outputSchema);
    expect(requests[2]?.messages).toEqual(requests[3]?.messages);
  });

  it("returns a valid completion without repair", async () => {
    const transport = new ScriptTransport([response(completion)]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.completion.status).toBe("COMPLETED");
    expect(result.repaired).toBe(false);
    expect(transport.requests).toHaveLength(1);
  });

  it("retains the runAgentCompletion alias and legacy .completion result", async () => {
    const transport = new ScriptTransport([response(completion)]);
    const result = await runAgentCompletion(transport, config, { messages: [] });

    expect(result.completion).toMatchObject({
      schema_version: 1,
      run_id: "run",
      case_id: "case",
      status: "COMPLETED",
    });
    expect(result).not.toHaveProperty("value");
  });

  it("accepts exactly one text JSON object", async () => {
    const transport = new ScriptTransport([textResponse(JSON.stringify(completion))]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.repaired).toBe(false);
  });

  it("requires an executor when tools are configured", async () => {
    const transport = new ScriptTransport([]);
    await expect(
      runStructuredCompletion(transport, config, {
        messages: [],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      }),
    ).rejects.toThrow("Tool executor is required");
    expect(transport.requests).toHaveLength(0);
  });

  it("repairs once and lets repair metadata win", async () => {
    const transport = new ScriptTransport([
      response({ raw: "invalid-canary" }, "bad"),
      response(completion, "repair"),
    ]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.repaired).toBe(true);
    expect(result.requestId).toBe("repair");
    expect(transport.requests[1]?.tools).toBeUndefined();
    expect(transport.requests[1]?.messages.at(-1)?.role).toBe("user");
  });

  it("executes a tool once and repairs using the complete history without tools", async () => {
    const invalidAssistant = {
      role: "assistant" as const,
      content: [{ type: "json" as const, value: { invalid: true } }],
    };
    const transport = new ScriptTransport([
      {
        model: config.model,
        content: [{ type: "tool-use", id: "u1", name: "lookup", input: {} }],
      },
      { model: config.model, content: invalidAssistant.content, requestId: "bad" },
      { ...response(completion, "repair"), usage: { totalTokens: 9 } },
    ]);
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }];
    let executions = 0;
    const result = await runStructuredCompletion(transport, config, {
      messages,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { found: true };
      },
    });
    expect(executions).toBe(1);
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests[2]?.tools).toBeUndefined();
    expect(transport.requests[2]?.outputSchema).toBeDefined();
    const accumulatedHistory = transport.requests[1]?.messages;
    expect(accumulatedHistory).toBeDefined();
    expect(transport.requests[2]?.messages).toEqual([
      ...(accumulatedHistory ?? []),
      invalidAssistant,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Return only one valid JSON object matching the AgentCompletion schema.",
          },
        ],
      },
    ]);
    expect(result.requestId).toBe("repair");
    expect(result.usage?.totalTokens).toBe(9);
    expect(result.transportCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(result.modelCompletions).toEqual([
      { model: config.model, transportAttempts: 1 },
      { model: config.model, requestId: "bad", transportAttempts: 1 },
      { model: config.model, requestId: "repair", usage: { totalTokens: 9 }, transportAttempts: 1 },
    ]);
  });

  it("repairs mixed content exactly once", async () => {
    const transport = new ScriptTransport([
      {
        model: config.model,
        content: [
          { type: "text", text: JSON.stringify(completion) },
          { type: "text", text: "extra" },
        ],
      },
      response(completion, "repair"),
    ]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.repaired).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });

  it("throws a sanitized error after exactly one failed repair", async () => {
    const transport = new ScriptTransport([
      response({ raw: "secret-canary" }),
      response({ raw: "secret-canary" }),
    ]);
    const error = await runStructuredCompletion(transport, config, { messages: [] }).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(StructuredCompletionError);
    expect(String(error)).not.toContain("secret-canary");
    expect(transport.requests).toHaveLength(2);
  });
});

describe("defineStructuredContract", () => {
  it("derives typed parsers, provider schemas, and canonical digests for distinct contracts", () => {
    const plan = defineStructuredContract({
      name: "ProgramDesign_v1",
      version: 1,
      schema: planReportSchema,
      description: "One versioned program design",
    });
    const review = defineStructuredContract({
      name: "ReviewDecision_v1",
      version: 1,
      schema: reviewReportSchema,
    });

    const parsedPlan = plan.parse(validProgramDesign);
    const parsedReview = review.parse(validReviewDecision);

    expectTypeOf(parsedPlan).toEqualTypeOf<z.output<typeof planReportSchema>>();
    expectTypeOf(parsedReview).toEqualTypeOf<z.output<typeof reviewReportSchema>>();
    expect(plan.schema).toBe(planReportSchema);
    expect(review.schema).toBe(reviewReportSchema);
    expect(plan.outputSchema).toMatchObject({
      name: "ProgramDesign_v1",
      description: "One versioned program design",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema_version: { type: "number", const: 1 },
          artifact_kind: { type: "string", const: "ProgramDesign" },
        },
      },
    });
    expect(review.outputSchema).toMatchObject({
      name: "ReviewDecision_v1",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema_version: { type: "number", const: 1 },
          artifact_kind: { type: "string", const: "ReviewDecision" },
        },
      },
    });
    expect(plan.schemaDigest).toBe(canonicalDigest(plan.outputSchema.schema));
    expect(review.schemaDigest).toBe(canonicalDigest(review.outputSchema.schema));
    expect(plan.schemaDigest).not.toBe(review.schemaDigest);
    expect(Object.isFrozen(plan.outputSchema.schema)).toBe(true);
    const providerSchema = plan.outputSchema.schema;
    if (
      typeof providerSchema !== "object" ||
      providerSchema === null ||
      Array.isArray(providerSchema)
    )
      throw new Error("expected object JSON Schema");
    expect(Object.isFrozen(providerSchema["properties"])).toBe(true);
    expect(parsedPlan.slice_order).toEqual(["slice-a"]);
    expect(parsedReview.decision).toBe("PASS");
  });

  it("rejects invalid provider names and versions before constructing a definition", () => {
    expect(() =>
      defineStructuredContract({ name: "contains spaces", version: 1, schema: planReportSchema }),
    ).toThrow("Structured contract name");
    expect(() =>
      defineStructuredContract({ name: "ProgramDesign_v1", version: 0, schema: planReportSchema }),
    ).toThrow("positive safe integer");
    expect(() =>
      defineStructuredContract({
        name: "ProgramDesign_v1",
        version: Number.MAX_SAFE_INTEGER + 1,
        schema: planReportSchema,
      }),
    ).toThrow("positive safe integer");
  });

  it("requires a strict object with an exact schema_version matching the declaration", () => {
    expect(() =>
      defineStructuredContract({
        name: "LooseContract_v1",
        version: 1,
        schema: z.object({ schema_version: z.literal(1), result: z.string() }).passthrough(),
      }),
    ).toThrow("reject unknown properties");
    expect(() =>
      defineStructuredContract({
        name: "UnversionedContract_v1",
        version: 1,
        schema: z.strictObject({ result: z.string() }),
      }),
    ).toThrow("require schema_version");
    expect(() =>
      defineStructuredContract({
        name: "ProgramDesign_v2",
        version: 2,
        schema: planReportSchema,
      }),
    ).toThrow("must equal the declared contract version");
  });

  it("fails closed when output has a mismatched version or unknown fields", () => {
    const definition = defineStructuredContract({
      name: "ProgramDesign_v1",
      version: 1,
      schema: planReportSchema,
    });

    expect(() =>
      definition.parse({
        ...validProgramDesign,
        schema_version: 2,
      }),
    ).toThrow();
    expect(() =>
      definition.parse({
        ...validProgramDesign,
        widened_scope: true,
      }),
    ).toThrow();
  });

  it("snapshots a mutable definition input before building parser and identity", () => {
    const mutableInput: {
      name: string;
      version: number;
      schema: typeof planReportSchema | typeof reviewReportSchema;
      description: string;
    } = {
      name: "MutableProgramDesign_v1",
      version: 1,
      schema: planReportSchema,
      description: "original description",
    };
    const definition = defineStructuredContract(mutableInput);
    const originalDigest = definition.schemaDigest;
    const originalOutputSchema = definition.outputSchema;

    mutableInput.name = "MutatedReviewDecision_v2";
    mutableInput.version = 2;
    mutableInput.schema = reviewReportSchema;
    mutableInput.description = "mutated description";

    expect(definition.name).toBe("MutableProgramDesign_v1");
    expect(definition.version).toBe(1);
    expect(definition.schema).toBe(planReportSchema);
    expect(definition.schemaDigest).toBe(originalDigest);
    expect(definition.outputSchema).toBe(originalOutputSchema);
    expect(definition.outputSchema.description).toBe("original description");
    expect(definition.parse(validProgramDesign)).toMatchObject({
      schema_version: 1,
      artifact_kind: "ProgramDesign",
    });
    expect(() => definition.parse(validReviewDecision)).toThrow();
  });
});

describe("runStructuredContract", () => {
  it("returns a typed value with complete pinned provenance", async () => {
    const transport = new ScriptTransport([response(validProgramDesign, "program-design-request")]);

    const result = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v3",
      messages: [],
    });

    expectTypeOf(result.value).toEqualTypeOf<z.output<typeof planReportSchema>>();
    expect(result.value.artifact_kind).toBe("ProgramDesign");
    expect(result).toMatchObject({
      model: config.model,
      stage: EngineeringStage.PROGRAM_DESIGN,
      schemaName: "ProgramDesign_v1",
      schemaVersion: 1,
      schemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v3",
      requestId: "program-design-request",
      usage: { totalTokens: 1 },
      repaired: false,
      transportCalls: 1,
      toolIterations: 0,
      toolCalls: 0,
      modelCompletions: [
        {
          model: config.model,
          requestId: "program-design-request",
          usage: { totalTokens: 1 },
          transportAttempts: 1,
        },
      ],
    });
    expect(transport.requests[0]?.outputSchema).toBe(programDesignDefinition.outputSchema);
  });

  it("fails closed on an expected schema digest mismatch before transport", async () => {
    const transport = new ScriptTransport([response(validProgramDesign)]);
    const secretExpectedDigest = `sha256:${"b".repeat(64)}`;

    const error = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: secretExpectedDigest,
      promptVersion: "v1",
      messages: [],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(StructuredSchemaIdentityError);
    expect(String(error)).not.toContain(secretExpectedDigest);
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects a mismatched response identity before executing tool-use", async () => {
    let executions = 0;
    const transport = new ScriptTransport([
      {
        model: { provider: "unexpected-provider", model_id: "unexpected-model" },
        content: [{ type: "tool-use", id: "tool-1", name: "lookup", input: {} }],
      },
    ]);

    const error = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v1",
      messages: [],
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { leaked: true };
      },
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(StructuredModelIdentityError);
    expect(String(error)).not.toContain("unexpected-provider");
    expect(String(error)).not.toContain("unexpected-model");
    expect(executions).toBe(0);
    expect(transport.requests).toHaveLength(1);
  });

  it("checks every response identity and preserves tool-loop metadata", async () => {
    let executions = 0;
    const transport = new ScriptTransport([
      {
        model: config.model,
        content: [{ type: "tool-use", id: "tool-1", name: "lookup", input: {} }],
        requestId: "tool-request",
      },
      {
        model: { provider: config.model.provider, model_id: "swapped-model" },
        content: [{ type: "json", value: validProgramDesign }],
      },
    ]);

    await expect(
      runStructuredContract(transport, config, {
        definition: programDesignDefinition,
        stage: EngineeringStage.PROGRAM_DESIGN,
        expectedSchemaDigest: programDesignDefinition.schemaDigest,
        promptVersion: "v1",
        messages: [],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        execute: async () => {
          executions += 1;
          return { found: true };
        },
      }),
    ).rejects.toBeInstanceOf(StructuredModelIdentityError);
    expect(executions).toBe(1);
    expect(transport.requests).toHaveLength(2);
  });

  it("repairs once without tools and reports repair provenance", async () => {
    const transport = new ScriptTransport([
      response({ malformed: true }, "malformed-request"),
      response(validProgramDesign, "repair-request"),
    ]);

    const result = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "engineering.v1",
      messages: [],
    });

    expect(result).toMatchObject({
      repaired: true,
      transportCalls: 2,
      toolIterations: 0,
      toolCalls: 0,
      requestId: "repair-request",
      promptVersion: "engineering.v1",
    });
    expect(result.modelCompletions).toHaveLength(2);
    expect(transport.requests[1]?.tools).toBeUndefined();
    expect(transport.requests[1]?.outputSchema).toBe(programDesignDefinition.outputSchema);
  });

  it("never repairs a malformed implementation report", async () => {
    const invalidCanary = "malformed-implementation-canary";
    const transport = new ScriptTransport([
      response({ malformed: invalidCanary }, "implementation-report"),
      response(validProgramDesign, "forbidden-repair"),
    ]);

    const error = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.SLICE_IMPLEMENTATION,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v1",
      messages: [],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(StructuredContractOutputError);
    expect(String(error)).not.toContain(invalidCanary);
    expect(transport.requests).toHaveLength(1);
  });

  it("bounds a read-only malformed output to exactly one repair", async () => {
    const invalidCanary = "malformed-read-only-canary";
    const transport = new ScriptTransport([
      response({ malformed: invalidCanary }, "initial-invalid"),
      response({ malformed: invalidCanary }, "repair-invalid"),
      response(validProgramDesign, "forbidden-second-repair"),
    ]);

    const error = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v1",
      messages: [],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(StructuredContractOutputError);
    expect(String(error)).not.toContain(invalidCanary);
    expect(transport.requests).toHaveLength(2);
  });

  it("repairs from complete tool-loop history without exposing tools to repair", async () => {
    const initialMessages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "design" }] },
    ];
    const toolUseContent = [{ type: "tool-use" as const, id: "tool-1", name: "lookup", input: {} }];
    const invalidContent = [{ type: "json" as const, value: { malformed: true } }];
    const transport = new ScriptTransport([
      { model: config.model, content: toolUseContent, requestId: "tool-request" },
      { model: config.model, content: invalidContent, requestId: "invalid-request" },
      response(validProgramDesign, "repair-request"),
    ]);
    let executions = 0;

    const result = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v1",
      messages: initialMessages,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { found: true };
      },
    });

    expect(executions).toBe(1);
    expect(result).toMatchObject({
      repaired: true,
      transportCalls: 3,
      toolIterations: 1,
      toolCalls: 1,
      requestId: "repair-request",
    });
    expect(result.modelCompletions).toHaveLength(3);
    expect(transport.requests[2]?.tools).toBeUndefined();
    expect(transport.requests[2]?.outputSchema).toBe(programDesignDefinition.outputSchema);
    expect(transport.requests[2]?.messages).toEqual([
      ...initialMessages,
      { role: "assistant", content: toolUseContent },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "tool-1",
            output: {
              ok: true,
              value: { found: true },
              progress: { tool_iterations_remaining: 1, tool_calls_remaining: 1 },
            },
          },
        ],
      },
      { role: "assistant", content: invalidContent },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Return only one valid JSON object matching ProgramDesign_v1 schema version 1.",
          },
        ],
      },
    ]);
  });

  it.each([
    ["initial cancellation", "initial", new RuntimeCancelledError(), "CANCELLED", 1],
    ["repair cancellation", "repair", new RuntimeCancelledError(), "CANCELLED", 2],
    ["initial timeout", "initial", new RuntimeTimeoutError(), "TIMEOUT", 1],
    ["repair timeout", "repair", new RuntimeTimeoutError(), "TIMEOUT", 2],
  ] as const)(
    "preserves %s as an operational error",
    async (_name, phase, operational, code, calls) => {
      let transportCalls = 0;
      const transport: RuntimeTransport = {
        converse: async () => {
          transportCalls += 1;
          if (phase === "repair" && transportCalls === 1) return response({ malformed: true });
          throw operational;
        },
      };

      const error = await runStructuredContract(transport, config, {
        definition: programDesignDefinition,
        stage: EngineeringStage.PROGRAM_DESIGN,
        expectedSchemaDigest: programDesignDefinition.schemaDigest,
        promptVersion: "v1",
        messages: [],
      }).catch((value: unknown) => value);

      expect(error).toBe(operational);
      expect(error).toMatchObject({ code });
      expect(error).not.toBeInstanceOf(StructuredContractOutputError);
      expect(transportCalls).toBe(calls);
    },
  );

  it("preserves repair response identity failures", async () => {
    const transport = new ScriptTransport([
      response({ malformed: true }, "initial-invalid"),
      {
        model: { provider: "unexpected-provider", model_id: "unexpected-model" },
        content: [{ type: "json", value: validProgramDesign }],
      },
    ]);

    const error = await runStructuredContract(transport, config, {
      definition: programDesignDefinition,
      stage: EngineeringStage.PROGRAM_DESIGN,
      expectedSchemaDigest: programDesignDefinition.schemaDigest,
      promptVersion: "v1",
      messages: [],
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(StructuredModelIdentityError);
    expect(error).not.toBeInstanceOf(StructuredContractOutputError);
    expect(transport.requests).toHaveLength(2);
  });
});
