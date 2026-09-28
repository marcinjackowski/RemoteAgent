import { createHash } from "node:crypto";

import type { EngineeringCompilerDiagnostic } from "@remoteagent/contracts";
import type { VerificationGateDefinition } from "@remoteagent/test-evidence";
import { MAX_SERVER_PREFETCH_DISCOVERY_CALLS } from "@remoteagent/implementation-tools";

export type RepairContextCategory =
  | "DIAGNOSTIC_LOCATION"
  | "DECLARATION"
  | "USAGE"
  | "TEST_SUPPORT"
  | "REVIEW_REGRESSION"
  | "CONFIGURED_UNRELATED";

export type RepairContextReason =
  | "ENTRY_LIMIT"
  | "DISCOVERY_CALL_BUDGET"
  | "BYTE_BUDGET"
  | "TOKEN_BUDGET"
  | "OUT_OF_SCOPE"
  | "NO_MATCH"
  | "REQUIRED_DECLARATION_UNRESOLVED"
  | "REQUIRED_DECLARATION_TRUNCATED";

export type RepairContextPlanEntry = Readonly<{
  kind: "READ" | "SEARCH";
  relative_path: string;
  query?: string;
  category: RepairContextCategory;
  rank: number;
  required: boolean;
  provenance: string;
  /** Server-only root lookup; never grants mutation authority or becomes model discovery. */
  declaration_lookup_symbol?: string;
  declaration_lookup_roots?: readonly string[];
  declaration_lookup_required?: boolean;
  declaration_lookup_manifest_required?: boolean;
  declaration_lookup_member?: boolean;
  call_site_lookup_required?: boolean;
  call_site_diagnostic_path?: string;
  call_site_diagnostic_line?: number;
}>;

export type RepairContextOmission = Readonly<{
  category: RepairContextCategory;
  relative_path: string;
  query: string | null;
  required: boolean;
  reason: RepairContextReason;
  digest: string;
}>;

export type RepairContextUnresolved = Readonly<{
  symbol: string;
  category: "DECLARATION" | "USAGE" | "TEST_SUPPORT";
  reason: "NO_MATCH" | "OUT_OF_SCOPE" | "REQUIRED_DECLARATION_UNRESOLVED";
  diagnostic_coordinates: readonly string[];
}>;

export type EngineeringRepairContextPlan = Readonly<{
  entries: readonly RepairContextPlanEntry[];
  omissions: readonly RepairContextOmission[];
  unresolved: readonly RepairContextUnresolved[];
  diagnostics: readonly Readonly<{ path: string; line: number; column: number; digest: string }>[];
  bytes: number;
  token_estimate: number;
  limits: Readonly<{ entries: number; bytes: number; tokens: number }>;
}>;

export const ENGINEERING_REPAIR_DISCOVERY_CALL_BUDGET = MAX_SERVER_PREFETCH_DISCOVERY_CALLS;

/** Resolve only the conventional SwiftPM manifest path; the read remains the evidence. */
export function engineeringSwiftPackageManifestPath(path: string): string | null {
  const segment = /(?:^|\/)(?:Sources|Tests)\//u.exec(path);
  if (segment === null) return null;
  const packageRoot = path.slice(0, segment.index);
  return packageRoot === "" ? "Package.swift" : `${packageRoot}/Package.swift`;
}

export function engineeringDiagnosticWindows(
  lines: readonly number[],
): readonly Readonly<{ start: number; end: number }>[] {
  const windows: Array<{ start: number; end: number }> = [];
  for (const line of [1, ...new Set(lines)].sort((a, b) => a - b)) {
    const next = { start: Math.max(1, line - 3), end: line === 1 ? 24 : line + 3 };
    const previous = windows.at(-1);
    if (previous !== undefined && next.start <= previous.end + 1)
      previous.end = Math.max(previous.end, next.end);
    else windows.push(next);
  }
  return Object.freeze(windows);
}

export function engineeringRepairContextEntryCallCost(
  entry: Pick<
    RepairContextPlanEntry,
    | "kind"
    | "declaration_lookup_symbol"
    | "declaration_lookup_roots"
    | "declaration_lookup_required"
    | "declaration_lookup_manifest_required"
    | "declaration_lookup_member"
    | "call_site_lookup_required"
    | "relative_path"
  > & { readonly fallback_search_queries?: readonly string[] },
  diagnosticLines: readonly number[] = [],
): number {
  if (entry.declaration_lookup_symbol !== undefined)
    if (entry.declaration_lookup_member === true)
      return (
        1 +
        (entry.declaration_lookup_roots?.length ?? 0) +
        1 +
        (entry.declaration_lookup_manifest_required === true ? 1 : 0)
      );
  if (entry.declaration_lookup_symbol !== undefined)
    return (
      1 +
      6 +
      (entry.declaration_lookup_roots?.length ?? 0) +
      1 +
      (entry.declaration_lookup_manifest_required === true ? 1 : 0) +
      (entry.declaration_lookup_symbol.endsWith("ViewModel") ? 4 : 0)
    );
  if (entry.call_site_lookup_required === true)
    return 1 + 6 + (entry.declaration_lookup_roots?.length ?? 0) + 1 + 1 + 4;
  if (entry.kind !== "READ" || diagnosticLines.length === 0)
    return 1 + (entry.fallback_search_queries?.length ?? 0);
  return (
    engineeringDiagnosticWindows(diagnosticLines).length +
    (entry.fallback_search_queries?.length ?? 0)
  );
}

export type RepairContextPrefetchedEvidence = Readonly<{
  kind: "READ" | "SEARCH";
  relative_path: string;
  query: string | null;
  evidence: string;
  complete?: boolean;
  start_line?: number;
  end_line?: number;
  full_file_digest?: string;
}>;
export type FinalizedRepairContext = Readonly<
  EngineeringRepairContextPlan & {
    evidence: readonly RepairContextPrefetchedEvidence[];
    retained: readonly Readonly<{
      kind: "READ" | "SEARCH";
      relative_path: string;
      query: string | null;
      category: RepairContextCategory;
      provenance: string;
      bytes: number;
      token_estimate: number;
      digest: string;
      complete?: boolean;
      start_line?: number | null;
      end_line?: number | null;
      full_file_digest?: string;
    }>[];
  }
>;

const missingTypeDiagnosticSymbol = (message: string): string | null =>
  /cannot find (?:type\s+)?['"]?([^'"\s]+)['"]?\s+in scope/u.exec(message)?.[1] ??
  /no type named\s+['"]?([^'"\s]+)['"]?\s+in module\s+['"][^'"]+['"]/u.exec(message)?.[1] ??
  null;

const missingMemberReceiverSymbol = (message: string): string | null => {
  const trimmed = message.trim();
  const prefix = /^(?:value of type|type)\s+['"]?/iu.exec(trimmed);
  if (prefix === null) return null;
  const rest = trimmed.slice(prefix[0].length);
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest)?.[0];
  if (identifier === undefined) return null;
  let offset = identifier.length;
  if (rest[offset] === "<") {
    let depth = 0;
    let closed = false;
    for (; offset < rest.length; offset += 1) {
      if (rest[offset] === "<") depth += 1;
      else if (rest[offset] === ">") {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          offset += 1;
          break;
        }
        if (depth < 0) return null;
      }
    }
    if (!closed) return null;
  }
  const suffix = rest.slice(offset).replace(/^['"]?/u, "");
  return /^\s+has no member\s+['"][A-Za-z_][A-Za-z0-9_]*['"]\s*$/iu.test(suffix)
    ? identifier
    : null;
};

const missingModuleDiagnostic = (message: string): boolean =>
  /^(?:no such module|no module named|Unable to find module dependency:)\s*['"]?[^'"\s]+['"]?\s*$/iu.test(
    message.trim(),
  );

export const ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY = Object.freeze({
  version: "COMPILER_REPAIR_CONTEXT_V6",
  entries: 24,
  bytes: 48_000,
  tokens: 12_000,
});

const diagnosticUsesSymbolAsQualifiedNamespace = (
  diagnostic: EngineeringCompilerDiagnostic,
  symbol: string,
): boolean => {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\s*\\.\\s*[A-Za-z_]`, "u").test(diagnostic.excerpt);
};

const isImplicitMemberDiagnostic = (
  diagnostic: EngineeringCompilerDiagnostic,
  symbol: string,
): boolean => {
  const match = new RegExp(
    `^type\\s+['"]?${symbol}['"]?\\s+has\\s+no\\s+member\\s+['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`,
    "iu",
  ).exec(diagnostic.message);
  if (match === null) return false;
  const member = match[1]!;
  const excerpt = `${diagnostic.message}\n${diagnostic.excerpt}`
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/"(?:\\.|[^"\\])*"/gu, "")
    .replace(/\/\/.*$/gmu, "");
  if (new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*${member}\\b`, "u").test(excerpt))
    return false;
  return new RegExp(`(?:^|[([{=:,]\\s*)\\.${member}\\b`, "u").test(excerpt);
};

/** Prompt-safe projection: provenance and budget evidence without duplicating repository bytes. */
export function repairContextMetadata(
  plan: EngineeringRepairContextPlan,
): RuntimeRepairContextMetadata {
  return {
    entries: plan.entries.map(
      ({ kind, relative_path, query, category, rank, required, provenance }) => ({
        kind,
        relative_path,
        query: query ?? null,
        category,
        rank,
        required,
        provenance,
      }),
    ),
    omissions: plan.omissions,
    unresolved: plan.unresolved,
    diagnostics: plan.diagnostics,
    bytes: plan.bytes,
    token_estimate: plan.token_estimate,
    limits: plan.limits,
    ...("retained" in plan
      ? {
          retained: (plan as FinalizedRepairContext).retained.map(
            ({
              kind,
              relative_path,
              query,
              category,
              provenance,
              bytes,
              token_estimate,
              digest,
              complete,
              start_line,
              end_line,
              full_file_digest,
            }) => ({
              kind,
              relative_path,
              query,
              category,
              provenance,
              bytes,
              token_estimate,
              digest,
              complete: kind === "READ" ? (complete ?? true) : null,
              start_line: start_line ?? null,
              end_line: end_line ?? null,
              full_file_digest: kind === "READ" ? (full_file_digest ?? digest) : null,
            }),
          ),
        }
      : {}),
  };
}
export type RuntimeRepairContextMetadata = Readonly<{
  entries: readonly unknown[];
  omissions: readonly unknown[];
  unresolved: readonly unknown[];
  diagnostics: readonly unknown[];
  bytes: number;
  token_estimate: number;
  limits: Readonly<{ entries: number; bytes: number; tokens: number }>;
}>;

type ContextEntry = NonNullable<VerificationGateDefinition["implementation_context"]>[number];

const categoryRank: Readonly<Record<RepairContextCategory, number>> = Object.freeze({
  DIAGNOSTIC_LOCATION: 0,
  DECLARATION: 1,
  USAGE: 2,
  TEST_SUPPORT: 3,
  REVIEW_REGRESSION: 4,
  CONFIGURED_UNRELATED: 5,
});

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const serializedPlanEntry = (entry: RepairContextPlanEntry): string =>
  JSON.stringify({
    kind: entry.kind,
    path: entry.relative_path,
    query: entry.query ?? null,
    category: entry.category,
    provenance: entry.provenance,
  });
const serializedPlanEntries = (entries: readonly RepairContextPlanEntry[]): string =>
  JSON.stringify(entries.map(serializedPlanEntry).map((entry) => JSON.parse(entry)));
const serializedEvidence = (entries: readonly RepairContextPrefetchedEvidence[]): string =>
  JSON.stringify(entries);
export const encodedRepairFragmentBytes = (entry: RepairContextPrefetchedEvidence): number =>
  bytes(
    JSON.stringify({
      kind: entry.kind,
      relative_path: entry.relative_path,
      query: entry.query,
      evidence: entry.evidence,
      complete: entry.complete ?? true,
      start_line: entry.start_line ?? null,
      end_line: entry.end_line ?? null,
      full_file_digest: entry.full_file_digest ?? null,
    }),
  );
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const identity = (
  entry: Pick<RepairContextPlanEntry, "kind" | "relative_path"> & { query?: string },
): string => `${entry.kind}:${entry.relative_path}:${entry.query ?? ""}`;
const isInside = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));
const isTestPath = (path: string): boolean =>
  /(^|\/)(Tests?|test)(\/|$)|Tests?\.swift$/u.test(path);
const base = (path: string): string =>
  path
    .split("/")
    .at(-1)
    ?.replace(/\.[^.]+$/u, "") ?? path;

export function compilerRepairContextTokenEstimate(value: string): number {
  return Math.max(1, Math.ceil(bytes(value) / 4));
}

export function boundedRepairContextEvidence(input: {
  readonly evidence: string;
  readonly maxBytes: number;
  readonly required?: boolean;
}): Readonly<{
  evidence: string;
  bytes: number;
  token_estimate: number;
  truncated: boolean;
  digest: string;
}> {
  const originalDigest = digest(input.evidence);
  if (bytes(input.evidence) <= input.maxBytes) {
    return Object.freeze({
      evidence: input.evidence,
      bytes: bytes(input.evidence),
      token_estimate: compilerRepairContextTokenEstimate(input.evidence),
      truncated: false,
      digest: originalDigest,
    });
  }
  // Never silently discard a required declaration. The caller must escalate it.
  if (input.required) throw new Error("REQUIRED_DECLARATION_TRUNCATED");
  let result = "";
  for (const character of input.evidence) {
    if (bytes(result + character) > input.maxBytes) break;
    result += character;
  }
  return Object.freeze({
    evidence: result,
    bytes: bytes(result),
    token_estimate: compilerRepairContextTokenEstimate(result),
    truncated: true,
    digest: originalDigest,
  });
}

/** Apply the repair envelope to the actual server-observed bytes, immediately before prompt construction. */
export function boundEngineeringRepairPrefetchedEvidence(
  plan: EngineeringRepairContextPlan,
  prefetched: readonly RepairContextPrefetchedEvidence[],
): readonly RepairContextPrefetchedEvidence[] {
  if (plan.omissions.some((omission) => omission.required)) {
    const omission = plan.omissions.find((item) => item.required)!;
    throw new Error(
      omission.category === "DIAGNOSTIC_LOCATION"
        ? "REQUIRED_DIAGNOSTIC_TRUNCATED"
        : "REQUIRED_DECLARATION_TRUNCATED",
    );
  }
  const result: RepairContextPrefetchedEvidence[] = [];
  const expanded = prefetched.flatMap((entry) => {
    const descriptor = plan.entries.find(
      (candidate) =>
        (candidate.kind === entry.kind ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.kind === "SEARCH")) &&
        (candidate.relative_path === entry.relative_path ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.declaration_lookup_symbol ===
              entry.query.slice("__declaration_lookup__:".length))) &&
        ((candidate.query ?? null) === entry.query ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.declaration_lookup_symbol ===
              entry.query.slice("__declaration_lookup__:".length))),
    );
    const dynamicLookup =
      entry.query?.startsWith("__module_manifest__:") === true ||
      entry.query?.startsWith("__declaration_lookup__:") === true;
    if (
      entry.kind !== "READ" ||
      (descriptor?.required !== true &&
        descriptor?.declaration_lookup_required !== true &&
        !dynamicLookup)
    )
      return [entry];
    const requiredCategory = descriptor?.category ?? "DECLARATION";
    let content = entry.evidence;
    let fullFileDigest: string | undefined;
    if (dynamicLookup && !entry.evidence.trimStart().startsWith("{"))
      throw new Error("REQUIRED_DECLARATION_UNRESOLVED");
    if (entry.evidence.trimStart().startsWith("{")) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(entry.evidence);
      } catch {
        throw new Error(
          requiredCategory === "DIAGNOSTIC_LOCATION"
            ? "REQUIRED_DIAGNOSTIC_TRUNCATED"
            : "REQUIRED_DECLARATION_UNRESOLVED",
        );
      }
      const parsed = envelope as {
        tool?: unknown;
        relative_path?: unknown;
        complete?: unknown;
        content?: unknown;
        digest?: unknown;
        start_line?: unknown;
        end_line?: unknown;
        full_file_digest?: unknown;
      };
      const excerpt = parsed.tool === "read_excerpt";
      if (
        (dynamicLookup ? parsed.tool !== "read" : parsed.tool !== "read" && !excerpt) ||
        parsed.relative_path !== entry.relative_path ||
        (dynamicLookup
          ? parsed.complete !== true
          : excerpt
            ? parsed.complete !== false
            : parsed.complete !== true) ||
        typeof parsed.content !== "string" ||
        (excerpt
          ? typeof parsed.full_file_digest !== "string" ||
            typeof parsed.start_line !== "number" ||
            typeof parsed.end_line !== "number"
          : typeof parsed.digest !== "string")
      ) {
        throw new Error(
          requiredCategory === "DIAGNOSTIC_LOCATION"
            ? "REQUIRED_DIAGNOSTIC_TRUNCATED"
            : "REQUIRED_DECLARATION_UNRESOLVED",
        );
      }
      content = parsed.content;
      fullFileDigest = (excerpt ? parsed.full_file_digest : parsed.digest) as string;
      if (excerpt) {
        const start = parsed.start_line as number;
        const end = parsed.end_line as number;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
          throw new Error("REQUIRED_DIAGNOSTIC_TRUNCATED");
        if (end < start) throw new Error("REQUIRED_DIAGNOSTIC_TRUNCATED");
      }
    }
    const lines = content.split(/\r?\n/u);
    const lineStarts = [0];
    for (let index = 0; index < content.length; index += 1)
      if (content[index] === "\n") lineStarts.push(index + 1);
    const excerptRange =
      fullFileDigest !== undefined && content !== entry.evidence
        ? (() => {
            try {
              const parsed = JSON.parse(entry.evidence) as {
                start_line?: unknown;
                end_line?: unknown;
              };
              return typeof parsed.start_line === "number" && typeof parsed.end_line === "number"
                ? { start: parsed.start_line, end: parsed.end_line }
                : null;
            } catch {
              return null;
            }
          })()
        : null;
    const diagnosticLines = plan.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.path === entry.relative_path &&
          (excerptRange === null ||
            (diagnostic.line >= excerptRange.start && diagnostic.line <= excerptRange.end)),
      )
      .map((diagnostic) => diagnostic.line);
    const excerptStart =
      fullFileDigest !== undefined && content !== entry.evidence
        ? (() => {
            try {
              const parsed = JSON.parse(entry.evidence) as { start_line?: unknown };
              return typeof parsed.start_line === "number" ? parsed.start_line : 1;
            } catch {
              return 1;
            }
          })()
        : 1;
    if (excerptRange !== null) {
      const declaredEnd = excerptRange.end;
      const lineCount = content.split(/\r?\n/u).length - (content.endsWith("\n") ? 1 : 0);
      if (
        excerptRange.start < 1 ||
        declaredEnd < excerptRange.start ||
        lineCount !== declaredEnd - excerptRange.start + 1
      )
        throw new Error("REQUIRED_DIAGNOSTIC_TRUNCATED");
      return [
        Object.freeze({
          ...entry,
          evidence: content,
          complete: false,
          start_line: excerptRange.start,
          end_line: declaredEnd,
          full_file_digest: fullFileDigest!,
        }),
      ];
    }
    const localDiagnosticLines = diagnosticLines.map((line) => line - excerptStart + 1);
    const symbol = descriptor?.provenance?.match(/^(?:symbol|declaration-lookup):(.+)$/u)?.[1];
    const memberLookup = descriptor?.declaration_lookup_member === true;
    const anchors =
      diagnosticLines.length > 0
        ? localDiagnosticLines
        : symbol === undefined
          ? []
          : (() => {
              const maskedLines = lines
                .join("\n")
                .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\r\n]/gu, " "))
                .replace(/"(?:\\.|[^"\\])*"/gu, (literal) => literal.replace(/[^\r\n]/gu, " "))
                .replace(/\/\/.*$/gmu, "")
                .split(/\r?\n/u);
              const declarationPattern = new RegExp(
                `\\b(?:class|struct|enum|protocol|typealias|func|var|let)\\s+${symbol}\\b`,
                "u",
              );
              if (!memberLookup) {
                const declaration = maskedLines.flatMap((line, index) =>
                  declarationPattern.test(line) ? [index + 1] : [],
                );
                if (declaration.length > 0) return [declaration[0]!];
                const first = lines.findIndex((line) => line.includes(symbol));
                return first < 0 ? [] : [first + 1];
              }
              const maskedSource = maskedLines.join("\n");
              const declarationMatch = declarationPattern.exec(maskedSource);
              const declaration =
                declarationMatch === null
                  ? []
                  : (() => {
                      const start = maskedSource
                        .slice(0, declarationMatch.index)
                        .split("\n").length;
                      const end = start + declarationMatch[0].split("\n").length - 1;
                      return memberLookup ? (end - start > 10 ? [] : [start, end]) : [start];
                    })();
              return declaration;
            })();
    if (localDiagnosticLines.some((line) => line < 1 || line > lines.length)) {
      if (fullFileDigest === undefined && bytes(content) <= plan.limits.bytes) {
        return [Object.freeze({ ...entry, complete: true, full_file_digest: digest(content) })];
      }
      throw new Error("REQUIRED_DIAGNOSTIC_TRUNCATED");
    }
    if (anchors.length === 0 && symbol !== undefined) {
      throw new Error("REQUIRED_DECLARATION_UNRESOLVED");
    }
    if (anchors.length === 0) {
      return [
        Object.freeze({
          ...entry,
          evidence: content,
          complete: true,
          full_file_digest: fullFileDigest ?? digest(content),
        }),
      ];
    }
    const ranges: Array<[number, number]> = [];
    for (const anchor of [...new Set(anchors)].sort((a, b) => a - b)) {
      const start = Math.max(1, anchor - (diagnosticLines.length > 0 ? 3 : 5));
      const end = Math.min(lines.length, anchor + (diagnosticLines.length > 0 ? 3 : 5));
      const previous = ranges.at(-1);
      if (previous !== undefined && start <= previous[1] + 1)
        previous[1] = Math.max(previous[1], end);
      else ranges.push([start, end]);
    }
    const fullDigest = fullFileDigest ?? digest(content);
    return ranges.map(([start, end]) =>
      Object.freeze({
        ...entry,
        evidence: content.slice(lineStarts[start - 1]!, lineStarts[end] ?? content.length),
        complete: false,
        start_line: start,
        end_line: end,
        full_file_digest: fullDigest,
      }),
    );
  });
  for (const requiredEntry of plan.entries.filter(
    (entry) =>
      entry.required === true && entry.kind === "READ" && entry.category === "DIAGNOSTIC_LOCATION",
  )) {
    if (
      !expanded.some(
        (entry) => entry.kind === "READ" && entry.relative_path === requiredEntry.relative_path,
      )
    ) {
      throw new Error("REQUIRED_DIAGNOSTIC_TRUNCATED");
    }
  }
  for (const path of new Set(plan.diagnostics.map((diagnostic) => diagnostic.path))) {
    const required = plan.diagnostics.filter((diagnostic) => diagnostic.path === path);
    if (!expanded.some((entry) => entry.kind === "READ" && entry.relative_path === path)) continue;
    const covered = required.every((diagnostic) =>
      expanded.some((entry) => {
        if (entry.kind !== "READ" || entry.relative_path !== path) return false;
        if (entry.start_line === undefined || entry.end_line === undefined) return true;
        return diagnostic.line >= entry.start_line && diagnostic.line <= entry.end_line;
      }),
    );
    if (!covered) throw new Error("REQUIRED_DIAGNOSTIC_TRUNCATED");
  }
  const isRequired = (entry: RepairContextPrefetchedEvidence): boolean => {
    const descriptor = plan.entries.find(
      (candidate) =>
        candidate.kind === entry.kind &&
        (candidate.relative_path === entry.relative_path ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.declaration_lookup_symbol ===
              entry.query.slice("__declaration_lookup__:".length))) &&
        ((candidate.query ?? null) === entry.query ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.declaration_lookup_symbol ===
              entry.query.slice("__declaration_lookup__:".length))),
    );
    return (
      descriptor?.required === true ||
      descriptor?.declaration_lookup_required === true ||
      entry.query?.startsWith("__module_manifest__:") === true ||
      entry.query?.startsWith("__declaration_lookup__:") === true
    );
  };
  const ordered = [...expanded].sort(
    (left, right) => Number(isRequired(right)) - Number(isRequired(left)),
  );
  for (const entry of ordered) {
    const descriptor = plan.entries.find(
      (candidate) =>
        candidate.kind === entry.kind &&
        (candidate.relative_path === entry.relative_path ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.declaration_lookup_symbol ===
              entry.query.slice("__declaration_lookup__:".length))) &&
        ((candidate.query ?? null) === entry.query ||
          (entry.query?.startsWith("__declaration_lookup__:") === true &&
            candidate.declaration_lookup_symbol ===
              entry.query.slice("__declaration_lookup__:".length))),
    );
    const required = isRequired(entry);
    const tentative = [...result, entry];
    const tentativeBytes = bytes(serializedEvidence(tentative));
    const tentativeTokens = compilerRepairContextTokenEstimate(serializedEvidence(tentative));
    if (tentativeBytes > plan.limits.bytes || tentativeTokens > plan.limits.tokens) {
      if (required)
        throw new Error(
          descriptor?.category === "DIAGNOSTIC_LOCATION"
            ? "REQUIRED_DIAGNOSTIC_TRUNCATED"
            : "REQUIRED_DECLARATION_TRUNCATED",
        );
      continue;
    }
    result.push(Object.freeze({ ...entry }));
  }
  for (const declaration of result.filter((entry) => {
    if (entry.query?.startsWith("__declaration_lookup__:") === true) return true;
    return plan.entries.some(
      (candidate) =>
        candidate.kind === "READ" &&
        candidate.relative_path === entry.relative_path &&
        (candidate.query ?? null) === entry.query &&
        candidate.declaration_lookup_manifest_required === true,
    );
  })) {
    const manifestPath = engineeringSwiftPackageManifestPath(declaration.relative_path);
    if (
      !result.some(
        (entry) =>
          (entry.query?.startsWith("__module_manifest__:") === true ||
            (entry.query === null && entry.complete === true)) &&
          entry.relative_path === manifestPath &&
          entry.evidence.length > 0,
      )
    )
      throw new Error("REQUIRED_DECLARATION_TRUNCATED");
  }
  return Object.freeze(result);
}

export function finalizeEngineeringRepairContext(
  plan: EngineeringRepairContextPlan,
  prefetched: readonly RepairContextPrefetchedEvidence[],
): FinalizedRepairContext {
  const bounded = boundEngineeringRepairPrefetchedEvidence(plan, prefetched);
  const omissions: RepairContextOmission[] = [...plan.omissions];
  const retainedKeys = new Set(
    bounded.map((entry) => `${entry.kind}:${entry.relative_path}:${entry.query ?? ""}`),
  );
  for (const raw of prefetched) {
    const key = `${raw.kind}:${raw.relative_path}:${raw.query ?? ""}`;
    if (raw.evidence === "" && raw.kind === "SEARCH") {
      omissions.push(
        Object.freeze({
          category: "USAGE",
          relative_path: raw.relative_path,
          query: raw.query,
          required: false,
          reason: "NO_MATCH",
          digest: digest(raw.query ?? ""),
        }),
      );
    } else if (!retainedKeys.has(key)) {
      const candidate = plan.entries.find(
        (entry) => `${entry.kind}:${entry.relative_path}:${entry.query ?? ""}` === key,
      );
      if (candidate !== undefined) {
        const rawIndex = prefetched.indexOf(raw);
        const prior = prefetched
          .slice(0, rawIndex < 0 ? prefetched.length : rawIndex)
          .filter((entry) =>
            retainedKeys.has(`${entry.kind}:${entry.relative_path}:${entry.query ?? ""}`),
          );
        const tentative = [...prior, raw];
        const reason: RepairContextReason =
          bytes(serializedEvidence(tentative)) > plan.limits.bytes ? "BYTE_BUDGET" : "TOKEN_BUDGET";
        omissions.push(
          Object.freeze({
            category: candidate.category,
            relative_path: candidate.relative_path,
            query: candidate.query ?? null,
            required: candidate.required,
            reason,
            digest: digest(raw.evidence),
          }),
        );
      }
    }
  }
  const unresolved = plan.unresolved.filter((item) => {
    const memberObligation = plan.entries.some(
      (candidate) =>
        candidate.declaration_lookup_member === true &&
        candidate.declaration_lookup_symbol === item.symbol,
    );
    if (memberObligation) {
      const declaration = new RegExp(`\\b(?:var|let|func)\\s+${item.symbol}\\b`, "u");
      return !bounded.some(
        (entry) =>
          entry.kind === "READ" &&
          entry.query === `__declaration_lookup__:${item.symbol}` &&
          plan.entries.some(
            (candidate) =>
              candidate.declaration_lookup_member === true &&
              candidate.declaration_lookup_symbol === item.symbol &&
              candidate.declaration_lookup_roots?.some((root) => entry.relative_path === root),
          ) &&
          declaration.test(
            entry.evidence
              .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\r\n]/gu, " "))
              .replace(/"(?:\\.|[^"\\])*"/gu, (literal) => literal.replace(/[^\r\n]/gu, " "))
              .replace(/\/\/.*$/gmu, ""),
          ),
      );
    }
    return !bounded.some(
      (entry) =>
        (entry.kind === "SEARCH" && entry.query === item.symbol && entry.evidence.length > 0) ||
        (entry.kind === "READ" &&
          (entry.relative_path
            .split("/")
            .at(-1)
            ?.replace(/\.swift$/u, "") === item.symbol ||
            entry.query === `__declaration_lookup__:${item.symbol}`) &&
          new RegExp(
            `\\b(?:struct|class|enum|protocol|typealias)\\s+${item.symbol}\\b|\\bextension\\s+${item.symbol}\\b`,
            "u",
          ).test(entry.evidence)),
    );
  });
  if (unresolved.some((item) => item.category === "DECLARATION")) {
    throw new Error("REQUIRED_DECLARATION_UNRESOLVED");
  }
  for (const slot of plan.entries.filter((entry) => entry.call_site_lookup_required === true)) {
    const suffix = `@${slot.call_site_diagnostic_path}:${slot.call_site_diagnostic_line ?? 1}`;
    if (
      !bounded.some(
        (entry) =>
          entry.query?.startsWith("__declaration_lookup__:") === true &&
          entry.query.endsWith(suffix) &&
          entry.evidence.length > 0,
      )
    )
      throw new Error("REQUIRED_DECLARATION_TRUNCATED");
  }
  const retained = bounded.map((entry) => {
    const descriptor = plan.entries.find(
      (candidate) =>
        candidate.kind === entry.kind &&
        candidate.relative_path === entry.relative_path &&
        (candidate.query ?? null) === entry.query,
    );
    const retainedEntry = {
      ...entry,
      category:
        descriptor?.category ??
        (entry.query?.startsWith("__module_manifest__:") === true ||
        entry.query?.startsWith("__declaration_lookup__:") === true
          ? "DECLARATION"
          : "USAGE"),
      provenance: descriptor?.provenance ?? "server-prefetch",
      bytes: encodedRepairFragmentBytes(entry),
      token_estimate: compilerRepairContextTokenEstimate(JSON.stringify(entry)),
      digest: digest(entry.evidence),
      ...(entry.kind === "READ"
        ? {
            complete: entry.complete ?? true,
            start_line: entry.start_line ?? null,
            end_line: entry.end_line ?? null,
            full_file_digest: entry.full_file_digest ?? digest(entry.evidence),
          }
        : {}),
    };
    return Object.freeze(retainedEntry);
  });
  const evidence = Object.freeze(bounded);
  const actualBytes = bytes(JSON.stringify(evidence));
  const actualTokens = compilerRepairContextTokenEstimate(JSON.stringify(evidence));
  return Object.freeze({
    ...plan,
    evidence,
    retained: Object.freeze(retained),
    omissions: Object.freeze(omissions),
    unresolved: Object.freeze(unresolved),
    bytes: actualBytes,
    token_estimate: actualTokens,
  });
}

export function buildEngineeringRepairContext(input: {
  readonly diagnostics: readonly EngineeringCompilerDiagnostic[];
  readonly allowedPaths: readonly string[];
  readonly dependencyPaths?: readonly string[];
  readonly configuredContext?: readonly ContextEntry[];
  readonly reviewRegressionPaths?: readonly string[];
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxTokens?: number;
}): EngineeringRepairContextPlan {
  const limits = {
    entries: input.maxEntries ?? ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.entries,
    bytes: input.maxBytes ?? ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.bytes,
    tokens: input.maxTokens ?? ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.tokens,
  };
  if (input.diagnostics.length === 0)
    return Object.freeze({
      entries: [],
      omissions: [],
      unresolved: [],
      diagnostics: [],
      bytes: 0,
      token_estimate: 0,
      limits,
    });
  const unresolved: RepairContextUnresolved[] = [];
  const omissionsPlaceholder: RepairContextOmission[] = [];
  const allowed = [...new Set(input.allowedPaths)].sort();
  const deps = [...new Set(input.dependencyPaths ?? [])].sort();
  const configured = input.configuredContext ?? [];
  const diagnostics = compactEngineeringCompilerDiagnostics(input.diagnostics);
  const symbols = diagnosticSymbols(diagnostics);
  const callSiteTypeFromExcerpt = (excerpt: string): string | undefined => {
    const source = excerpt
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/"(?:\\.|[^"\\])*"/gu, "")
      .replace(/\/\/.*$/gmu, "");
    return source.match(/\b([A-Z][A-Za-z0-9_]*)\s*\(/u)?.[1];
  };
  const callSiteSymbols = new Set(
    diagnostics.flatMap((diagnostic) => {
      if (
        !/(?:extra|extraneous|incorrect\s+argument\s+label|missing\s+argument|trailing\s+closure)/iu.test(
          diagnostic.message,
        )
      )
        return [];
      const match = callSiteTypeFromExcerpt(diagnostic.excerpt);
      return match === undefined ? [] : [match];
    }),
  );
  const callSiteDiagnostics = diagnostics.filter(
    (diagnostic) =>
      /(?:extra|extraneous|incorrect\s+argument\s+label|missing\s+argument|trailing\s+closure)/iu.test(
        diagnostic.message,
      ) && callSiteTypeFromExcerpt(diagnostic.excerpt) === undefined,
  );
  const memberFunctionSymbols = new Set<string>();
  const memberSymbols = new Set(
    diagnostics.flatMap((diagnostic) => {
      if (!/(?:get-only|cannot convert value)/iu.test(diagnostic.message)) return [];
      const text = `${diagnostic.message}\n${diagnostic.excerpt}`
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/"(?:\\.|[^"\\])*"/gu, "")
        .replace(/\/\/.*$/gmu, "");
      const memberNames = [
        ...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\s*(?:=|\()/gu),
      ].map((match) =>
        match[0]!
          .replace(/\s*(?:=|\()\s*$/u, "")
          .split(".")
          .at(-1)!,
      );
      for (const name of memberNames)
        if (new RegExp(`(?:\\.|^)${name}\\s*\\(`, "u").test(text)) memberFunctionSymbols.add(name);
      const quotedGetOnly =
        /["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s+is\s+a\s+get-only\s+property/iu.exec(
          diagnostic.message,
        )?.[1];
      return quotedGetOnly === undefined ? memberNames : [...memberNames, quotedGetOnly];
    }),
  );
  const repairSymbols = [...new Set([...symbols, ...callSiteSymbols, ...memberSymbols])].sort();
  const candidates: RepairContextPlanEntry[] = [];
  const add = (entry: RepairContextPlanEntry, enforceScope = true): void => {
    if (enforceScope && !isInside(entry.relative_path, allowed)) return;
    if (!candidates.some((item) => identity(item) === identity(entry)))
      candidates.push(Object.freeze(entry));
  };
  const coordinate = (d: EngineeringCompilerDiagnostic): string =>
    `${d.path}:${d.line}:${d.column}`;
  for (const d of diagnostics)
    add({
      kind: "READ",
      relative_path: d.path,
      category: "DIAGNOSTIC_LOCATION",
      rank: 0,
      required: true,
      provenance: coordinate(d),
    });
  for (const d of diagnostics) {
    const manifestPath = engineeringSwiftPackageManifestPath(d.path);
    const needsModuleEvidence =
      missingTypeDiagnosticSymbol(d.message) !== null ||
      missingModuleDiagnostic(d.message) ||
      /(?:extra|extraneous|incorrect\s+argument\s+label|missing\s+argument|trailing\s+closure)/iu.test(
        d.message,
      );
    if (manifestPath !== null && needsModuleEvidence)
      add(
        {
          kind: "READ",
          relative_path: manifestPath,
          category: "DIAGNOSTIC_LOCATION",
          rank: 0,
          required: true,
          provenance: `module-manifest:${d.path}`,
        },
        false,
      );
  }
  for (const diagnostic of callSiteDiagnostics) {
    add(
      {
        kind: "SEARCH",
        relative_path: ".",
        query: `__call_site_lookup__:${diagnostic.path}:${diagnostic.line}`,
        category: "DECLARATION",
        rank: 1,
        required: true,
        provenance: `call-site-lookup:${diagnostic.path}:${diagnostic.line}`,
        declaration_lookup_roots: allowed,
        declaration_lookup_required: true,
        declaration_lookup_manifest_required: true,
        call_site_lookup_required: true,
        call_site_diagnostic_path: diagnostic.path,
        call_site_diagnostic_line: diagnostic.line,
      },
      false,
    );
  }
  for (const symbol of repairSymbols) {
    const declarationMatches = deps.filter((path) => {
      const name = base(path);
      return (
        (diagnostics.some((diagnostic) => isTestPath(diagnostic.path)) || !isTestPath(path)) &&
        (name === symbol ||
          (!isTestPath(path) &&
            name.length >= 4 &&
            (symbol.startsWith(name) || name.startsWith(symbol))))
      );
    });
    for (const path of declarationMatches)
      add(
        {
          kind: "READ",
          relative_path: path,
          category: "DECLARATION",
          rank: 1,
          required: true,
          provenance: `symbol:${symbol}`,
        },
        false,
      );
    const testMatches = deps.filter(
      (path) => isTestPath(path) && (base(path).includes(symbol) || path.includes(symbol)),
    );
    for (const path of testMatches)
      add({
        kind: "READ",
        relative_path: path,
        category: "TEST_SUPPORT",
        rank: 3,
        required: false,
        provenance: `symbol:${symbol}`,
      });
    const configuredDeclarationMatches = configured.some(
      (entry) =>
        entry.kind === "READ" &&
        !isTestPath(entry.relative_path) &&
        base(entry.relative_path) === symbol,
    );
    if (declarationMatches.length === 0 && !configuredDeclarationMatches) {
      const hasOutOfScope = deps.some((path) => base(path) === symbol || path.includes(symbol));
      // A dependency list is an observation of prior slices, not a repository index. Ask the
      // read boundary for a root-level filename/content observation so a declaration living in
      // a sibling module can be promoted to an exact READ before compiler repair. The marker is
      // consumed only by the server prefetcher; it never widens the model's write allowlist.
      const missingTypeDiagnostics = diagnostics.filter((diagnostic) => {
        return (
          missingTypeDiagnosticSymbol(diagnostic.message) === symbol ||
          missingMemberReceiverSymbol(diagnostic.message) === symbol
        );
      });
      const directMissingTypeDiagnostics = missingTypeDiagnostics.filter(
        (diagnostic) =>
          missingMemberReceiverSymbol(diagnostic.message) === symbol ||
          !diagnosticUsesSymbolAsQualifiedNamespace(diagnostic, symbol),
      );
      const receiverDiagnostics = missingTypeDiagnostics.filter(
        (diagnostic) =>
          missingMemberReceiverSymbol(diagnostic.message) === symbol &&
          !isImplicitMemberDiagnostic(diagnostic, symbol),
      );
      const missingTypeDiagnostic =
        receiverDiagnostics.length > 0 ||
        directMissingTypeDiagnostics.length > 0 ||
        callSiteSymbols.has(symbol) ||
        memberSymbols.has(symbol);
      const testOnlyMissingType =
        receiverDiagnostics.length === 0 &&
        directMissingTypeDiagnostics.length > 0 &&
        directMissingTypeDiagnostics.every((diagnostic) => isTestPath(diagnostic.path));
      const receiverMemberDiagnostics = missingTypeDiagnostics.filter(
        (diagnostic) => missingMemberReceiverSymbol(diagnostic.message) === symbol,
      );
      const implicitMember =
        receiverMemberDiagnostics.length > 0 &&
        receiverMemberDiagnostics.every((diagnostic) =>
          isImplicitMemberDiagnostic(diagnostic, symbol),
        );
      if (
        (/^[A-Z]/u.test(symbol) || memberSymbols.has(symbol)) &&
        missingTypeDiagnostic &&
        !implicitMember
      )
        add(
          {
            kind: "SEARCH",
            relative_path: ".",
            query: memberSymbols.has(symbol)
              ? `${memberFunctionSymbols.has(symbol) ? "func" : "var"} ${symbol}`
              : symbol,
            category: "DECLARATION",
            rank: 1,
            required: false,
            provenance: `declaration-lookup:${symbol}`,
            declaration_lookup_symbol: symbol,
            declaration_lookup_roots: memberSymbols.has(symbol)
              ? (() => {
                  const configuredRoots = configured
                    .filter(
                      (entry) =>
                        entry.kind === "READ" &&
                        entry.relative_path.endsWith(".swift") &&
                        !isTestPath(entry.relative_path),
                    )
                    .map((entry) => entry.relative_path);
                  return configuredRoots.length > 0
                    ? configuredRoots
                    : allowed.filter((path) => !isTestPath(path) && path.endsWith(".swift"));
                })()
              : allowed,
            declaration_lookup_required: !testOnlyMissingType,
            declaration_lookup_manifest_required: true,
            declaration_lookup_member: memberSymbols.has(symbol),
          },
          false,
        );
      // A SEARCH is a bounded server request, not a writer path. Test declarations are eligible.
      add({
        kind: "SEARCH",
        relative_path: allowed[0]!,
        query: symbol,
        category: testOnlyMissingType || isTestPath(allowed[0] ?? "") ? "TEST_SUPPORT" : "USAGE",
        rank: testOnlyMissingType || isTestPath(allowed[0] ?? "") ? 3 : 2,
        required: false,
        provenance: `missing-symbol:${symbol}`,
      });
      unresolved.push(
        Object.freeze({
          symbol,
          // Only an explicit missing-type diagnostic is a required declaration contract. Other
          // compiler symbols (for example property/member names) are usage context and must not
          // make finalization fail closed as an unresolved declaration.
          category: testOnlyMissingType
            ? "TEST_SUPPORT"
            : missingTypeDiagnostic
              ? "DECLARATION"
              : "USAGE",
          reason: hasOutOfScope ? "OUT_OF_SCOPE" : "NO_MATCH",
          diagnostic_coordinates: Object.freeze(
            diagnostics.map((d) => `${d.path}:${d.line}:${d.column}`).sort(),
          ),
        }),
      );
    }
  }
  const searchRoots = [
    ...new Set([
      ...allowed.filter((path) => !path.endsWith(".swift")),
      ...deps.filter(
        (path) =>
          !isTestPath(path) &&
          symbols.some((symbol) => {
            const name = base(path);
            return (
              /^[A-Z]/u.test(symbol) &&
              !deps.some((candidate) => base(candidate) === symbol) &&
              (name === symbol ||
                (name.length >= 4 && (symbol.startsWith(name) || name.startsWith(symbol))))
            );
          }),
      ),
    ]),
  ].sort();
  for (const root of searchRoots)
    for (const symbol of symbols) {
      add(
        {
          kind: "SEARCH",
          relative_path: root,
          query: symbol,
          category: "USAGE",
          rank: 2,
          required: false,
          provenance: `bounded-symbol:${symbol}`,
        },
        deps.includes(root) ? false : true,
      );
    }
  for (const entry of configured) {
    const query = "query" in entry ? entry.query : "";
    const matches = symbols.some(
      (symbol) =>
        query.includes(symbol) || (symbol.length >= 4 && query.includes(symbol.slice(0, 4))),
    );
    const exactConfiguredDeclaration =
      entry.kind === "READ" && symbols.some((symbol) => base(entry.relative_path) === symbol);
    const configuredDeclarationSymbol =
      entry.kind === "READ"
        ? symbols.find((symbol) => base(entry.relative_path) === symbol)
        : undefined;
    const pairedSearchMatches =
      entry.kind === "READ" &&
      configured.some(
        (candidate) =>
          candidate.kind === "SEARCH" &&
          candidate.relative_path === entry.relative_path &&
          symbols.some((symbol) => candidate.query.includes(symbol)),
      );
    if (matches || exactConfiguredDeclaration || pairedSearchMatches)
      add(
        {
          ...entry,
          category: entry.kind === "READ" ? "DECLARATION" : "USAGE",
          rank: entry.kind === "READ" ? 1 : 2,
          required: entry.kind === "READ",
          provenance:
            configuredDeclarationSymbol === undefined
              ? `configured:${query}`
              : `symbol:${configuredDeclarationSymbol}`,
        },
        false,
      );
  }
  for (const path of input.reviewRegressionPaths ?? [])
    add({
      kind: "READ",
      relative_path: path,
      category: "REVIEW_REGRESSION",
      rank: 4,
      required: false,
      provenance: "review-regression",
    });
  // Configured gate context is deliberately not appended wholesale. Unrelated entries are
  // retained as bounded omissions so the epoch can explain the choice without paying their bytes.
  for (const entry of configured) {
    const descriptor = JSON.stringify(entry);
    if (!candidates.some((item) => identity(item) === identity(entry as RepairContextPlanEntry))) {
      omissionsPlaceholder.push(
        Object.freeze({
          category: "CONFIGURED_UNRELATED",
          relative_path: entry.relative_path,
          query: "query" in entry ? entry.query : null,
          required: false,
          reason: "NO_MATCH",
          digest: digest(descriptor),
        }),
      );
    }
  }
  const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const stableIdentity = (a: string, b: string): number => {
    const lower = (value: string): number =>
      /^[a-z_]/u.test(value.split(":").at(-1) ?? value) ? 0 : 1;
    return lower(a) - lower(b) || ordinal(a, b);
  };
  candidates.sort(
    (a, b) =>
      categoryRank[a.category] - categoryRank[b.category] ||
      Number(b.declaration_lookup_required === true) -
        Number(a.declaration_lookup_required === true) ||
      Number(b.required === true) - Number(a.required === true) ||
      ordinal(a.relative_path, b.relative_path) ||
      stableIdentity(identity(a), identity(b)),
  );
  const selected: RepairContextPlanEntry[] = [];
  const omissions: RepairContextOmission[] = [...omissionsPlaceholder];
  let totalBytes = 0;
  let totalTokens = 0;
  let totalDiscoveryCalls = 0;
  for (const entry of candidates) {
    const required = entry.required || entry.declaration_lookup_required === true;
    const descriptor = serializedPlanEntry(entry);
    const tentative = [...selected, entry];
    const serialized = serializedPlanEntries(tentative);
    const reason =
      selected.length >= limits.entries
        ? "ENTRY_LIMIT"
        : totalDiscoveryCalls +
              engineeringRepairContextEntryCallCost(
                entry,
                diagnostics
                  .filter((diagnostic) => diagnostic.path === entry.relative_path)
                  .map((d) => d.line),
              ) >
            ENGINEERING_REPAIR_DISCOVERY_CALL_BUDGET
          ? "DISCOVERY_CALL_BUDGET"
          : bytes(serialized) > limits.bytes
            ? "BYTE_BUDGET"
            : compilerRepairContextTokenEstimate(serialized) > limits.tokens
              ? "TOKEN_BUDGET"
              : null;
    if (reason !== null)
      omissions.push(
        Object.freeze({
          category: entry.category,
          relative_path: entry.relative_path,
          query: entry.query ?? null,
          required,
          reason,
          digest: digest(descriptor),
        }),
      );
    else {
      selected.push(entry);
      totalDiscoveryCalls += engineeringRepairContextEntryCallCost(
        entry,
        diagnostics
          .filter((diagnostic) => diagnostic.path === entry.relative_path)
          .map((d) => d.line),
      );
      totalBytes = bytes(serializedPlanEntries(selected));
      totalTokens = compilerRepairContextTokenEstimate(serializedPlanEntries(selected));
    }
  }
  for (const omission of omissions) {
    if (!omission.required) continue;
    const symbol =
      omission.query ??
      omission.relative_path
        .split("/")
        .at(-1)
        ?.replace(/\.[^.]+$/u, "") ??
      omission.relative_path;
    unresolved.push(
      Object.freeze({
        symbol,
        category: "DECLARATION",
        reason: "REQUIRED_DECLARATION_UNRESOLVED",
        diagnostic_coordinates: Object.freeze(
          diagnostics.map((d) => `${d.path}:${d.line}:${d.column}`).sort(),
        ),
      }),
    );
  }
  omissions.sort((a, b) =>
    a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0,
  );
  return Object.freeze({
    entries: Object.freeze(selected),
    omissions: Object.freeze(omissions),
    unresolved: Object.freeze(unresolved),
    diagnostics: Object.freeze(
      diagnostics.map((d) =>
        Object.freeze({ path: d.path, line: d.line, column: d.column, digest: d.digest }),
      ),
    ),
    bytes: totalBytes,
    token_estimate: totalTokens,
    limits,
  });
}

export function diagnosticSymbols(
  diagnostics: readonly EngineeringCompilerDiagnostic[],
): readonly string[] {
  const symbols = new Set<string>();
  for (const d of diagnostics) {
    const receiver = missingMemberReceiverSymbol(d.message);
    const symbolMessage = receiver === null ? d.message : d.message.replace(/<[^\n]*>/u, "");
    const synthesizedProperty =
      /invalid redeclaration of synthesized property\s+["'`](_[A-Za-z_][A-Za-z0-9_]*)["'`]/u.exec(
        symbolMessage,
      )?.[1];
    for (const match of symbolMessage.matchAll(/["'`‘’]([A-Za-z_][A-Za-z0-9_.]{2,127})["'`‘’]/gu))
      for (const part of match[1]!.split(".")) if (part !== synthesizedProperty) symbols.add(part);
    for (const match of symbolMessage.matchAll(
      /\b[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/gu,
    ))
      symbols.add(match[0]);
    if (receiver !== null) symbols.add(receiver);
  }
  return Object.freeze(
    [...symbols]
      .sort(
        (a, b) =>
          (/^[a-z_]/u.test(a) ? 0 : 1) - (/^[a-z_]/u.test(b) ? 0 : 1) ||
          (a < b ? -1 : a > b ? 1 : 0),
      )
      .slice(0, 8),
  );
}

/** Collapse duplicate compiler emissions only when their root semantic identity is recognized. */
export function compactEngineeringCompilerDiagnostics(
  diagnostics: readonly EngineeringCompilerDiagnostic[],
): readonly EngineeringCompilerDiagnostic[] {
  const seen = new Set<string>();
  const compacted: EngineeringCompilerDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const message = diagnostic.message;
    const symbol =
      missingTypeDiagnosticSymbol(message) ??
      /cannot find ['"]?([A-Za-z_][A-Za-z0-9_]*)['"]? in scope/u.exec(message)?.[1] ??
      /(?:has no member|no member named) ['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/u.exec(message)?.[1] ??
      /(?:no such module|no module named|Unable to find module dependency:)\s*['"]?([^'"\s]+)['"]?/iu.exec(
        message,
      )?.[1] ??
      /(?:invalid argument|extraneous argument|missing argument) (?:label: )?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/iu.exec(
        message,
      )?.[1];
    if (symbol === undefined) {
      compacted.push(diagnostic);
      continue;
    }
    const category = missingTypeDiagnosticSymbol(message)
      ? "MISSING_TYPE"
      : /module dependency|no such module|no module named/iu.test(message)
        ? "MISSING_MODULE"
        : /member/iu.test(message)
          ? "MISSING_MEMBER"
          : /argument|label/iu.test(message)
            ? "ARGUMENT"
            : "MISSING_SYMBOL";
    const receiver = missingMemberReceiverSymbol(message);
    const memberShape =
      receiver === null
        ? ""
        : isImplicitMemberDiagnostic(diagnostic, receiver)
          ? ":IMPLICIT"
          : ":EXPLICIT";
    const key = `${diagnostic.path}:${category}:${symbol}${memberShape}`;
    if (!seen.has(key)) {
      seen.add(key);
      compacted.push(diagnostic);
    }
  }
  return Object.freeze(compacted);
}
