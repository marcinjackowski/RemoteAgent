import { describe, expect, it } from "vitest";

import {
  FULL_FLOW_BENCHMARK_ID,
  TEXT_FLOW_BENCHMARK_ID,
  selectMobl2023LiveProfile,
} from "./engineering-live-profile.js";
import { FULL_FLOW_EVALUATOR_EXPECTATIONS } from "./engineering-live-full-flow-evaluators.js";

const manifest = (benchmark_id: string, evaluation: string) => ({
  benchmark_id,
  projection_versions: { evaluation },
});

describe("MOBL-2023 text-only profile", () => {
  it("selects the reserved text profile and retains the old profile", () => {
    expect(selectMobl2023LiveProfile(manifest(TEXT_FLOW_BENCHMARK_ID, "full-flow-text-v1"))).toBe(
      "full-flow-text-v1",
    );
    expect(selectMobl2023LiveProfile(manifest(FULL_FLOW_BENCHMARK_ID, "full-flow-v1"))).toBe(
      "full-flow-v1",
    );
  });

  it.each([
    ["v1", TEXT_FLOW_BENCHMARK_ID],
    ["full-flow-text-v1", FULL_FLOW_BENCHMARK_ID],
  ])("rejects cross-profile pairing %s/%s", (evaluation, benchmark_id) => {
    expect(() => selectMobl2023LiveProfile(manifest(benchmark_id, evaluation))).toThrow(
      /reserved|requires|unsupported/u,
    );
  });

  it("pins nine text selectors and three trusted input paths", () => {
    const expectation = FULL_FLOW_EVALUATOR_EXPECTATIONS.text;
    expect(expectation.gateId).toBe("ios-text-flow-model-tests-final");
    expect(expectation.requiredTestIds).toHaveLength(9);
    expect(expectation.inputPaths).toHaveLength(3);
    expect(expectation.inputPaths.some((path) => path.includes("VoiceTests"))).toBe(false);
    expect(expectation.requiredTestIds.some((id) => id.includes("VoiceTests"))).toBe(false);
    expect(expectation.qualifiedArgv.some((arg) => arg.includes("VoiceTests"))).toBe(false);
    expect(
      expectation.qualifiedArgv.filter((arg) => arg.startsWith("-only-testing:")),
    ).toHaveLength(9);
    expect(Object.isFrozen(expectation)).toBe(true);
    expect(Object.isFrozen(expectation.inputPaths)).toBe(true);
    expect(Object.isFrozen(expectation.requiredTestIds)).toBe(true);
    expect(Object.isFrozen(expectation.qualifiedArgv)).toBe(true);
    expect(expectation.inputDigest).toBe(
      "sha256:1823cf8866e8a0b93e219fde2f5829097f6e159ea751de7207af44f92aedfc50",
    );
  });
});
