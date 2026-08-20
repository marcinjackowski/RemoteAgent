import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import * as remoteagentContracts from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";
import type * as TypeScriptApi from "typescript";

import * as implementationTools from "../src/index.js";
import {
  AmbiguityReason,
  MAX_TOOL_OUTPUT_BYTES,
  ToolKind,
  ToolOutcome,
  implementationToolIntent,
  implementationToolResult,
  toolOutput,
} from "../src/index.js";

/**
 * The TypeScript API is loaded through `require` on purpose: it ships as CJS
 * (`export = ts`), so this is the one access form that cannot depend on interop
 * guesswork about which named exports a bundler managed to detect.
 */
const ts = createRequire(import.meta.url)("typescript") as typeof TypeScriptApi;

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const identity = { case_id: "case-1", workspace_id: "ws-1" };

/** Drop a key so the schema sees a genuinely absent field, not `undefined`. */
function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = "patch applied";
  return {
    trust: "UNTRUSTED_DATA",
    value,
    truncated: false,
    original_byte_length: value.length,
    ...overrides,
  };
}

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    operation_id: "op-1",
    identity,
    kind: ToolKind.APPLY_PATCH,
    before_digest: DIGEST_A,
    changed_files: ["src/app.ts"],
    ...overrides,
  };
}

function succeeded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    operation_id: "op-1",
    identity,
    kind: ToolKind.APPLY_PATCH,
    before_digest: DIGEST_A,
    after_digest: DIGEST_B,
    changed_files: ["src/app.ts"],
    outcome: ToolOutcome.SUCCEEDED,
    output: output(),
    ...overrides,
  };
}

function ambiguous(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    operation_id: "op-2",
    identity,
    kind: ToolKind.APPLY_PATCH,
    before_digest: DIGEST_A,
    after_digest: null,
    changed_files: ["src/app.ts", "src/other.ts"],
    outcome: ToolOutcome.AMBIGUOUS,
    ambiguity_reason: AmbiguityReason.PARTIAL_WRITE,
    requires_reconciliation: true,
    output: output(),
    ...overrides,
  };
}

describe("tool contracts are strict and versioned", () => {
  it("accepts a well-formed intent and result", () => {
    expect(implementationToolIntent.parse(intent()).schema_version).toBe(1);
    expect(implementationToolResult.parse(succeeded()).outcome).toBe(ToolOutcome.SUCCEEDED);
  });

  it("rejects an unknown field on the intent instead of dropping it", () => {
    expect(
      implementationToolIntent.safeParse({ ...intent(), host_path: "/etc/passwd" }).success,
    ).toBe(false);
  });

  it("rejects an unknown field on the result instead of dropping it", () => {
    expect(implementationToolResult.safeParse({ ...succeeded(), retries: 3 }).success).toBe(false);
  });

  it("rejects a missing or future schema_version", () => {
    expect(implementationToolIntent.safeParse(without(intent(), "schema_version")).success).toBe(
      false,
    );
    expect(implementationToolIntent.safeParse({ ...intent(), schema_version: 2 }).success).toBe(
      false,
    );
  });

  it("rejects a digest that is not sha256-shaped", () => {
    expect(
      implementationToolIntent.safeParse({ ...intent(), before_digest: "deadbeef" }).success,
    ).toBe(false);
    expect(
      implementationToolResult.safeParse(succeeded({ after_digest: "sha256:zz" })).success,
    ).toBe(false);
  });
});

describe("changed_files carries workspace-relative paths only", () => {
  it("rejects an absolute host path", () => {
    expect(
      implementationToolIntent.safeParse(intent({ changed_files: ["/etc/passwd"] })).success,
    ).toBe(false);
    expect(
      implementationToolResult.safeParse(succeeded({ changed_files: ["/tmp/out.txt"] })).success,
    ).toBe(false);
  });

  it("rejects parent traversal", () => {
    expect(
      implementationToolIntent.safeParse(intent({ changed_files: ["../secrets.env"] })).success,
    ).toBe(false);
  });

  it("rejects an unbounded path list", () => {
    const tooMany = Array.from({ length: 257 }, (_unused, index) => `src/f${String(index)}.ts`);
    expect(implementationToolIntent.safeParse(intent({ changed_files: tooMany })).success).toBe(
      false,
    );
  });
});

describe("tool output is pinned to UNTRUSTED_DATA, bounded and explicit about truncation", () => {
  it("rejects output that claims a higher trust level", () => {
    expect(toolOutput.safeParse(output({ trust: "TRUSTED" })).success).toBe(false);
    expect(
      implementationToolResult.safeParse(succeeded({ output: output({ trust: "TRUSTED" }) }))
        .success,
    ).toBe(false);
  });

  it("rejects output larger than the bounded maximum", () => {
    const oversized = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 1);
    expect(
      toolOutput.safeParse(
        output({ value: oversized, truncated: false, original_byte_length: oversized.length }),
      ).success,
    ).toBe(false);
  });

  it("accepts output at exactly the bounded maximum", () => {
    const exact = "x".repeat(MAX_TOOL_OUTPUT_BYTES);
    expect(
      toolOutput.safeParse(
        output({ value: exact, truncated: false, original_byte_length: exact.length }),
      ).success,
    ).toBe(true);
  });

  it("rejects clipped output that does not declare truncation", () => {
    expect(
      toolOutput.safeParse(output({ value: "abc", truncated: false, original_byte_length: 9_000 }))
        .success,
    ).toBe(false);
  });

  it("accepts clipped output that declares truncation", () => {
    expect(
      toolOutput.safeParse(output({ value: "abc", truncated: true, original_byte_length: 9_000 }))
        .success,
    ).toBe(true);
  });

  it("rejects a carried payload larger than the declared original", () => {
    expect(
      toolOutput.safeParse(output({ value: "abcdef", truncated: true, original_byte_length: 2 }))
        .success,
    ).toBe(false);
  });
});

describe("the outcome set is closed and AMBIGUOUS is first-class", () => {
  it("parses an ambiguous partial write", () => {
    const parsed = implementationToolResult.parse(ambiguous());
    expect(parsed.outcome).toBe(ToolOutcome.AMBIGUOUS);
    if (parsed.outcome !== ToolOutcome.AMBIGUOUS) throw new Error("expected AMBIGUOUS");
    expect(parsed.ambiguity_reason).toBe(AmbiguityReason.PARTIAL_WRITE);
    expect(parsed.requires_reconciliation).toBe(true);
    expect(parsed.after_digest).toBeNull();
    expect(parsed.changed_files).toEqual(["src/app.ts", "src/other.ts"]);
  });

  it("rejects any outcome outside SUCCEEDED | FAILED | AMBIGUOUS", () => {
    expect(implementationToolResult.safeParse(succeeded({ outcome: "PARTIAL" })).success).toBe(
      false,
    );
    expect(implementationToolResult.safeParse(succeeded({ outcome: "UNKNOWN" })).success).toBe(
      false,
    );
  });

  it("cannot record an ambiguous state as SUCCEEDED", () => {
    // The ambiguity fields are not part of the SUCCEEDED variant, so relabelling
    // an ambiguous result as a success fails to parse rather than losing them.
    const relabelled = { ...ambiguous(), outcome: ToolOutcome.SUCCEEDED, after_digest: DIGEST_B };
    expect(implementationToolResult.safeParse(relabelled).success).toBe(false);
  });

  it("requires SUCCEEDED to carry a verified post-state digest", () => {
    expect(implementationToolResult.safeParse(succeeded({ after_digest: null })).success).toBe(
      false,
    );
  });

  it("requires an ambiguous result to demand reconciliation", () => {
    expect(
      implementationToolResult.safeParse(ambiguous({ requires_reconciliation: false })).success,
    ).toBe(false);
    expect(
      implementationToolResult.safeParse(without(ambiguous(), "ambiguity_reason")).success,
    ).toBe(false);
  });

  it("keeps FAILED clean: a failure that changed files is not representable", () => {
    const failed = {
      schema_version: 1,
      operation_id: "op-3",
      identity,
      kind: ToolKind.RUN_COMMAND,
      before_digest: DIGEST_A,
      after_digest: DIGEST_A,
      changed_files: [],
      outcome: ToolOutcome.FAILED,
      failure_code: "COMMAND_EXIT_1",
      output: output(),
    };
    expect(implementationToolResult.safeParse(failed).success).toBe(true);
    expect(
      implementationToolResult.safeParse({ ...failed, changed_files: ["src/app.ts"] }).success,
    ).toBe(false);
  });
});

/**
 * Every name this package exports, types included, read from the barrel with the
 * TypeScript checker.
 *
 * A runtime `Object.keys` sees only values, so a colliding *type* alias would slip
 * past it; the checker's module exports are the complete public surface.
 */
function exportedNames(entry: string, program: TypeScriptApi.Program): ReadonlySet<string> {
  const source = program.getSourceFile(entry);
  if (source === undefined) {
    throw new Error(`could not load ${entry} into the export-surface program`);
  }
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) {
    throw new Error(`${entry} is not a module`);
  }
  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()));
}

describe("the export surface cannot collide with @remoteagent/contracts", () => {
  const ownEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const contractsEntry = fileURLToPath(new URL("../../contracts/src/index.ts", import.meta.url));

  it("shares no exported name at all with @remoteagent/contracts", () => {
    const program = ts.createProgram([ownEntry, contractsEntry], {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      noEmit: true,
    });
    const own = exportedNames(ownEntry, program);
    const theirs = exportedNames(contractsEntry, program);

    // Guard against a vacuous pass: an empty surface would trivially not collide.
    expect(own.size).toBeGreaterThan(20);
    expect(theirs.size).toBeGreaterThan(20);

    const shared = [...own].filter((name) => theirs.has(name)).sort();
    // Two `export *` barrels that both supply a name are NOT a compile error:
    // ESM omits the ambiguous name, so a consumer of a combined surface silently
    // gets `undefined` where a schema was expected. Keep the intersection empty.
    expect(shared).toEqual([]);
  });

  it("exports its own tool intent and result under unambiguous names", () => {
    const contractsExports: Record<string, unknown> = remoteagentContracts;
    const ownExports: Record<string, unknown> = implementationTools;

    expect(ownExports["implementationToolIntent"]).toBe(implementationToolIntent);
    expect(ownExports["implementationToolResult"]).toBe(implementationToolResult);
    expect(ownExports["toolIntent"]).toBeUndefined();
    expect(ownExports["toolResult"]).toBeUndefined();
    // The broker contracts still exist and are a different shape: `toolIntent`
    // there rejects this package's operation-shaped intent outright.
    expect(contractsExports["toolIntent"]).not.toBe(implementationToolIntent);
    expect(remoteagentContracts.toolIntent.safeParse(intent()).success).toBe(false);
  });
});
