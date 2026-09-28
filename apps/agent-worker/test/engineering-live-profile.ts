export const FULL_FLOW_BENCHMARK_ID = "MOBL-2023-full-flow-v1" as const;
export const TEXT_FLOW_BENCHMARK_ID = "MOBL-2023-full-flow-text-v1" as const;

export type Mobl2023LiveProfile = "legacy" | "full-flow-v1" | "full-flow-text-v1";

type ProfileManifestInput = Readonly<{
  benchmark_id: string;
  projection_versions?: Readonly<{ evaluation?: string }>;
}>;

/** Select only a code-owned benchmark profile from the already validated manifest. */
export function selectMobl2023LiveProfile(input: ProfileManifestInput): Mobl2023LiveProfile {
  const evaluation = input.projection_versions?.evaluation;
  if (evaluation === "v1") {
    if (input.benchmark_id === FULL_FLOW_BENCHMARK_ID)
      throw new Error("reserved full-flow benchmark ID requires evaluation full-flow-v1");
    if (input.benchmark_id === TEXT_FLOW_BENCHMARK_ID)
      throw new Error("reserved text-flow benchmark ID requires evaluation full-flow-text-v1");
    return "legacy";
  }
  if (evaluation === "full-flow-v1") {
    if (input.benchmark_id !== FULL_FLOW_BENCHMARK_ID)
      throw new Error("full-flow-v1 requires its reserved benchmark ID");
    return "full-flow-v1";
  }
  if (evaluation === "full-flow-text-v1") {
    if (input.benchmark_id !== TEXT_FLOW_BENCHMARK_ID)
      throw new Error("full-flow-text-v1 requires its reserved benchmark ID");
    return "full-flow-text-v1";
  }
  throw new Error("unsupported or missing benchmark evaluation profile");
}
