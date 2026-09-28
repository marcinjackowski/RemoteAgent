import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundedRepairContextEvidence,
  boundEngineeringRepairPrefetchedEvidence,
  buildEngineeringRepairContext,
  ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY,
  compilerRepairContextTokenEstimate,
  diagnosticSymbols,
  finalizeEngineeringRepairContext,
  repairContextMetadata,
  type EngineeringRepairContextPlan,
  type RepairContextPlanEntry,
} from "../../apps/agent-worker/src/engineering-repair-context.js";
import { canonicalDigest, type EngineeringCompilerDiagnostic } from "@remoteagent/contracts";
import {
  engineeringImplementationEpochHandoff,
  engineeringImplementationPrompt,
} from "../../apps/agent-worker/src/engineering-execution.js";

const diagnostic = (
  message: string,
  path = "Sources/Feature/Flow.swift",
): EngineeringCompilerDiagnostic => ({
  path,
  line: 10,
  column: 4,
  message,
  excerpt: message,
  digest: canonicalDigest(message),
});

const readEnvelope = (relative_path: string, content: string, fileDigest?: string) => ({
  tool: "read",
  refused: false,
  complete: true,
  relative_path,
  digest: fileDigest ?? `sha256:${"a".repeat(64)}`,
  content,
});

const diagnosticRead = (path: string) =>
  readEnvelope(
    path,
    Array.from({ length: 64 }, (_, index) => `source line ${index + 1}`).join("\n") +
      `\nstruct ${
        path
          .split("/")
          .at(-1)
          ?.replace(/\.swift$/u, "") ?? "Source"
      } {}`,
  );

const requiredReads = (plan: { entries: readonly RepairContextPlanEntry[] }) =>
  plan.entries
    .filter((entry) => entry.kind === "READ" && entry.required === true)
    .map((entry) => ({
      kind: "READ" as const,
      relative_path: entry.relative_path,
      query: entry.query ?? null,
      evidence: JSON.stringify(diagnosticRead(entry.relative_path)),
    }));

const syntheticRead = (
  relative_path: string,
  query: string,
  extra: Partial<RepairContextPlanEntry> = {},
): RepairContextPlanEntry => ({
  kind: "READ",
  relative_path,
  query,
  category: "DECLARATION",
  rank: 0,
  required: true,
  provenance: "test-synthetic-read",
  ...extra,
});

const syntheticPlan = (
  entries: readonly RepairContextPlanEntry[],
): EngineeringRepairContextPlan => ({
  entries,
  omissions: [],
  unresolved: [],
  diagnostics: [],
  bytes: 0,
  token_estimate: 0,
  limits: { entries: 24, bytes: 100_000, tokens: 20_000 },
});

describe("bounded compiler repair context", () => {
  it("ranks the diagnostic, declaration, usage, and test support deterministically", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("type 'SafetyAlert' has no member 'onText988'")],
      allowedPaths: ["Sources/Feature"],
      dependencyPaths: [
        "Sources/Feature/SafetyAlert.swift",
        "Tests/Feature/SafetyAlertTests.swift",
      ],
    });
    expect(plan.entries.slice(0, 2).map((entry) => entry.category)).toEqual([
      "DIAGNOSTIC_LOCATION",
      "DECLARATION",
    ]);
    expect(plan.entries.some((entry) => entry.category === "TEST_SUPPORT")).toBe(false);
  });

  it("allows test declarations for test-target diagnostics and preserves no-match state", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [
        diagnostic("cannot find 'TestSupport' in scope", "Tests/Feature/FlowTests.swift"),
      ],
      allowedPaths: ["Tests/Feature"],
      dependencyPaths: ["Tests/Feature/TestSupport.swift"],
    });
    expect(
      plan.entries.some(
        (entry) =>
          entry.relative_path.endsWith("TestSupport.swift") && entry.category === "DECLARATION",
      ),
    ).toBe(true);
    expect(plan.unresolved).toHaveLength(0);
    const missing = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'MissingProtocol' in scope")],
      allowedPaths: ["Sources/Feature"],
    });
    expect(missing.unresolved[0]?.reason).toBe("NO_MATCH");
    const rootLookup = missing.entries.find(
      (entry) => entry.declaration_lookup_symbol === "MissingProtocol",
    );
    expect(rootLookup).toMatchObject({
      kind: "SEARCH",
      relative_path: ".",
      required: false,
      declaration_lookup_roots: ["Sources/Feature"],
    });
    expect(rootLookup?.kind).not.toBe("READ");
    expect(
      missing.entries
        .filter((entry) => entry !== rootLookup)
        .every(
          (entry) =>
            (entry.relative_path === "Package.swift" &&
              entry.provenance === "module-manifest:Sources/Feature/Flow.swift") ||
            entry.relative_path === "Sources/Feature" ||
            entry.relative_path.startsWith("Sources/Feature/"),
        ),
    ).toBe(true);
    expect(missing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "READ",
          relative_path: "Package.swift",
          required: true,
        }),
      ]),
    );
  });

  it("covers conformance, initializer, member, import, and review-regression symbols", () => {
    const diagnostics = [
      diagnostic("type 'Flow' does not conform to protocol 'ActionHandling'"),
      diagnostic("missing argument for parameter 'title' in call", "Sources/Feature/Alert.swift"),
      diagnostic("value of type 'Alert' has no member 'onText988'", "Sources/Feature/Alert.swift"),
      diagnostic("no such module 'TestSupport'", "Tests/Feature/FlowTests.swift"),
    ];
    expect(diagnosticSymbols(diagnostics)).toContain("ActionHandling");
    expect(diagnosticSymbols(diagnostics)).toContain("onText988");
    const plan = buildEngineeringRepairContext({
      diagnostics,
      allowedPaths: ["Sources/Feature", "Tests/Feature"],
      dependencyPaths: ["Sources/Feature/ActionHandling.swift", "Tests/Feature/TestSupport.swift"],
      reviewRegressionPaths: ["Sources/Feature/ReviewBaseline.swift"],
    });
    expect(plan.entries.some((entry) => entry.category === "REVIEW_REGRESSION")).toBe(true);
    expect(
      plan.entries.findIndex((entry) => entry.category === "REVIEW_REGRESSION"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("recovers simple receivers from no-member diagnostics without promoting aliases", () => {
    const diagnostics = [
      diagnostic("value of type 'AgentAIPreferences' has no member 'items'"),
      diagnostic("value of type 'AgentAIPreferences' has no member 'items'"),
      diagnostic("value of type 'String.Element' (aka 'Character') has no member 'items'"),
    ];
    expect(diagnosticSymbols(diagnostics)).toEqual(
      expect.arrayContaining(["AgentAIPreferences", "items"]),
    );
    const plan = buildEngineeringRepairContext({
      diagnostics,
      allowedPaths: ["Sources/Feature"],
    });
    expect(
      plan.entries.filter((entry) => entry.declaration_lookup_symbol === "AgentAIPreferences"),
    ).toHaveLength(1);
    expect(plan.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "AgentAIPreferences", category: "DECLARATION" }),
        expect.objectContaining({ symbol: "items", category: "USAGE" }),
      ]),
    );
    expect(plan.entries.some((entry) => entry.declaration_lookup_symbol === "String")).toBe(false);
    expect(
      plan.entries.find((entry) => entry.declaration_lookup_symbol === "AgentAIPreferences")
        ?.declaration_lookup_required,
    ).toBe(true);
    expect(() => finalizeEngineeringRepairContext(plan, requiredReads(plan))).toThrow(
      "REQUIRED_DECLARATION_UNRESOLVED",
    );
    const staticPlan = buildEngineeringRepairContext({
      diagnostics: [
        { ...diagnostic("type 'Preferences' has no member 'foo'"), excerpt: "Preferences.foo" },
      ],
      allowedPaths: ["Sources/Feature"],
    });
    expect(
      staticPlan.entries.find((entry) => entry.declaration_lookup_symbol === "Preferences")
        ?.declaration_lookup_required,
    ).toBe(true);
    const prosePlan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("note: type 'Preferences' has no member 'foo' in example")],
      allowedPaths: ["Sources/Feature"],
    });
    expect(
      prosePlan.entries.some((entry) => entry.declaration_lookup_symbol === "Preferences"),
    ).toBe(false);
  });

  it("selects one call-site type from an anchored initializer excerpt", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [
        {
          ...diagnostic("extra argument 'content' in call", "Sources/Feature/SafetyAlert.swift"),
          excerpt: "DecoyType is mentioned; ButtonView(model: model, content: content)",
        },
      ],
      allowedPaths: ["Sources/Feature"],
      dependencyPaths: [],
    });
    expect(plan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declaration_lookup_symbol: "ButtonView",
          declaration_lookup_required: true,
        }),
      ]),
    );
    expect(plan.entries.some((entry) => entry.declaration_lookup_symbol === "DecoyType")).toBe(
      false,
    );
  });

  it("ignores only synthesized underscore redeclarations while retaining the paired property", () => {
    const diagnostics = [
      diagnostic("invalid redeclaration of 'careTeamSharingRepository'"),
      diagnostic("invalid redeclaration of synthesized property '_careTeamSharingRepository'"),
    ];
    const plan = buildEngineeringRepairContext({
      diagnostics,
      allowedPaths: ["Sources/Feature"],
      dependencyPaths: ["Sources/Feature/careTeamSharingRepository.swift"],
    });
    expect(diagnosticSymbols(diagnostics)).toContain("careTeamSharingRepository");
    expect(diagnosticSymbols(diagnostics)).not.toContain("_careTeamSharingRepository");
    expect(plan.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "READ",
          relative_path: "Sources/Feature/careTeamSharingRepository.swift",
          category: "DECLARATION",
          required: true,
        }),
        expect.objectContaining({
          kind: "READ",
          relative_path: "Sources/Feature/Flow.swift",
          category: "DIAGNOSTIC_LOCATION",
          required: true,
        }),
      ]),
    );
    expect(plan.unresolved.some((item) => item.symbol === "_careTeamSharingRepository")).toBe(
      false,
    );
  });

  it("keeps genuine missing type and underscore symbols discoverable and unresolved", () => {
    const missingType = diagnostic("cannot find type 'EmergencyResources' in scope");
    const missingPrivate = diagnostic("cannot find '_PrivateType' in scope");
    expect(diagnosticSymbols([missingType, missingPrivate])).toEqual(
      expect.arrayContaining(["EmergencyResources", "_PrivateType"]),
    );
    const plan = buildEngineeringRepairContext({
      diagnostics: [missingType, missingPrivate],
      allowedPaths: ["Sources/Feature"],
    });
    expect(plan.unresolved.map((item) => item.symbol)).toEqual(
      expect.arrayContaining(["EmergencyResources", "_PrivateType"]),
    );
  });

  it("bounds observed bytes, not only descriptors", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [10, 20, 30].map((line) => ({ ...diagnostic("compiler failure"), line })),
      allowedPaths: ["Sources/Feature"],
      maxBytes: 1_000,
      maxTokens: 1_000,
    });
    expect(plan.omissions.filter((omission) => omission.required)).toEqual([]);
    const content = Array.from({ length: 30 }, () => "x".repeat(100)).join("\n");
    expect(() =>
      boundEngineeringRepairPrefetchedEvidence(plan, [
        {
          kind: "READ",
          relative_path: "Sources/Feature/Flow.swift",
          query: null,
          evidence: JSON.stringify(readEnvelope("Sources/Feature/Flow.swift", content)),
        },
      ]),
    ).toThrow("REQUIRED_DIAGNOSTIC_TRUNCATED");
  });

  it("retains decoded READ content without re-encoding validated envelopes", () => {
    const content = 'line 1 "quoted"\nline 2 — café 🧪\n';
    const excerptPlan = {
      ...syntheticPlan([syntheticRead("Sources/Feature/Flow.swift", "excerpt")]),
      diagnostics: [diagnostic("compiler failure")],
    };
    const boundedExcerpt = boundEngineeringRepairPrefetchedEvidence(excerptPlan, [
      {
        kind: "READ",
        relative_path: "Sources/Feature/Flow.swift",
        query: "excerpt",
        evidence: JSON.stringify({
          tool: "read_excerpt",
          relative_path: "Sources/Feature/Flow.swift",
          complete: false,
          start_line: 10,
          end_line: 11,
          full_file_digest: `sha256:${"b".repeat(64)}`,
          content,
        }),
      },
    ]);
    expect(boundedExcerpt[0]!.evidence).toBe(content);

    const completePlan = syntheticPlan([syntheticRead("Sources/Feature/Flow.swift", "lookup")]);
    const boundedComplete = boundEngineeringRepairPrefetchedEvidence(completePlan, [
      {
        kind: "READ",
        relative_path: "Sources/Feature/Flow.swift",
        query: "lookup",
        evidence: JSON.stringify({
          tool: "read",
          relative_path: "Sources/Feature/Flow.swift",
          complete: true,
          digest: `sha256:${"c".repeat(64)}`,
          content,
        }),
      },
    ]);
    expect(boundedComplete[0]!.evidence).toBe(content);
  });

  it("enforces byte/token bounds and never silently truncates required evidence", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'MissingProtocol' in scope")],
      allowedPaths: ["Sources/Feature"],
      maxEntries: 1,
      maxBytes: 10,
      maxTokens: 2,
    });
    expect(plan.omissions.every((omission) => omission.digest.startsWith("sha256:"))).toBe(true);
    expect(() =>
      boundedRepairContextEvidence({
        evidence: "required declaration",
        maxBytes: 4,
        required: true,
      }),
    ).toThrow("REQUIRED_DECLARATION_TRUNCATED");
    expect(compilerRepairContextTokenEstimate("abcd")).toBe(1);
  });

  it("returns an empty repair plan without compiler diagnostics", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [],
      allowedPaths: ["Sources/Feature"],
    });
    expect(plan.entries).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it("uses the versioned expanded default context policy", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("compiler failure")],
      allowedPaths: ["Sources/Feature"],
    });
    expect(plan.limits).toEqual({
      entries: ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.entries,
      bytes: ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.bytes,
      tokens: ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.tokens,
    });
    expect(plan.limits.bytes).toBeGreaterThan(24_000);
    expect(plan.limits.bytes).toBeLessThan(48_001);
    const content = "x".repeat(30_000);
    const retained = boundEngineeringRepairPrefetchedEvidence(
      {
        ...syntheticPlan([syntheticRead("Sources/Feature/Flow.swift", "lookup")]),
        limits: ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY,
      },
      [
        {
          kind: "READ",
          relative_path: "Sources/Feature/Flow.swift",
          query: "lookup",
          evidence: JSON.stringify(readEnvelope("Sources/Feature/Flow.swift", content)),
        },
      ],
    );
    expect(retained[0]!.evidence).toBe(content);
  });

  it.each([
    [
      "Unable to find module dependency: 'DesignSystem'",
      "SonderClient/SonderClientLibrary/Sources/Feature/View.swift",
      "SonderClient/SonderClientLibrary/Package.swift",
    ],
    [
      "no such module 'DesignSystem'",
      "SonderClient/SonderClientLibrary/Tests/Feature/ViewTests.swift",
      "SonderClient/SonderClientLibrary/Package.swift",
    ],
    ["no module named 'DesignSystem'", "Sources/View.swift", "Package.swift"],
    ["no such module 'DesignSystem'", "Tests/ViewTests.swift", "Package.swift"],
    ["no such module 'DesignSystem'", "Tests/Fixtures/Sources/View.swift", "Package.swift"],
  ])(
    "requires the consuming manifest for missing-module diagnostics: %s",
    (message, path, expectedManifest) => {
      const plan = buildEngineeringRepairContext({
        diagnostics: [diagnostic(message, path), diagnostic(message, path)],
        allowedPaths: [path.split("/").slice(0, -1).join("/")],
      });
      expect(plan.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "READ",
            relative_path: expectedManifest,
            required: true,
          }),
        ]),
      );
      expect(plan.entries.filter((entry) => entry.relative_path === expectedManifest)).toHaveLength(
        1,
      );
      expect(plan.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "READ", relative_path: path, required: true }),
        ]),
      );
      const evidence = requiredReads(plan);
      expect(() => finalizeEngineeringRepairContext(plan, evidence)).not.toThrow();
      expect(() =>
        finalizeEngineeringRepairContext(
          plan,
          evidence.filter((entry) => entry.relative_path !== expectedManifest),
        ),
      ).toThrow("REQUIRED_DIAGNOSTIC_TRUNCATED");
      expect(() =>
        finalizeEngineeringRepairContext(
          plan,
          evidence.map((entry) =>
            entry.relative_path === expectedManifest
              ? {
                  ...entry,
                  evidence: JSON.stringify({
                    tool: "read",
                    refused: true,
                    complete: false,
                    relative_path: expectedManifest,
                  }),
                }
              : entry,
          ),
        ),
      ).toThrow("REQUIRED_DIAGNOSTIC_TRUNCATED");
    },
  );

  it("does not classify prose mentioning a missing module as module evidence", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("note: no such module 'DesignSystem' was discussed")],
      allowedPaths: ["Sources"],
    });
    expect(plan.entries.some((entry) => entry.relative_path === "Package.swift")).toBe(false);
  });

  it("finalizes required evidence above the old limit and refuses evidence above the new limit", () => {
    const plan = {
      ...syntheticPlan([syntheticRead("Sources/Feature/Flow.swift", "lookup")]),
      limits: ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY,
    };
    const read = (content: string) => ({
      kind: "READ" as const,
      relative_path: "Sources/Feature/Flow.swift",
      query: "lookup",
      evidence: content,
    });
    const retained = finalizeEngineeringRepairContext(plan, [read("x".repeat(30_000))]);
    expect(retained.evidence[0]!.evidence).toHaveLength(30_000);
    expect(() => finalizeEngineeringRepairContext(plan, [read("x".repeat(49_000))])).toThrow(
      "REQUIRED_DECLARATION_TRUNCATED",
    );
  });

  it("refuses a declaration lookup when its consuming manifest is absent or refused", () => {
    const path = "Sources/Feature/Flow.swift";
    const symbol = "Flow";
    const plan = syntheticPlan([
      syntheticRead(path, `__declaration_lookup__:${symbol}`, {
        declaration_lookup_symbol: symbol,
        declaration_lookup_required: true,
      }),
    ]);
    const declaration = {
      kind: "READ" as const,
      relative_path: path,
      query: `__declaration_lookup__:${symbol}`,
      evidence: JSON.stringify(readEnvelope(path, `struct ${symbol} {}`)),
    };
    expect(() => finalizeEngineeringRepairContext(plan, [declaration])).toThrow(
      /REQUIRED_DECLARATION_(TRUNCATED|UNRESOLVED)/u,
    );
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        declaration,
        {
          kind: "READ",
          relative_path: "Package.swift",
          query: `__module_manifest__:${symbol}`,
          evidence: "",
        },
      ]),
    ).toThrow(/REQUIRED_DECLARATION_(TRUNCATED|UNRESOLVED)/u);
  });

  it("shares one complete manifest by package path across declaration lookups", () => {
    const declarationEnvelope = (path: string, symbol: string) =>
      JSON.stringify({ ...diagnosticRead(path), content: `public struct ${symbol} {}` });
    const plan = syntheticPlan([
      syntheticRead(
        "Sources/Feature/One.swift",
        "__declaration_lookup__:One@Sources/Feature/Flow.swift:10",
      ),
      syntheticRead(
        "Sources/Feature/Two.swift",
        "__declaration_lookup__:Two@Sources/Feature/Flow.swift:10",
      ),
    ]);
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        {
          kind: "READ",
          relative_path: "Sources/Feature/One.swift",
          query: plan.entries[0]!.query!,
          evidence: declarationEnvelope("Sources/Feature/One.swift", "One"),
        },
        {
          kind: "READ",
          relative_path: "Sources/Feature/Two.swift",
          query: plan.entries[1]!.query!,
          evidence: declarationEnvelope("Sources/Feature/Two.swift", "Two"),
        },
        {
          kind: "READ",
          relative_path: "Package.swift",
          query: "__module_manifest__:One",
          evidence: JSON.stringify(diagnosticRead("Package.swift")),
        },
      ]),
    ).not.toThrow();
  });

  it("rejects a missing or truncated consuming manifest for a dynamic declaration", () => {
    const path = "Sources/Feature/One.swift";
    const plan = syntheticPlan([
      syntheticRead(path, "__declaration_lookup__:One@Sources/Feature/Flow.swift:10"),
    ]);
    const declaration = {
      kind: "READ" as const,
      relative_path: path,
      query: plan.entries[0]!.query!,
      evidence: JSON.stringify({ ...diagnosticRead(path), content: "public struct One {}" }),
    };
    expect(() => finalizeEngineeringRepairContext(plan, [declaration])).toThrow(
      "REQUIRED_DECLARATION_TRUNCATED",
    );
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        declaration,
        {
          kind: "READ",
          relative_path: "Package.swift",
          query: "__module_manifest__:One",
          evidence: JSON.stringify({
            tool: "read_excerpt",
            complete: false,
            relative_path: "Package.swift",
            start_line: 1,
            end_line: 1,
            full_file_digest: "sha256:manifest",
            content: "let package = Package()",
          }),
        },
      ]),
    ).toThrow("REQUIRED_DECLARATION_UNRESOLVED");
  });

  it("rejects omission of one declaration from two required call-site slots", () => {
    const plan = syntheticPlan([
      syntheticRead(
        "Sources/Feature/One.swift",
        "__declaration_lookup__:One@Sources/Feature/Flow.swift:10",
        {
          call_site_lookup_required: true,
          call_site_diagnostic_path: "Sources/Feature/Flow.swift",
          call_site_diagnostic_line: 10,
        },
      ),
      syntheticRead(
        "Sources/Feature/Two.swift",
        "__declaration_lookup__:Two@Sources/Feature/Flow.swift:20",
        {
          call_site_lookup_required: true,
          call_site_diagnostic_path: "Sources/Feature/Flow.swift",
          call_site_diagnostic_line: 20,
        },
      ),
    ]);
    const evidence = (path: string, query: string, content: string) => ({
      kind: "READ" as const,
      relative_path: path,
      query,
      evidence: JSON.stringify({ ...diagnosticRead(path), content }),
    });
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        evidence("Sources/Feature/One.swift", plan.entries[0]!.query!, "public struct One {}"),
        evidence("Package.swift", "__module_manifest__:One", "let package = Package()"),
      ]),
    ).toThrow("REQUIRED_DECLARATION_TRUNCATED");
  });

  it("reconciles successful and empty bounded SEARCH outcomes", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'Missing' in scope")],
      allowedPaths: ["Sources/Feature"],
    });
    const search = plan.entries.find(
      (entry) => entry.kind === "SEARCH" && entry.query === "Missing",
    )!;
    const provisional = {
      ...plan,
      unresolved: plan.unresolved.map((item) => ({ ...item, category: "USAGE" as const })),
    };
    const success = finalizeEngineeringRepairContext(provisional, [
      ...requiredReads(provisional),
      {
        kind: "SEARCH",
        relative_path: search.relative_path,
        query: search.query!,
        evidence: "declaration Missing {}",
      },
    ]);
    expect(success.unresolved.some((item) => item.symbol === search.query)).toBe(false);
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        ...requiredReads(plan),
        { kind: "SEARCH", relative_path: search.relative_path, query: search.query!, evidence: "" },
      ]),
    ).toThrow("REQUIRED_DECLARATION_UNRESOLVED");
  });

  it("escalates every required declaration unresolved, including out-of-scope", () => {
    const basePlan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'Missing' in scope")],
      allowedPaths: ["Sources/Feature"],
    });
    const plan = {
      ...basePlan,
      unresolved: [
        {
          symbol: "Missing",
          category: "DECLARATION" as const,
          reason: "OUT_OF_SCOPE" as const,
          diagnostic_coordinates: ["Sources/Feature/Flow.swift:10:4"],
        },
      ],
    };
    expect(plan.unresolved.some((item) => item.reason === "OUT_OF_SCOPE")).toBe(true);
    expect(() => finalizeEngineeringRepairContext(plan, requiredReads(plan))).toThrow(
      "REQUIRED_DECLARATION_UNRESOLVED",
    );
  });

  it("accepts a required declaration marker when its Swift filename differs from the symbol", () => {
    const symbol = "EmergencyResourcesViewModel";
    const declarationPath = "Sources/Feature/ChatEmergencyResourcesView.swift";
    const plan = {
      ...syntheticPlan([
        syntheticRead(declarationPath, "unresolved-lookup", {
          declaration_lookup_symbol: symbol,
          declaration_lookup_required: true,
        }),
      ]),
      unresolved: [
        {
          symbol,
          category: "DECLARATION" as const,
          reason: "NO_MATCH" as const,
          diagnostic_coordinates: ["Sources/Feature/Flow.swift:10:4"],
        },
      ],
    };
    const declarationEvidence = JSON.stringify(
      readEnvelope(declarationPath, `public final class ${symbol} {}`),
    );
    const manifestPath = "Package.swift";
    const evidence = [
      {
        kind: "READ",
        relative_path: declarationPath,
        query: `__declaration_lookup__:${symbol}`,
        evidence: declarationEvidence,
      },
      {
        kind: "READ",
        relative_path: manifestPath,
        query: `__module_manifest__:${symbol}`,
        evidence: JSON.stringify(readEnvelope(manifestPath, "// swift-tools-version: 5.9")),
      },
    ] as const;
    const final = finalizeEngineeringRepairContext(plan, evidence);
    expect(final.unresolved).toEqual([]);
    expect(final.evidence[0]).toMatchObject({
      relative_path: declarationPath,
      query: `__declaration_lookup__:${symbol}`,
    });
    expect(() => finalizeEngineeringRepairContext(plan, [evidence[0]])).toThrow(
      "REQUIRED_DECLARATION_TRUNCATED",
    );
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        {
          ...evidence[0],
          evidence: JSON.stringify(readEnvelope(declarationPath, `let value = ${symbol}()`)),
        },
        evidence[1],
      ]),
    ).toThrow("REQUIRED_DECLARATION_UNRESOLVED");
    const prioritized = finalizeEngineeringRepairContext(
      { ...plan, limits: { ...plan.limits, bytes: final.bytes + 64, tokens: 6000 } },
      [
        {
          kind: "SEARCH",
          relative_path: "optional.swift",
          query: "noise",
          evidence: "x".repeat(200),
        },
        ...evidence,
      ],
    );
    expect(prioritized.evidence).toEqual(final.evidence);
  });

  it("records optional actual overflow without retaining a raw prefix", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("compiler failure")],
      allowedPaths: ["Sources/Feature"],
      reviewRegressionPaths: ["Sources/Feature/Review.swift"],
      maxBytes: 1000,
      maxTokens: 100,
    });
    expect(plan.omissions.filter((omission) => omission.required)).toEqual([]);
    const optional = plan.entries.find((entry) => !entry.required);
    if (optional === undefined) throw new Error("expected optional entry");
    const evidence = 'optional fragment with a quote \\" and slash \\\\'.repeat(100);
    const final = finalizeEngineeringRepairContext({ ...plan, unresolved: [] }, [
      ...requiredReads(plan),
      {
        kind: optional.kind,
        relative_path: optional.relative_path,
        query: optional.query ?? null,
        evidence,
      },
    ]);
    expect(final.evidence.some((item) => item.evidence === evidence)).toBe(false);
    expect(
      final.omissions.some(
        (item) =>
          (item.reason === "BYTE_BUDGET" || item.reason === "TOKEN_BUDGET") &&
          item.digest.length > 20,
      ),
    ).toBe(true);
  });

  it("keeps metadata free of raw evidence and epochs digest-only", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'Missing' in scope")],
      allowedPaths: ["Sources/Feature"],
      dependencyPaths: ["Sources/Feature/Missing.swift"],
    });
    const entry = plan.entries.find((candidate) => candidate.required !== true)!;
    const sentinel = 'unique-evidence-sentinel\\"\\\\';
    const final = finalizeEngineeringRepairContext(plan, [
      ...requiredReads(plan),
      {
        kind: entry.kind,
        relative_path: entry.relative_path,
        query: entry.query ?? null,
        evidence: sentinel,
      },
    ]);
    expect(JSON.stringify(repairContextMetadata(final))).not.toContain(sentinel);
    expect(final.evidence.some((item) => item.evidence === sentinel)).toBe(true);
    const prompt = engineeringImplementationPrompt({
      objective: "repair",
      slice: { slice_id: "s", allowed_paths: ["Sources/Feature"], gate_ids: [] } as never,
      contextPacket: "packet",
      gateGuidance: [],
      prefetchedContext: final.evidence,
      repairContext: final,
    });
    expect(
      prompt.match(
        new RegExp(
          JSON.stringify(sentinel)
            .slice(1, -1)
            .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
          "g",
        ),
      )?.length,
    ).toBe(1);
    const epoch = JSON.stringify(
      engineeringImplementationEpochHandoff({
        objective: "repair",
        slice: { slice_id: "s", allowed_paths: ["Sources/Feature"], gate_ids: [] } as never,
        contextPacket: "packet",
        gateGuidance: [],
        prefetchedContext: final.evidence,
        repairContext: final,
      }),
    );
    expect(epoch).not.toContain(sentinel);
  });

  it("preserves unresolved symbol diagnostics in the digest-only epoch", () => {
    const sourceDiagnostic = diagnostic("cannot find 'MissingProtocol' in scope");
    const plan = buildEngineeringRepairContext({
      diagnostics: [sourceDiagnostic],
      allowedPaths: ["Sources/Feature"],
    });
    const sentinel = "unresolved-raw-evidence-sentinel";
    const epoch = engineeringImplementationEpochHandoff({
      objective: "repair unresolved declaration",
      slice: { slice_id: "s", allowed_paths: ["Sources/Feature"], gate_ids: [] } as never,
      contextPacket: "packet",
      gateGuidance: [],
      prefetchedContext: [
        {
          kind: "SEARCH",
          relative_path: "Sources/Feature",
          query: "MissingProtocol",
          evidence: sentinel,
        },
      ],
      repairContext: plan,
    });
    const value = epoch[0]?.content[0]?.type === "json" ? epoch[0].content[0].value : undefined;
    expect(value).toMatchObject({
      repair_context: {
        unresolved: [
          {
            symbol: "MissingProtocol",
            reason: "NO_MATCH",
            diagnostic_coordinates: ["Sources/Feature/Flow.swift:10:4"],
          },
        ],
      },
    });
    expect(JSON.stringify(value)).not.toContain(sentinel);
  });

  it("rejects oversized required diagnostic evidence after a fitting plan", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("compiler failure")],
      allowedPaths: ["Sources/Feature"],
      maxBytes: 1_000,
      maxTokens: 1_000,
    });
    expect(plan.entries[0]?.category).toBe("DIAGNOSTIC_LOCATION");
    expect(plan.omissions.some((omission) => omission.required)).toBe(false);
    expect(() =>
      finalizeEngineeringRepairContext(plan, [
        {
          kind: "READ",
          relative_path: "Sources/Feature/Flow.swift",
          query: null,
          evidence: "oversized-diagnostic-evidence".repeat(100),
        },
      ]),
    ).toThrow("REQUIRED_DIAGNOSTIC_TRUNCATED");
  });

  it("retains every diagnostic coordinate as bounded contiguous canonical read fragments", () => {
    const diagnostics = [
      diagnostic("compiler failure", "Sources/Feature/Large.swift"),
      { ...diagnostic("compiler failure", "Sources/Feature/Large.swift"), line: 162 },
      { ...diagnostic("compiler failure", "Sources/Feature/Large.swift"), line: 200 },
      diagnostic("compiler failure", "Sources/Feature/Other.swift"),
      diagnostic("compiler failure", "Sources/Feature/Tests.swift"),
    ];
    diagnostics[0] = { ...diagnostics[0]!, line: 40 };
    const plan = buildEngineeringRepairContext({
      diagnostics,
      allowedPaths: ["Sources/Feature"],
      maxBytes: 24_000,
      maxTokens: 6_000,
    });
    const large = Array.from(
      { length: 220 },
      (_, index) => `${String(index + 1)} ${"x".repeat(190)}`,
    ).join("\n");
    const largeDigest = `sha256:${createHash("sha256").update(large, "utf8").digest("hex")}`;
    const other = Array.from({ length: 80 }, (_, index) => `other ${index + 1}`).join("\n");
    const final = finalizeEngineeringRepairContext(plan, [
      {
        kind: "READ",
        relative_path: "Sources/Feature/Large.swift",
        query: null,
        evidence: JSON.stringify(readEnvelope("Sources/Feature/Large.swift", large, largeDigest)),
      },
      {
        kind: "READ",
        relative_path: "Sources/Feature/Other.swift",
        query: null,
        evidence: JSON.stringify(readEnvelope("Sources/Feature/Other.swift", other)),
      },
      {
        kind: "READ",
        relative_path: "Sources/Feature/Tests.swift",
        query: null,
        evidence: JSON.stringify(readEnvelope("Sources/Feature/Tests.swift", other)),
      },
    ]);
    expect(final.bytes).toBeLessThanOrEqual(ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.bytes);
    expect(final.token_estimate).toBeLessThanOrEqual(
      ENGINEERING_COMPILER_REPAIR_CONTEXT_POLICY.tokens,
    );
    const largeFragments = final.evidence.filter((entry) =>
      entry.relative_path.endsWith("Large.swift"),
    );
    expect(largeFragments.length).toBeGreaterThan(0);
    for (const fragment of largeFragments) {
      expect(fragment.complete).toBe(false);
      expect(fragment.full_file_digest).toBe(largeDigest);
      expect(fragment.start_line).toBeDefined();
      expect(fragment.end_line).toBeGreaterThanOrEqual(fragment.start_line!);
    }
    for (const line of [40, 162, 200]) {
      expect(
        largeFragments.some(
          (fragment) =>
            line >= fragment.start_line! &&
            line <= fragment.end_line! &&
            fragment.evidence.includes(`${line} `),
        ),
      ).toBe(true);
    }
  });

  it("protects required fragments from an earlier oversized optional search", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("compiler failure")],
      allowedPaths: ["Sources/Feature"],
      reviewRegressionPaths: ["Sources/Feature/Optional.swift"],
    });
    const final = finalizeEngineeringRepairContext(plan, [
      {
        kind: "READ",
        relative_path: "Sources/Feature/Optional.swift",
        query: null,
        evidence: "o".repeat(47_900),
      },
      {
        kind: "READ",
        relative_path: "Sources/Feature/Flow.swift",
        query: null,
        evidence: JSON.stringify(
          readEnvelope(
            "Sources/Feature/Flow.swift",
            `${Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n")}\nerror`,
          ),
        ),
      },
    ]);
    expect(
      final.evidence.some((entry) => entry.relative_path === "Sources/Feature/Flow.swift"),
    ).toBe(true);
    expect(
      final.omissions.some(
        (item) =>
          item.relative_path.endsWith("Optional.swift") &&
          (item.reason === "BYTE_BUDGET" || item.reason === "TOKEN_BUDGET"),
      ),
    ).toBe(true);
  });

  it("fails closed for missing diagnostic coordinates, oversized lines, and declarations", () => {
    const coordinatePlan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("compiler failure")],
      allowedPaths: ["Sources/Feature"],
    });
    expect(() =>
      finalizeEngineeringRepairContext(coordinatePlan, [
        {
          kind: "READ",
          relative_path: "Sources/Feature/Flow.swift",
          query: null,
          evidence: JSON.stringify(readEnvelope("Sources/Feature/Flow.swift", "only line")),
        },
      ]),
    ).toThrow("REQUIRED_DIAGNOSTIC_TRUNCATED");
    const huge = `${"x".repeat(30_000)}`;
    expect(() =>
      finalizeEngineeringRepairContext(coordinatePlan, [
        {
          kind: "READ",
          relative_path: "Sources/Feature/Flow.swift",
          query: null,
          evidence: JSON.stringify(readEnvelope("Sources/Feature/Flow.swift", huge)),
        },
      ]),
    ).toThrow("REQUIRED_DIAGNOSTIC_TRUNCATED");
    const declarationPlan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'Missing' in scope")],
      allowedPaths: ["Sources/Feature"],
      dependencyPaths: ["Sources/Feature/Missing.swift"],
    });
    expect(() =>
      finalizeEngineeringRepairContext(declarationPlan, [
        {
          kind: "READ",
          relative_path: "Sources/Feature/Missing.swift",
          query: null,
          evidence: JSON.stringify(
            readEnvelope("Sources/Feature/Missing.swift", "struct Other {}"),
          ),
        },
      ]),
    ).toThrow("REQUIRED_DECLARATION_UNRESOLVED");
  });

  it("keeps configured declaration SEARCH bounded without duplicating it as READ", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'Missing' in scope")],
      allowedPaths: ["Sources/Feature"],
      configuredContext: [{ kind: "SEARCH", relative_path: "Sources/Feature", query: "Missing" }],
    });
    expect(
      plan.entries.filter(
        (entry) => entry.relative_path === "Sources/Feature" && entry.query === null,
      ),
    ).toEqual([]);
    expect(plan.entries).toContainEqual(
      expect.objectContaining({ kind: "SEARCH", query: "Missing" }),
    );
  });

  it("preserves mixed line-ending bytes and does not invent SEARCH file metadata", () => {
    const content = "prefix\r\ncompiler line\r\nsuffix\nlast";
    const fileDigest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    const plan = buildEngineeringRepairContext({
      diagnostics: [{ ...diagnostic("compiler failure"), line: 2 }],
      allowedPaths: ["Sources/Feature"],
      configuredContext: [{ kind: "SEARCH", relative_path: "Sources/Feature", query: "Missing" }],
    });
    const final = finalizeEngineeringRepairContext(plan, [
      {
        kind: "READ",
        relative_path: "Sources/Feature/Flow.swift",
        query: null,
        evidence: JSON.stringify(readEnvelope("Sources/Feature/Flow.swift", content, fileDigest)),
      },
      {
        kind: "SEARCH",
        relative_path: "Sources/Feature",
        query: "Missing",
        evidence: "bounded result",
      },
    ]);
    const fragment = final.evidence.find((entry) => entry.kind === "READ")!;
    expect(fragment.evidence).toBe(content);
    expect(fragment.full_file_digest).toBe(fileDigest);
    const search = final.retained.find((entry) => entry.kind === "SEARCH");
    expect(search?.complete).toBeUndefined();
    expect(search?.full_file_digest).toBeUndefined();
  });

  it("uses ordinal ordering for mixed-case paths", () => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [diagnostic("cannot find 'Missing' in scope")],
      allowedPaths: ["Sources/Feature"],
      configuredContext: [
        { kind: "READ", relative_path: "Sources/Feature/z.swift" },
        { kind: "READ", relative_path: "Sources/Feature/A.swift" },
      ],
    });
    const paths = plan.omissions.map((entry) => entry.relative_path);
    expect(paths).toContain("Sources/Feature/A.swift");
    expect(paths).toContain("Sources/Feature/z.swift");
    expect(paths.indexOf("Sources/Feature/A.swift")).toBeLessThan(
      paths.indexOf("Sources/Feature/z.swift"),
    );
  });

  it("accounts for array framing when selecting byte and token boundaries", () => {
    const entries: RepairContextPlanEntry[] = [
      {
        kind: "READ" as const,
        relative_path: "Sources/Feature/A.swift",
        category: "USAGE" as const,
        rank: 2,
        required: false,
        provenance: "test",
      },
      {
        kind: "READ" as const,
        relative_path: "Sources/Feature/B.swift",
        category: "USAGE" as const,
        rank: 2,
        required: false,
        provenance: "test",
      },
    ];
    const evidence = entries.map((entry) => ({
      ...entry,
      query: entry.query ?? null,
      evidence: "fragment",
    }));
    const fragmentBytes = evidence.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8"),
      0,
    );
    const fragmentTokens = evidence.reduce(
      (sum, entry) => sum + compilerRepairContextTokenEstimate(JSON.stringify(entry)),
      0,
    );
    const base = {
      entries,
      omissions: [],
      unresolved: [],
      diagnostics: [],
    } as const;
    const byteFinal = finalizeEngineeringRepairContext(
      {
        ...base,
        bytes: 0,
        token_estimate: 0,
        limits: { entries: 2, bytes: fragmentBytes, tokens: 10_000 },
      },
      evidence,
    );
    expect(byteFinal.bytes).toBe(Buffer.byteLength(JSON.stringify(byteFinal.evidence), "utf8"));
    expect(byteFinal.token_estimate).toBe(
      compilerRepairContextTokenEstimate(JSON.stringify(byteFinal.evidence)),
    );
    expect(byteFinal.bytes).toBeLessThanOrEqual(byteFinal.limits.bytes);
    expect(byteFinal.omissions.at(-1)?.reason).toBe("BYTE_BUDGET");

    const tokenFinal = finalizeEngineeringRepairContext(
      {
        ...base,
        bytes: 0,
        token_estimate: 0,
        limits: { entries: 2, bytes: 10_000, tokens: fragmentTokens - 1 },
      },
      evidence,
    );
    expect(tokenFinal.bytes).toBeLessThanOrEqual(tokenFinal.limits.bytes);
    expect(tokenFinal.token_estimate).toBe(
      compilerRepairContextTokenEstimate(JSON.stringify(tokenFinal.evidence)),
    );
    expect(tokenFinal.token_estimate).toBeLessThanOrEqual(tokenFinal.limits.tokens);
    expect(tokenFinal.omissions.at(-1)?.reason).toBe("TOKEN_BUDGET");
  });
});
