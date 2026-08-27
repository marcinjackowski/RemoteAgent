import * as z from "zod";

import { idString, isoTimestamp, text, valueObject, versionedContract } from "./common.js";
import { TrustLevel } from "./trust.js";

/** A digest of a canonical JSON value or bounded repository content. */
export const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Git SHA-1 and SHA-256 repository object ids are both accepted. */
export const gitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Relative repository paths only; host paths and traversal are impossible. */
export const relativeRepositoryPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9._+/-]+$/)
  .superRefine((value, ctx) => {
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      ctx.addIssue({ code: "custom", message: "path must contain canonical relative segments" });
    }
    if (value.startsWith("/") || value.includes("\\") || value.includes("://")) {
      ctx.addIssue({ code: "custom", message: "path must not be absolute or a URI" });
    }
  });

export type RelativeRepositoryPath = z.infer<typeof relativeRepositoryPath>;

export const provenance = valueObject({
  relative_path: relativeRepositoryPath,
  digest: sha256Digest,
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
});

const untrustedContent = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: text,
});

export const instructionFact = valueObject({
  provenance,
  scope: z.enum(["ROOT", "NESTED", "SCOPED"]),
  precedence: z.int().nonnegative(),
  content: untrustedContent,
});

export const discoveredCommand = valueObject({
  kind: z.enum(["TEST", "BUILD", "LINT", "TYPECHECK", "CI"]),
  name: idString,
  argv: z.array(z.string().max(4096)).max(64),
  provenance,
});

export const repositoryFact = valueObject({
  kind: idString,
  provenance,
  value: untrustedContent,
});

export const repositoryProfile = versionedContract({
  profile_id: idString,
  /** Repository identity and base SHA are server-owned inputs. */
  repository_id: idString,
  base_sha: gitSha,
  instruction_digest: sha256Digest,
  contract_version: idString,
  generated_at: isoTimestamp,
  instructions: z.array(instructionFact).max(256),
  discovered_commands: z.array(discoveredCommand).max(256),
  facts: z.array(repositoryFact).max(512),
});

export type Provenance = z.infer<typeof provenance>;
export type InstructionFact = z.infer<typeof instructionFact>;
export type DiscoveredCommand = z.infer<typeof discoveredCommand>;
export type RepositoryFact = z.infer<typeof repositoryFact>;
export type RepositoryProfile = z.infer<typeof repositoryProfile>;
