import {
  plannerCapabilityManifest,
  plannerConfigRequest,
  plannerConfigResult,
  plannerReadRequest,
  plannerReadResult,
  plannerSearchRequest,
  plannerSearchResult,
  plannerSymbolsRequest,
  plannerSymbolsResult,
  plannerTreeRequest,
  plannerTreeResult,
  type PlannerReadPort,
} from "@remoteagent/contracts";
import type { VerifiedWorkspacePath } from "@remoteagent/workspace-runner";
import {
  DISCOVERY_LIMITS,
  DiscoveryPolicyError,
  findSafeFilenames,
  listSafeTree,
  readSafeFile,
  searchSafeText,
  verifyDiscoveryRoot,
  type DiscoveryReadSeam,
} from "./discovery-policy.js";

const CONFIG_ALLOWLIST = new Set([
  "README.md",
  "CONTRIBUTING.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".gitlab-ci.yml",
]);

const SCOPED_SEARCH_CONTEXT_LINES = 6;
const SCOPED_SEARCH_MAX_CONTEXT_CHARACTERS = 16_384;

/**
 * Return an exact, bounded source excerpt around a scoped match.
 *
 * A single matching line locates a symbol but is usually insufficient for an
 * exact replacement patch. The excerpt deliberately has no generated line
 * labels, so the model can reuse it verbatim as `old_content`. If an unusual
 * long-line region exceeds the bound, falling back to the matching line keeps
 * search bounded and honest.
 */
function scopedSearchExcerpt(lines: readonly string[], matchIndex: number): string {
  const start = Math.max(0, matchIndex - SCOPED_SEARCH_CONTEXT_LINES);
  const end = Math.min(lines.length, matchIndex + SCOPED_SEARCH_CONTEXT_LINES + 1);
  const excerpt = lines.slice(start, end).join("\n");
  return excerpt.length <= SCOPED_SEARCH_MAX_CONTEXT_CHARACTERS ? excerpt : lines[matchIndex]!;
}

function isAllowedWorkflow(path: string): boolean {
  return /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/u.test(path);
}

function manifest() {
  return deepFreeze(
    plannerCapabilityManifest.parse({
      authority: "SERVER_OWNED",
      version: "read-tools-v1",
      tools: [
        "workspace.read",
        "workspace.search",
        "workspace.tree",
        "workspace.symbols",
        "workspace.config",
      ],
      can_write_workspace: false,
      can_execute_commands: false,
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function policyError(error: unknown): never {
  if (error instanceof DiscoveryPolicyError) throw error;
  throw new DiscoveryPolicyError("DISCOVERY_FAILED", "Read-only discovery failed safely");
}

async function createPort(
  root: VerifiedWorkspacePath,
  seam?: DiscoveryReadSeam,
): Promise<PlannerReadPort> {
  const verifiedRoot = await verifyDiscoveryRoot(root);
  const port: PlannerReadPort = {
    manifest: manifest(),
    async tree(input) {
      const request = plannerTreeRequest.parse(input);
      const entries = await listSafeTree(verifiedRoot, request.relative_path, seam).catch(
        policyError,
      );
      return plannerTreeResult.parse({
        entries: entries.map((entry) => ({
          provenance: { relative_path: entry.relativePath, digest: entry.digest },
          kind: entry.kind,
          label: { trust: "UNTRUSTED_DATA", value: entry.relativePath },
        })),
      });
    },
    async read(input) {
      const request = plannerReadRequest.parse(input);
      const result = await readSafeFile(verifiedRoot, request.relative_path, seam).catch(
        policyError,
      );
      return plannerReadResult.parse({
        relative_path: result.relativePath,
        digest: result.digest,
        content: { trust: "UNTRUSTED_DATA", value: result.content },
      });
    },
    async search(input) {
      const request = plannerSearchRequest.parse(input);
      if (request.relative_path !== undefined) {
        const result = await readSafeFile(verifiedRoot, request.relative_path, seam).catch(
          policyError,
        );
        const lines = result.content.split(/\r?\n/u);
        const matches = [];
        for (const [index, line] of lines.entries()) {
          if (!line.includes(request.query)) continue;
          matches.push({
            provenance: { relative_path: result.relativePath, digest: result.digest },
            line: index + 1,
            content: {
              trust: "UNTRUSTED_DATA" as const,
              value: scopedSearchExcerpt(lines, index),
            },
          });
          if (matches.length >= DISCOVERY_LIMITS.maxResults)
            throw new DiscoveryPolicyError("OVERSIZE", "Search result limit exceeded");
        }
        return plannerSearchResult.parse({ matches });
      }
      const filenameMatches = await findSafeFilenames(verifiedRoot, request.query, seam).catch(
        policyError,
      );
      if (filenameMatches.length > 0) {
        return plannerSearchResult.parse({
          matches: filenameMatches.map((match) => ({
            provenance: { relative_path: match.relativePath, digest: match.digest },
            line: 1,
            content: { trust: "UNTRUSTED_DATA" as const, value: "[filename match]" },
          })),
        });
      }
      const matches = await searchSafeText(verifiedRoot, request.query, seam).catch(policyError);
      return plannerSearchResult.parse({
        matches: matches.map((match) => ({
          provenance: { relative_path: match.relativePath, digest: match.digest },
          line: match.line,
          content: { trust: "UNTRUSTED_DATA" as const, value: match.content },
        })),
      });
    },
    async symbols(input) {
      const request = plannerSymbolsRequest.parse(input);
      const result = await readSafeFile(verifiedRoot, request.relative_path, seam).catch(
        policyError,
      );
      const symbols = [];
      const declaration = /\b(?:class|function|const|let|interface|type)\s+([A-Za-z_$][\w$]*)/u;
      for (const [index, line] of result.content.split(/\r?\n/u).entries()) {
        const match = declaration.exec(line);
        if (!match) continue;
        symbols.push({
          provenance: { relative_path: result.relativePath, digest: result.digest },
          name: match[1]!,
          kind: "declaration",
          line: index + 1,
          content: { trust: "UNTRUSTED_DATA" as const, value: line },
        });
        if (symbols.length >= DISCOVERY_LIMITS.maxResults)
          throw new DiscoveryPolicyError("OVERSIZE", "Symbol result limit exceeded");
      }
      return plannerSymbolsResult.parse({ symbols });
    },
    async config(input) {
      const request = plannerConfigRequest.parse(input);
      if (!CONFIG_ALLOWLIST.has(request.relative_path) && !isAllowedWorkflow(request.relative_path))
        throw new DiscoveryPolicyError(
          "FILE_NOT_ALLOWED",
          "Config path is not on the server allowlist",
        );
      const result = await readSafeFile(verifiedRoot, request.relative_path, seam).catch(
        policyError,
      );
      return plannerConfigResult.parse({
        entries: [
          {
            provenance: { relative_path: result.relativePath, digest: result.digest },
            content: { trust: "UNTRUSTED_DATA", value: result.content },
          },
        ],
      });
    },
  };
  return deepFreeze(port);
}

export async function createPlannerReadPort(root: VerifiedWorkspacePath): Promise<PlannerReadPort> {
  return createPort(root);
}

/** Source-only race seam; intentionally not exported from the package index. */
export async function createPlannerReadPortWithTestSeam(
  root: VerifiedWorkspacePath,
  seam: DiscoveryReadSeam,
): Promise<PlannerReadPort> {
  return createPort(root, seam);
}
