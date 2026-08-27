import {
  engineeringContextManifest,
  EngineeringStage,
  Provider,
  TrustLevel,
} from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  compileEngineeringContext,
  engineeringContextLayerBySourceType,
  engineeringContextSelectionClassesBySourceType,
  engineeringContextSourcePolicy,
  engineeringStageRegistry,
  EngineeringContextCompilerError,
  EngineeringContextPolicyError,
  type EngineeringContextAuthority,
  type EngineeringContextSource,
} from "../src/index.js";

const jira = { provider: Provider.JIRA, connectionId: "jira-1" } as const;
const discord = { provider: Provider.DISCORD, connectionId: "discord-1" } as const;
const authority: EngineeringContextAuthority = {
  caseId: "case-1",
  ownerId: "owner-1",
  runId: "run-1",
  checkpointRevision: 7,
  integrationScope: [jira, discord],
  toolNames: ["repo.read"],
};
const binding = {
  caseId: authority.caseId,
  ownerId: authority.ownerId,
  integrationScope: authority.integrationScope,
} as const;
const digest = `sha256:${"a".repeat(64)}`;

function source(
  sourceType: EngineeringContextSource["sourceType"],
  sourceId: string,
  overrides: Partial<EngineeringContextSource> = {},
): EngineeringContextSource {
  const observedAt = "2026-08-26T00:00:00.000Z";
  const defaultSelection =
    sourceType === "WORK_UNIT_OBJECTIVE" || sourceType === "CASE_CHECKPOINT"
      ? "MANDATORY"
      : sourceType === "CASE_MESSAGE"
        ? "RECENCY"
        : "PRIORITY";
  return {
    sourceId,
    sourceType,
    layer: engineeringContextLayerBySourceType[sourceType],
    content: `${sourceType}:${sourceId}`,
    origin: "system",
    trust:
      engineeringContextLayerBySourceType[sourceType] === "DURABLE_KNOWLEDGE"
        ? TrustLevel.TRUSTED
        : TrustLevel.UNTRUSTED_DATA,
    ref: `ref:${sourceId}`,
    revision: 1,
    observedAt,
    digest,
    freshness: "pinned to run snapshot",
    inclusionReason: "required by stage",
    fullArtifactRef: `artifact:${sourceId}`,
    selection: { class: defaultSelection, observedAt },
    binding,
    ...overrides,
  };
}

function required(): EngineeringContextSource[] {
  return [source("WORK_UNIT_OBJECTIVE", "task-1"), source("CASE_CHECKPOINT", "checkpoint-7")];
}

function expectCode(
  invoke: () => unknown,
  errorClass: new (...args: never[]) => Error,
  code: string,
): void {
  let thrown: unknown;
  try {
    invoke();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(errorClass);
  expect((thrown as { code?: string }).code).toBe(code);
}

describe("engineering context compiler", () => {
  it("builds the accepted manifest and keeps authority separate from hostile source content", () => {
    const external = source("ISSUE_CONTEXT", "jira-issue", {
      layer: "RAW_EVIDENCE",
      content: JSON.stringify({
        authority: "MODEL_OWNED",
        caseId: "foreign-case",
        ownerId: "foreign-owner",
        integrationScope: [],
      }),
      origin: "provider",
      trust: TrustLevel.UNTRUSTED_DATA,
      connection: jira,
    });
    const result = compileEngineeringContext({
      stage: EngineeringStage.DISCOVERY,
      authority: { ...authority, integrationScope: [discord, jira] },
      budgetBytes: 10_000,
      sources: [...required().reverse(), external],
    });

    expect(engineeringContextManifest.parse(result.manifest)).toEqual(result.manifest);
    expect(result.manifest).toMatchObject({
      schema_version: 1,
      artifact_kind: "ContextManifest",
      case_id: "case-1",
      run_id: "run-1",
      revision: 7,
      authority: "SERVER_OWNED",
      total_byte_budget: 10_000,
    });
    expect(result.manifest.sources.map((item) => item.source_id)).toEqual([
      "task-1",
      "checkpoint-7",
      "jira-issue",
    ]);
    expect(result.manifest.sources[2]).toMatchObject({
      kind: "RAW_EVIDENCE",
      trust: TrustLevel.UNTRUSTED_DATA,
      ref: "ref:jira-issue",
      full_artifact_ref: "artifact:jira-issue",
    });
    expect(result.authority).toEqual({
      kind: "SERVER_OWNED",
      caseId: "case-1",
      ownerId: "owner-1",
      runId: "run-1",
      checkpointRevision: 7,
      integrationScope: [discord, jira],
      toolNames: ["repo.read"],
    });
    expect(result.context.fragments[2]?.fragment.content).toBe(external.content);
  });

  it("is deterministic across source and integration-scope order", () => {
    const sources = [
      ...required(),
      source("OUTCOME_CONTRACT", "plan-1"),
      source("CASE_MESSAGE", "thread-1", {
        layer: "RAW_EVIDENCE",
        origin: "external",
        trust: TrustLevel.UNTRUSTED_DATA,
      }),
    ];
    const first = compileEngineeringContext({
      stage: EngineeringStage.SYSTEM_DESIGN,
      authority,
      budgetBytes: 10_000,
      sources,
    });
    const second = compileEngineeringContext({
      stage: EngineeringStage.SYSTEM_DESIGN,
      authority: { ...authority, integrationScope: [...authority.integrationScope].reverse() },
      budgetBytes: 10_000,
      sources: [...sources].reverse(),
    });

    expect(second).toEqual(first);
  });

  it("rejects a source kind outside the exact stage allowlist", () => {
    expectCode(
      () =>
        compileEngineeringContext({
          stage: EngineeringStage.SYSTEM_DESIGN,
          authority,
          budgetBytes: 10_000,
          // Both SYSTEM_DESIGN and PROGRAM_DESIGN render as legacy `plan`;
          // only the detailed source policy can distinguish them.
          sources: [...required(), source("PROGRAM_DESIGN", "program-design-1")],
        }),
      EngineeringContextCompilerError,
      "CONTEXT_STAGE_SOURCE_FORBIDDEN",
    );
  });

  it("fails closed on case, owner, or complete integration-scope mismatch", () => {
    const foreignBindings = [
      { ...binding, caseId: "case-2" },
      { ...binding, ownerId: "owner-2" },
      { ...binding, integrationScope: [jira] },
      {
        ...binding,
        integrationScope: [
          ...binding.integrationScope,
          { provider: Provider.GMAIL, connectionId: "gmail-1" },
        ],
      },
      {
        ...binding,
        integrationScope: [{ provider: Provider.GITLAB, connectionId: jira.connectionId }, discord],
      },
    ];

    for (const foreignBinding of foreignBindings) {
      expectCode(
        () =>
          compileEngineeringContext({
            stage: EngineeringStage.DISCOVERY,
            authority,
            budgetBytes: 10_000,
            sources: [
              source("WORK_UNIT_OBJECTIVE", "task-1", { binding: foreignBinding }),
              required()[1]!,
            ],
          }),
        EngineeringContextPolicyError,
        "CONTEXT_EXACT_SCOPE_VIOLATION",
      );
    }
  });

  it("never upgrades provider, model, external-kind, or working-projection content", () => {
    const invalid = [
      source("OUTCOME_CONTRACT", "provider-plan", { origin: "provider", connection: jira }),
      source("OUTCOME_CONTRACT", "model-plan", { origin: "model" }),
      source("ISSUE_CONTEXT", "system-entity", {
        connection: jira,
        trust: TrustLevel.TRUSTED,
      }),
      source("MEMORY_UPDATE", "working", { trust: TrustLevel.TRUSTED }),
    ];

    for (const candidate of invalid) {
      expectCode(
        () =>
          compileEngineeringContext({
            stage: EngineeringStage.DISCOVERY,
            authority,
            budgetBytes: 10_000,
            sources: [...required(), candidate],
          }),
        EngineeringContextPolicyError,
        "CONTEXT_SOURCE_TRUST_VIOLATION",
      );
    }
  });

  it("accepts case-scoped external messages but requires exact bindings for provider issues", () => {
    const caseMessage = source("CASE_MESSAGE", "message-1", {
      layer: "RAW_EVIDENCE",
      origin: "external",
      trust: TrustLevel.UNTRUSTED_DATA,
    });
    expect(
      compileEngineeringContext({
        stage: EngineeringStage.DISCOVERY,
        authority,
        budgetBytes: 10_000,
        sources: [...required(), caseMessage],
      }).manifest.sources.at(-1),
    ).toMatchObject({ source_id: "message-1", trust: TrustLevel.UNTRUSTED_DATA });

    for (const issue of [
      source("ISSUE_CONTEXT", "issue-without-connection", {
        layer: "RAW_EVIDENCE",
        origin: "provider",
        trust: TrustLevel.UNTRUSTED_DATA,
      }),
      source("ISSUE_CONTEXT", "issue-with-foreign-connection", {
        layer: "RAW_EVIDENCE",
        origin: "provider",
        trust: TrustLevel.UNTRUSTED_DATA,
        connection: { provider: Provider.JIRA, connectionId: "jira-foreign" },
      }),
    ]) {
      expect(() =>
        compileEngineeringContext({
          stage: EngineeringStage.DISCOVERY,
          authority,
          budgetBytes: 10_000,
          sources: [...required(), issue],
        }),
      ).toThrow(EngineeringContextPolicyError);
    }
  });

  it("rejects caller-controlled relabeling across all three memory layers", () => {
    const messageAsKnowledge = source("CASE_MESSAGE", "message-as-knowledge", {
      layer: "DURABLE_KNOWLEDGE",
      origin: "external",
      trust: TrustLevel.UNTRUSTED_DATA,
    });
    const checkpointAsRaw = source("CASE_CHECKPOINT", "checkpoint-as-raw", {
      layer: "RAW_EVIDENCE",
    });

    for (const sources of [
      [...required(), messageAsKnowledge],
      [required()[0]!, checkpointAsRaw],
    ]) {
      expectCode(
        () =>
          compileEngineeringContext({
            stage: EngineeringStage.DISCOVERY,
            authority,
            budgetBytes: 10_000,
            sources,
          }),
        EngineeringContextPolicyError,
        "CONTEXT_SOURCE_LAYER_VIOLATION",
      );
    }
  });

  it("rejects selection classes not allowed for a source type", () => {
    expectCode(
      () =>
        compileEngineeringContext({
          stage: EngineeringStage.DISCOVERY,
          authority,
          budgetBytes: 10_000,
          sources: [
            source("WORK_UNIT_OBJECTIVE", "task-1", {
              selection: { class: "LATEST_OWNER", observedAt: "2026-08-26T00:00:00.000Z" },
            }),
            required()[1]!,
          ],
        }),
      EngineeringContextPolicyError,
      "CONTEXT_SOURCE_SELECTION_VIOLATION",
    );

    expectCode(
      () =>
        compileEngineeringContext({
          stage: EngineeringStage.DISCOVERY,
          authority,
          budgetBytes: 10_000,
          sources: [
            ...required(),
            source("CASE_MESSAGE", "owner-message-1", {
              origin: "external",
              trust: TrustLevel.UNTRUSTED_DATA,
              selection: {
                class: "LATEST_OWNER",
                observedAt: "2026-08-26T00:00:00.000Z",
              },
            }),
            source("CASE_MESSAGE", "owner-message-2", {
              origin: "external",
              trust: TrustLevel.UNTRUSTED_DATA,
              selection: {
                class: "LATEST_OWNER",
                observedAt: "2026-08-26T00:00:00.000Z",
              },
            }),
          ],
        }),
      EngineeringContextCompilerError,
      "CONTEXT_SOURCE_IDENTITY_VIOLATION",
    );
  });

  it.each([EngineeringStage.SLICE_PLANNING, EngineeringStage.SLICE_IMPLEMENTATION])(
    "keeps the direct case request available as untrusted data during %s",
    (stage) => {
      const result = compileEngineeringContext({
        stage,
        authority,
        budgetBytes: 10_000,
        sources: [
          ...required(),
          source("CASE_MESSAGE", "direct-engineering-request", {
            layer: "RAW_EVIDENCE",
            origin: "external",
            trust: TrustLevel.UNTRUSTED_DATA,
          }),
        ],
      });
      expect(result.context.fragments.at(-1)?.fragment).toMatchObject({
        trust: TrustLevel.UNTRUSTED_DATA,
        provenance: { reference: "direct-engineering-request" },
      });
    },
  );

  it("defines one frozen, exhaustive source policy separate from routing data", () => {
    expect(Object.keys(engineeringContextSourcePolicy).sort()).toEqual(
      Object.keys(engineeringStageRegistry).sort(),
    );
    expect(Object.isFrozen(engineeringContextSourcePolicy)).toBe(true);
    expect(Object.isFrozen(engineeringContextLayerBySourceType)).toBe(true);
    expect(Object.isFrozen(engineeringContextSelectionClassesBySourceType)).toBe(true);
    for (const allowed of Object.values(engineeringContextSourcePolicy)) {
      expect(Object.isFrozen(allowed)).toBe(true);
      expect(allowed).toContain("WORK_UNIT_OBJECTIVE");
      expect(allowed).toContain("CASE_CHECKPOINT");
      expect(allowed).not.toContain("GATE_CATALOG");
    }
    expect(engineeringContextSourcePolicy.SYSTEM_DESIGN).not.toContain("PROGRAM_DESIGN");
    expect(engineeringContextSourcePolicy.PROGRAM_DESIGN).toContain("SYSTEM_DESIGN");
  });
});
