import * as z from "zod";

import { idString, text, valueObject } from "./common.js";
import { relativeRepositoryPath, sha256Digest } from "./repository-profile.js";
import { TrustLevel } from "./trust.js";

export const plannerToolName = z.enum([
  "workspace.read",
  "workspace.search",
  "workspace.tree",
  "workspace.symbols",
  "workspace.config",
]);

export type PlannerToolName = z.infer<typeof plannerToolName>;

/** A server-created capability manifest; no execution or mutation capability exists. */
export const plannerCapabilityManifest = valueObject({
  authority: z.literal("SERVER_OWNED"),
  version: idString,
  tools: z.array(plannerToolName).min(1).max(5),
  can_write_workspace: z.literal(false),
  can_execute_commands: z.literal(false),
}).superRefine((value, ctx) => {
  if (new Set(value.tools).size !== value.tools.length)
    ctx.addIssue({ code: "custom", path: ["tools"], message: "tool names must be unique" });
});

export type PlannerCapabilityManifest = z.infer<typeof plannerCapabilityManifest>;

export type PlannerReadContent = Readonly<{
  readonly trust: typeof TrustLevel.UNTRUSTED_DATA;
  readonly value: string;
}>;

const plannerOutputProvenance = valueObject({
  relative_path: relativeRepositoryPath,
  digest: sha256Digest,
});

const plannerUntrustedContent = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: text,
});

export const plannerReadRequest = valueObject({ relative_path: relativeRepositoryPath });
export const plannerSearchRequest = valueObject({
  query: z.string().trim().min(1).max(4096),
  relative_path: relativeRepositoryPath.optional(),
});
export const plannerTreeRequest = valueObject({ relative_path: relativeRepositoryPath.optional() });
export const plannerSymbolsRequest = valueObject({ relative_path: relativeRepositoryPath });
export const plannerConfigRequest = valueObject({ relative_path: relativeRepositoryPath });

const plannerSearchMatch = valueObject({
  provenance: plannerOutputProvenance,
  line: z.int().positive(),
  content: plannerUntrustedContent,
});

const plannerTreeEntry = valueObject({
  provenance: plannerOutputProvenance,
  kind: z.enum(["file", "directory", "symlink"]),
  label: plannerUntrustedContent,
});

const plannerSymbol = valueObject({
  provenance: plannerOutputProvenance,
  name: idString,
  kind: idString,
  line: z.int().positive(),
  content: plannerUntrustedContent,
});

const plannerConfigEntry = valueObject({
  provenance: plannerOutputProvenance,
  content: plannerUntrustedContent,
});

export type PlannerReadPort = Readonly<{
  readonly manifest: PlannerCapabilityManifest;
  read(input: z.infer<typeof plannerReadRequest>): Promise<z.infer<typeof plannerReadResult>>;
  search(input: z.infer<typeof plannerSearchRequest>): Promise<z.infer<typeof plannerSearchResult>>;
  tree(input: z.infer<typeof plannerTreeRequest>): Promise<z.infer<typeof plannerTreeResult>>;
  symbols(
    input: z.infer<typeof plannerSymbolsRequest>,
  ): Promise<z.infer<typeof plannerSymbolsResult>>;
  config(input: z.infer<typeof plannerConfigRequest>): Promise<z.infer<typeof plannerConfigResult>>;
}>;

/** Runtime-safe shape for a bounded read result carried by the port. */
export const plannerReadResult = valueObject({
  relative_path: relativeRepositoryPath,
  digest: sha256Digest,
  content: valueObject({
    trust: z.literal(TrustLevel.UNTRUSTED_DATA),
    value: text,
  }),
});

export const plannerSearchResult = valueObject({ matches: z.array(plannerSearchMatch).max(512) });
export const plannerTreeResult = valueObject({ entries: z.array(plannerTreeEntry).max(512) });
export const plannerSymbolsResult = valueObject({ symbols: z.array(plannerSymbol).max(512) });
export const plannerConfigResult = valueObject({ entries: z.array(plannerConfigEntry).max(256) });

export type PlannerReadRequest = z.infer<typeof plannerReadRequest>;
export type PlannerSearchRequest = z.infer<typeof plannerSearchRequest>;
export type PlannerTreeRequest = z.infer<typeof plannerTreeRequest>;
export type PlannerSymbolsRequest = z.infer<typeof plannerSymbolsRequest>;
export type PlannerConfigRequest = z.infer<typeof plannerConfigRequest>;
export type PlannerReadResult = z.infer<typeof plannerReadResult>;
export type PlannerSearchResult = z.infer<typeof plannerSearchResult>;
export type PlannerTreeResult = z.infer<typeof plannerTreeResult>;
export type PlannerSymbolsResult = z.infer<typeof plannerSymbolsResult>;
export type PlannerConfigResult = z.infer<typeof plannerConfigResult>;
