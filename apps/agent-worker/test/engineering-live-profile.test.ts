import { describe, expect, it } from "vitest";

import { FULL_FLOW_BENCHMARK_ID, selectMobl2023LiveProfile } from "./engineering-live-profile.js";

const manifest = (benchmark_id: string, evaluation?: string) => ({
  benchmark_id,
  projection_versions: evaluation === undefined ? {} : { evaluation },
});

describe("MOBL-2023 explicit live profile selector", () => {
  it.each(["synthetic-ios", "benchmark-20260907-changelog", "legacy-other-id"])(
    "keeps arbitrary non-reserved ID %s on the legacy profile",
    (benchmark_id) => {
      expect(selectMobl2023LiveProfile(manifest(benchmark_id, "v1"))).toBe("legacy");
    },
  );

  it("selects full-flow-v1 only for its exact reserved ID", () => {
    expect(selectMobl2023LiveProfile(manifest(FULL_FLOW_BENCHMARK_ID, "full-flow-v1"))).toBe(
      "full-flow-v1",
    );
  });

  it.each([
    ["full-flow-v1", "legacy-id"],
    ["v1", FULL_FLOW_BENCHMARK_ID],
  ])("rejects evaluation %s with benchmark ID %s", (evaluation, benchmark_id) => {
    expect(() => selectMobl2023LiveProfile(manifest(benchmark_id, evaluation))).toThrow();
  });

  it.each(["experimental", "", undefined])(
    "rejects unknown or missing evaluation %s",
    (evaluation) => {
      expect(() => selectMobl2023LiveProfile(manifest("legacy-id", evaluation))).toThrow(
        /unsupported|missing/u,
      );
    },
  );
});
