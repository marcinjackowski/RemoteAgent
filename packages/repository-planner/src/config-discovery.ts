import {
  plannerConfigResult,
  type PlannerReadPort,
  type PlannerConfigResult,
} from "@remoteagent/contracts";
import { DiscoveryPolicyError } from "./discovery-policy.js";

const CONFIG_PATHS = [
  "README.md",
  "CONTRIBUTING.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".gitlab-ci.yml",
] as const;

export async function discoverAllowedConfig(port: PlannerReadPort): Promise<PlannerConfigResult> {
  const entries = [];
  for (const relativePath of CONFIG_PATHS) {
    try {
      const result = await port.config({ relative_path: relativePath });
      entries.push(...result.entries);
    } catch (error) {
      if (error instanceof DiscoveryPolicyError && error.code === "FILE_NOT_FOUND") continue;
      throw error;
    }
  }
  let workflowEntries;
  try {
    workflowEntries = await port.tree({ relative_path: ".github/workflows" });
  } catch (error) {
    if (!(
      error instanceof DiscoveryPolicyError &&
      (error.code === "DISCOVERY_FAILED" || error.code === "FILE_NOT_FOUND")
    ))
      throw error;
  }
  const workflowPaths = (workflowEntries?.entries ?? [])
    .filter(
      (entry) =>
        entry.kind === "file" &&
        /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/u.test(entry.provenance.relative_path),
    )
    .map((entry) => entry.provenance.relative_path)
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  for (const relativePath of workflowPaths) {
    const result = await port.config({ relative_path: relativePath });
    entries.push(...result.entries);
  }
  return plannerConfigResult.parse({ entries });
}
