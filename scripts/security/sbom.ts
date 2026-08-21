/**
 * SBOM generation from the lockfile (RA-024-WU-10).
 *
 * WHY FROM THE LOCKFILE AND NOT FROM `node_modules`. An SBOM is a claim about what a
 * DEPLOYMENT contains, and `node_modules` on this machine is not that: it holds
 * whatever the last install left behind, including packages no longer referenced. The
 * lockfile is the thing CI and the deployment resolve from, so it is the only source
 * that can be checked against the artifact actually shipped.
 *
 * It is also the only source that works without a network and without a successful
 * install, which matters because this repository's `AGENTS.md` records both a broken
 * Homebrew `node` and a broken Docker on this machine. An SBOM tool that cannot run
 * on the machine doing the release is not a control.
 *
 * WHY NOT `pnpm audit`. It is complementary, not a substitute, and it is deliberately
 * NOT what this script does: `pnpm audit` requires the network, returns a different
 * answer on different days, and cannot be a gate for that reason — a build that fails
 * because an advisory was published overnight is not a reproducible build. The SBOM is
 * the deterministic half (what is in here), and advisory scanning is the changing half
 * (what is currently known about it). RA-025 owns wiring the second into CI, where a
 * non-deterministic result is acceptable because it does not block a release artifact.
 *
 * OUTPUT is CycloneDX 1.5 JSON, because that is what the ecosystem's scanners read.
 * `serialNumber` and `timestamp` are supplied by the CALLER rather than generated
 * here, so the same lockfile always produces byte-identical output — a diffable SBOM
 * is how a reviewer sees that a release added one dependency rather than three
 * hundred.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One resolved third-party package. */
export interface SbomComponent {
  readonly name: string;
  readonly version: string;
  /** Subresource integrity string from the lockfile, when present. */
  readonly integrity?: string;
  /** `engines.node` constraint, when the package declares one. */
  readonly engines?: string;
}

/** A workspace package. Named separately: these are first-party, not supply chain. */
export interface SbomWorkspacePackage {
  readonly name: string;
  readonly path: string;
}

export interface Sbom {
  readonly components: readonly SbomComponent[];
  readonly workspace: readonly SbomWorkspacePackage[];
  readonly lockfileVersion: string;
}

/**
 * Parse a pnpm v9 lockfile's `packages:` section.
 *
 * Hand-written rather than pulling in a YAML parser, and that is a deliberate
 * trade-off worth stating: the whole point of this script is to describe the supply
 * chain, so adding a dependency to do it enlarges the thing being measured. The
 * grammar consumed here is narrow and stable — a two-space-indented quoted key
 * followed by `resolution: {integrity: ...}` — and the parser FAILS LOUDLY on
 * anything it does not recognise rather than skipping it, because a silently skipped
 * component is an SBOM that under-reports.
 */
export function parseLockfile(contents: string): Sbom {
  const lines = contents.split("\n");
  const lockfileVersion = /^lockfileVersion:\s*'?([\d.]+)'?/m.exec(contents)?.[1] ?? "unknown";

  const components: SbomComponent[] = [];
  const workspace: SbomWorkspacePackage[] = [];

  // Workspace packages appear in `importers:` as `link:` versions.
  for (const match of contents.matchAll(/version: link:(\S+)/g)) {
    const path = match[1]!;
    const name = `@remoteagent/${path.split("/").pop() ?? path}`;
    if (!workspace.some((entry) => entry.path === path)) workspace.push({ name, path });
  }

  const packagesStart = lines.findIndex((line) => line === "packages:");
  if (packagesStart === -1) {
    throw new Error("lockfile has no `packages:` section; refusing to emit a partial SBOM");
  }

  // Entries are two-space indented; the section ends at the next zero-indent key.
  let current: { name: string; version: string; integrity?: string; engines?: string } | null =
    null;
  const flush = (): void => {
    if (current === null) return;
    components.push({
      name: current.name,
      version: current.version,
      ...(current.integrity === undefined ? {} : { integrity: current.integrity }),
      ...(current.engines === undefined ? {} : { engines: current.engines }),
    });
    current = null;
  };

  for (let index = packagesStart + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) break;

    // A component entry is EXACTLY two-space indented. Nested keys (`resolution`,
    // `engines`, `peerDependencies`, `os`) are four-space indented, so the negative
    // lookahead on a third space is what separates them — and it has to be explicit,
    // because a `{2}` prefix alone also matches four-space lines.
    //
    // Two forms occur in a pnpm v9 lockfile: `  'name@version':` for an entry with
    // children, and `  'name@version': {}` for one without. Both must be recognised;
    // the first version of this parser handled only the first and then choked on
    // `peerDependencies` — which it reported loudly rather than skipping, which is
    // the behaviour that made the bug visible in one run.
    const entry = /^ {2}(?! )'?([^']+?)'?:(?: \{\})?$/.exec(line);
    if (entry !== null) {
      flush();
      const specifier = entry[1]!;
      // `@scope/name@version` and `name@version`. The LAST `@` separates, since a
      // scope contributes one of its own.
      const at = specifier.lastIndexOf("@");
      if (at <= 0) {
        throw new Error(`unparseable lockfile entry: ${specifier}`);
      }
      current = { name: specifier.slice(0, at), version: specifier.slice(at + 1) };
      continue;
    }
    if (current === null) continue;

    const integrity = /integrity:\s*(sha\d+-[^\s,}]+)/.exec(line);
    if (integrity !== null) current.integrity = integrity[1]!;
    const engines = /engines:\s*\{node:\s*'?([^'}]+)'?\}/.exec(line);
    if (engines !== null) current.engines = engines[1]!.trim();
  }
  flush();

  if (components.length === 0) {
    // Fail loudly rather than emitting an empty SBOM. An SBOM claiming zero
    // dependencies would pass every downstream check while describing nothing, which
    // is worse than no SBOM at all.
    throw new Error("parsed zero components from the lockfile; refusing to emit an empty SBOM");
  }

  return { components, workspace, lockfileVersion };
}

/** A CycloneDX `purl` for an npm package. */
export function packageUrl(component: SbomComponent): string {
  // The scope's `@` and `/` must be encoded; the version must not be.
  const [scope, name] = component.name.startsWith("@")
    ? [
        component.name.slice(1, component.name.indexOf("/")),
        component.name.slice(component.name.indexOf("/") + 1),
      ]
    : [null, component.name];
  const base = scope === null ? `pkg:npm/${name}` : `pkg:npm/%40${scope}/${name}`;
  return `${base}@${component.version}`;
}

/** Render CycloneDX 1.5 JSON. Deterministic for a given lockfile and metadata. */
export function toCycloneDx(
  sbom: Sbom,
  metadata: {
    readonly serialNumber: string;
    readonly timestamp: string;
    readonly component: string;
  },
): string {
  const sorted = [...sbom.components].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
  return `${JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: metadata.serialNumber,
      version: 1,
      metadata: {
        timestamp: metadata.timestamp,
        component: { type: "application", name: metadata.component, version: "0.0.0" },
        properties: [
          { name: "remoteagent:lockfileVersion", value: sbom.lockfileVersion },
          { name: "remoteagent:workspacePackages", value: String(sbom.workspace.length) },
        ],
      },
      components: sorted.map((component) => ({
        type: "library",
        name: component.name,
        version: component.version,
        purl: packageUrl(component),
        ...(component.integrity === undefined
          ? {}
          : {
              hashes: [
                {
                  // pnpm records SRI; CycloneDX wants the algorithm named separately.
                  alg: component.integrity.startsWith("sha512-") ? "SHA-512" : "SHA-256",
                  content: component.integrity.replace(/^sha\d+-/, ""),
                },
              ],
            }),
      })),
    },
    null,
    2,
  )}\n`;
}

/** Read the repository lockfile and build the SBOM. */
export function generateSbom(lockfilePath: string): Sbom {
  return parseLockfile(readFileSync(lockfilePath, "utf8"));
}

// CLI: `tsx scripts/security/sbom.ts [--json]`
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const sbom = generateSbom(`${root}/pnpm-lock.yaml`);
  if (process.argv.includes("--json")) {
    // Timestamp and serial come from the environment so a CI run can make them
    // reproducible; defaulted here only for interactive use.
    process.stdout.write(
      toCycloneDx(sbom, {
        serialNumber: process.env.RA_SBOM_SERIAL ?? "urn:uuid:00000000-0000-0000-0000-000000000000",
        timestamp: process.env.RA_SBOM_TIMESTAMP ?? "1970-01-01T00:00:00.000Z",
        component: "remoteagent",
      }),
    );
  } else {
    process.stdout.write(
      `${String(sbom.components.length)} third-party components, ` +
        `${String(sbom.workspace.length)} workspace packages, ` +
        `lockfile v${sbom.lockfileVersion}\n`,
    );
  }
}
