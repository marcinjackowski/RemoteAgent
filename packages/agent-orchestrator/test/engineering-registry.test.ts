import { readFile } from "node:fs/promises";

import { AgentRole } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  EngineeringStage,
  engineeringProcessGraphs,
  engineeringStageRegistry,
} from "../src/index.js";
import * as engineeringRegistryModule from "../src/engineering/registry.js";

const mandatorySliceStages = [
  EngineeringStage.SLICE_PLANNING,
  EngineeringStage.SLICE_IMPLEMENTATION,
  EngineeringStage.GATE_EXECUTION,
  EngineeringStage.SLICE_REVIEW,
  EngineeringStage.MEMORY_PROJECTION,
];

describe("engineering stage registry", () => {
  it("keeps risk-proportional design stages while preserving the full evidence loop", () => {
    expect(engineeringProcessGraphs.SMALL.design_stages).toEqual([EngineeringStage.DISCOVERY]);
    expect(engineeringProcessGraphs.MEDIUM.design_stages).toEqual([
      EngineeringStage.DISCOVERY,
      EngineeringStage.SYSTEM_DESIGN,
      EngineeringStage.PROGRAM_DESIGN,
    ]);
    expect(engineeringProcessGraphs.LARGE_OR_HIGH_RISK.design_stages).toEqual([
      EngineeringStage.DISCOVERY,
      EngineeringStage.OUTCOME_DEFINITION,
      EngineeringStage.SYSTEM_DESIGN,
      EngineeringStage.PROGRAM_DESIGN,
      EngineeringStage.DESIGN_APPROVAL,
    ]);

    for (const graph of Object.values(engineeringProcessGraphs)) {
      expect(graph.slice_loop_stages).toEqual(mandatorySliceStages);
      expect(graph.completion_stages).toEqual([
        EngineeringStage.FINAL_VERIFICATION,
        EngineeringStage.LOCAL_COMMIT,
      ]);
    }
  });

  it("assigns workspace writes only to explicit implementer-owned system stages", () => {
    const writers = Object.entries(engineeringStageRegistry).filter(
      ([, definition]) => definition.workspace_access === "WRITE",
    );

    expect(writers).toEqual([
      [
        EngineeringStage.SLICE_IMPLEMENTATION,
        expect.objectContaining({ role: AgentRole.IMPLEMENTER }),
      ],
      [
        EngineeringStage.LOCAL_COMMIT,
        expect.objectContaining({ role: AgentRole.IMPLEMENTER, completion_contract: null }),
      ],
    ]);
    expect(
      Object.values(engineeringStageRegistry)
        .filter((definition) => definition.role !== AgentRole.IMPLEMENTER)
        .every((definition) => definition.workspace_access === "READ_ONLY"),
    ).toBe(true);
  });

  it("maps every graph stage to immutable routing data and a known contract", () => {
    const reachableStages = new Set(
      Object.values(engineeringProcessGraphs).flatMap((graph) => [
        ...graph.design_stages,
        ...graph.slice_loop_stages,
        ...graph.completion_stages,
      ]),
    );

    expect(reachableStages).toEqual(new Set(Object.values(EngineeringStage)));
    for (const definition of Object.values(engineeringStageRegistry)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.input_artifacts)).toBe(true);
      expect(Object.isFrozen(definition.output_artifacts)).toBe(true);
      expect(definition.input_artifacts.every((name) => name.startsWith("Engineering"))).toBe(true);
      expect(definition.output_artifacts.every((name) => name.startsWith("Engineering"))).toBe(
        true,
      );
    }
    expect(engineeringStageRegistry.GATE_EXECUTION).toMatchObject({
      completion_contract: null,
      output_artifacts: ["EngineeringEvidenceBundle"],
    });
  });

  it("never requires an artifact that the selected risk graph cannot produce", () => {
    for (const graph of Object.values(engineeringProcessGraphs)) {
      const available = new Set(["EngineeringContextManifest"]);
      const stages = [
        ...graph.design_stages,
        ...graph.slice_loop_stages,
        ...graph.completion_stages,
      ];
      for (const stage of stages) {
        const definition = engineeringStageRegistry[stage];
        for (const required of definition.input_artifacts)
          expect(available.has(required)).toBe(true);
        for (const produced of definition.output_artifacts) available.add(produced);
      }
    }
  });

  it("exports data only and cannot become a second control plane", async () => {
    expect(Object.keys(engineeringRegistryModule).sort()).toEqual(
      ["EngineeringStage", "engineeringProcessGraphs", "engineeringStageRegistry"].sort(),
    );

    const source = await readFile(
      new URL("../src/engineering/registry.ts", import.meta.url),
      "utf8",
    );
    for (const forbiddenAuthority of [
      "claim(",
      "enqueue(",
      "transition(",
      "finalize(",
      "class EngineeringRuntime",
    ]) {
      expect(source).not.toContain(forbiddenAuthority);
    }

    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies).not.toHaveProperty("@remoteagent/database");
  });
});
