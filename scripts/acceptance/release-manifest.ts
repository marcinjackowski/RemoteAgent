/**
 * Release manifest generation (RA-026-WU-03, AC5).
 *
 * AC5: "the release manifest makes it possible to reproduce the exact version of the
 * system." So the test of this file is not whether it lists things — it is whether
 * somebody handed only this manifest could rebuild the same system. Every field below
 * exists because its absence would break that, and the ones that CANNOT be captured are
 * listed as `unknown` rather than omitted.
 *
 * DETERMINISTIC BY CONSTRUCTION. Nothing here reads a clock or the network; the commit,
 * timestamp and serial are INPUTS. That is the same rule as `infra/cdk` (AC1) and for the
 * same reason: a manifest that differs between two runs on one commit cannot be used to
 * verify a deployment, because any difference could be either a real change or the tool.
 *
 * WHAT `unknown` MEANS AND WHY IT IS HONEST. The plan's own note (`2026-08-20`) records
 * that the model identity CHANGED during construction — ADR-0004 to ADR-0005 — so a
 * manifest claiming one model version would be false for most of the history it describes.
 * Prompt versioning does not exist as an artifact at all. Both are reported as `unknown`
 * with the reason attached, because "reproducible except for two fields you were not told
 * about" is the failure mode AC5 exists to prevent.
 */
import { readFileSync, readdirSync } from "node:fs";

/** One versioned component of the system. */
export interface ManifestComponent {
  readonly name: string;
  /** The version, or `unknown` when it genuinely cannot be established. */
  readonly version: string;
  /** How this version was determined, so a reader can re-derive it. */
  readonly source: string;
  /** Present when `version` is `unknown`: why, and what would be needed. */
  readonly gap?: string;
}

export interface ReleaseManifest {
  /** Git commit the manifest describes. Supplied, never read from the repository. */
  readonly commit: string;
  readonly generatedAt: string;
  readonly components: readonly ManifestComponent[];
  /** Third-party dependency count and lockfile version, from the SBOM. */
  readonly dependencies: { readonly count: number; readonly lockfileVersion: string };
  /** Criteria not fully proven, so a manifest reader sees them without a second document. */
  readonly knownGaps: readonly string[];
}

/** Highest applied migration number, from the migration directory. */
export function schemaVersion(migrationsDir: string): number {
  const versions = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".up.sql"))
    .map((name) => Number(/^(\d+)_/.exec(name)?.[1] ?? "0"))
    .filter((version) => version > 0);
  if (versions.length === 0) {
    // Fail loudly. A manifest reporting schema 0 would look like a fresh system and would
    // be indistinguishable from a broken generator.
    throw new Error(`no migrations found in ${migrationsDir}; refusing to emit a manifest`);
  }
  return Math.max(...versions);
}

/** The tool surface: every `ACTION_REGISTRY` key, so a reader knows what the system can do. */
export function toolVersion(policyEngineSource: string): { count: number; digestInput: string } {
  // Parsed from the source rather than imported, so the manifest generator does not pull
  // the policy package's module graph in. The count is what matters: a manifest whose tool
  // count differs from the deployment describes a different system.
  const registry =
    /export const ACTION_REGISTRY[\s\S]*?\n\}\);/.exec(policyEngineSource)?.[0] ?? "";
  const names = [...registry.matchAll(/"([a-z]+\.[a-z.]+)":\s*RiskTier\.R\d/g)].map(
    (match) => match[1]!,
  );
  if (names.length === 0) {
    throw new Error("could not parse ACTION_REGISTRY; refusing to emit a manifest");
  }
  return { count: names.length, digestInput: [...names].sort().join(",") };
}

/**
 * Build the manifest.
 *
 * `commit` and `generatedAt` are required inputs with no defaults. A default would make the
 * manifest non-deterministic in exactly the way that destroys its purpose.
 */
export function buildReleaseManifest(input: {
  readonly commit: string;
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly dependencyCount: number;
  readonly lockfileVersion: string;
  readonly knownGaps: readonly string[];
}): ReleaseManifest {
  const schema = schemaVersion(`${input.repoRoot}/packages/database/migrations`);
  const tools = toolVersion(
    readFileSync(`${input.repoRoot}/packages/policy/src/policy-engine.ts`, "utf8"),
  );
  const rootPackage = JSON.parse(readFileSync(`${input.repoRoot}/package.json`, "utf8")) as {
    engines?: { node?: string; pnpm?: string };
  };

  return {
    commit: input.commit,
    generatedAt: input.generatedAt,
    dependencies: { count: input.dependencyCount, lockfileVersion: input.lockfileVersion },
    knownGaps: input.knownGaps,
    components: [
      {
        name: "schema",
        version: String(schema),
        source: "highest numbered migration in packages/database/migrations",
      },
      {
        name: "tools",
        version: String(tools.count),
        source: "count of ACTION_REGISTRY entries in packages/policy/src/policy-engine.ts",
      },
      {
        name: "iac",
        // The IaC version IS the commit: `buildApp` is a pure function of its inputs, so
        // one commit plus one image tag determines the template exactly. Verified by the
        // byte-comparison test in `test/infra`.
        version: input.commit,
        source: "commit; buildApp is deterministic given (config, imageTag)",
      },
      {
        name: "node",
        version: rootPackage.engines?.node ?? "unknown",
        source: "engines.node in the root package.json",
      },
      {
        name: "pnpm",
        version: rootPackage.engines?.pnpm ?? "unknown",
        source: "engines.pnpm in the root package.json",
      },
      {
        name: "model",
        version: "unknown",
        source: "not captured anywhere in the repository",
        gap:
          "The model identity CHANGED during construction (ADR-0004 → ADR-0005), so a " +
          "single version would be false for most of the history this manifest describes. " +
          "Recording it requires the runtime to persist the resolved model id per agent " +
          "run — `bedrock-runtime` takes it from config and does not write it to a durable " +
          "row. Reported as unknown rather than guessed: a wrong model version in a " +
          "reproduction manifest is worse than an admitted absence.",
      },
      {
        name: "prompts",
        version: "unknown",
        source: "no prompt versioning artifact exists",
        gap:
          "Prompts are assembled from role definitions and context fragments at run time " +
          "and are never versioned as a unit. So the same commit can produce different " +
          "prompts as repository content changes — which is by design (the context IS the " +
          "repository) but means 'prompt version' is not a property this system has. " +
          "Capturing it would mean digesting the assembled prompt per run and storing it " +
          "alongside the checkpoint.",
      },
    ],
  };
}

/** Render as stable JSON. Byte-identical for identical inputs. */
export function renderManifest(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Components whose version could not be established. */
export function unknownComponents(manifest: ReleaseManifest): readonly ManifestComponent[] {
  return manifest.components.filter((component) => component.version === "unknown");
}
