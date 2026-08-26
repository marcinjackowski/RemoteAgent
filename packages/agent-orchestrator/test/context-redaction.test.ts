import { EngineeringStage, TrustLevel } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import { compileEngineeringContext } from "../src/context/compiler.js";
import { CONTEXT_ARTIFACT_INLINE_BYTES, clipArtifact } from "../src/context/redaction.js";
import { engineeringContextLayerBySourceType } from "../src/context/source-policy.js";
import type { EngineeringContextSource } from "../src/context/types.js";

const digest = `sha256:${"a".repeat(64)}`;
const observedAt = "2026-08-26T12:00:00.000Z";
const binding = { caseId: "case-1", ownerId: "owner-1", integrationScope: [] } as const;

function source(
  sourceType: EngineeringContextSource["sourceType"],
  sourceId: string,
  content: string,
): EngineeringContextSource {
  return {
    sourceId,
    sourceType,
    layer: engineeringContextLayerBySourceType[sourceType],
    content,
    origin: sourceType === "CASE_CHECKPOINT" ? "model" : "system",
    trust: sourceType === "WORK_UNIT_OBJECTIVE" ? TrustLevel.TRUSTED : TrustLevel.UNTRUSTED_DATA,
    ref: `ref:${sourceId}`,
    revision: 0,
    observedAt,
    digest,
    freshness: "fresh owner@example.test",
    inclusionReason: "needed +48 501 234 567",
    fullArtifactRef: `artifact:${sourceId}`,
    selection: {
      class:
        sourceType === "WORK_UNIT_OBJECTIVE" || sourceType === "CASE_CHECKPOINT"
          ? "MANDATORY"
          : sourceType === "CASE_MESSAGE"
            ? "RECENCY"
            : "PRIORITY",
      observedAt,
    },
    binding,
  };
}

function compile(extra: EngineeringContextSource[] = [], knownSecrets: readonly string[] = []) {
  return compileEngineeringContext({
    stage: extra.some(({ sourceType }) => sourceType === "DIFF_EXCERPT")
      ? EngineeringStage.GATE_EXECUTION
      : EngineeringStage.DISCOVERY,
    authority: {
      ...binding,
      runId: "run-1",
      checkpointRevision: 0,
      toolNames: [],
    },
    budgetBytes: 100_000,
    sources: [
      source("WORK_UNIT_OBJECTIVE", "objective", "fix TOPSECRET"),
      source("CASE_CHECKPOINT", "checkpoint", "mail owner@example.test path /Users/alice/repo"),
      ...extra,
    ],
    knownSecrets,
  });
}

describe("context output redaction boundary", () => {
  it("masks secret, PII and host paths before context and manifest", () => {
    const result = compile([], ["TOPSECRET"]);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "TOPSECRET",
      "owner@example.test",
      "+48 501 234 567",
      "/Users/alice",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("fails closed when a ref, authority identifier, or tool name contains sensitive data", () => {
    expect(() => compile([source("ISSUE_CONTEXT", "owner@example.test", "safe")])).toThrow(
      /safe opaque identifier/,
    );
    expect(() =>
      compile(
        [{ ...source("CASE_MESSAGE", "message-safe", "safe"), ref: "known-secret" }],
        ["known-secret"],
      ),
    ).toThrow(/safe opaque identifier/);
    expect(() =>
      compileEngineeringContext({
        stage: EngineeringStage.DISCOVERY,
        authority: {
          ...binding,
          caseId: "owner@example.test",
          runId: "run-1",
          checkpointRevision: 0,
          toolNames: [],
        },
        budgetBytes: 1000,
        sources: [],
      }),
    ).toThrow(/safe opaque identifier/);
    expect(() =>
      compileEngineeringContext({
        stage: EngineeringStage.DISCOVERY,
        authority: {
          ...binding,
          ownerId: "known-owner-literal",
          runId: "run-1",
          checkpointRevision: 0,
          toolNames: [],
        },
        budgetBytes: 1000,
        sources: [],
        knownSecrets: ["known-owner-literal"],
      }),
    ).toThrow(/safe opaque identifier/);
    expect(() =>
      compileEngineeringContext({
        stage: EngineeringStage.DISCOVERY,
        authority: {
          ...binding,
          runId: "run-1",
          checkpointRevision: 0,
          toolNames: ["unsafe-tool-literal"],
        },
        budgetBytes: 1000,
        sources: [],
        knownSecrets: ["unsafe-tool-literal"],
      }),
    ).toThrow(/safe opaque identifier/);
  });

  it("redacts before clipping and retains a code-point-safe marker, full ref and digest", () => {
    const tail = `Bearer TOPSECRET ${"a".repeat(CONTEXT_ARTIFACT_INLINE_BYTES)}😀tail`;
    const result = compile([source("DIFF_EXCERPT", "diff", tail)], ["TOPSECRET"]);
    const clipped = result.context.fragments.find(
      ({ fragment }) => fragment.provenance.reference === "diff",
    )!.fragment.content;
    expect(new TextEncoder().encode(clipped).byteLength).toBe(CONTEXT_ARTIFACT_INLINE_BYTES);
    expect(clipped).not.toContain("TOPSECRET");
    expect(clipped).toContain("[TRUNCATED full_ref=artifact:diff");
    expect(clipped).toContain(digest);
    expect(clipped).not.toMatch(/[\uD800-\uDFFF]$/u);

    expect(clipArtifact(`${"x".repeat(200)}😀tail`, 160, "artifact:x", digest)).toContain(
      "[TRUNCATED",
    );
    const marker = `\n[TRUNCATED full_ref=artifact:x digest=${digest}]`;
    const boundary = clipArtifact(
      `A😀${"z".repeat(200)}`,
      new TextEncoder().encode(marker).byteLength + 4,
      "artifact:x",
      digest,
    );
    expect(boundary).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});
