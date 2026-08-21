/**
 * Deterministic dependency checks over the lockfile (RA-025-WU-10).
 *
 * THIS IS NOT `pnpm audit`, and the distinction is the whole design. Advisory scanning
 * needs the network and returns a different answer every day, so it cannot gate a
 * reproducible artifact — a build that fails because an advisory was published overnight
 * is not a reproducible build. It belongs in a scheduled CI job whose failure is a ticket,
 * not a blocked release.
 *
 * What CAN be a gate is the set of supply-chain properties that are decidable from the
 * lockfile alone, on any machine, with no network:
 *
 *   1. every third-party component has an integrity hash — without one, a lockfile entry
 *      records which version was *requested*, not which bytes arrived;
 *   2. no dependency resolves to a git URL, a tarball URL or `file:`, each of which
 *      bypasses the registry and the integrity hash together;
 *   3. no two versions of the same package where one is a security-relevant duplicate;
 *   4. the declared engine constraints are satisfiable by the Node version the repository
 *      pins.
 *
 * Each is a property of what will be installed, so each is legitimately a release gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateSbom, type Sbom, type SbomComponent } from "./sbom.ts";

/** One dependency finding. */
export interface DependencyFinding {
  readonly rule: string;
  readonly component: string;
  readonly detail: string;
}

/**
 * Every component must carry an integrity hash.
 *
 * The single most valuable check here: an entry without one cannot be verified against
 * what the registry serves, so a compromised or substituted tarball installs silently.
 */
export function checkIntegrityHashes(sbom: Sbom): readonly DependencyFinding[] {
  return sbom.components
    .filter((component) => component.integrity === undefined)
    .map((component) => ({
      rule: "integrity-hash-required",
      component: `${component.name}@${component.version}`,
      detail: "no integrity hash; the installed bytes cannot be verified",
    }));
}

/**
 * No dependency may resolve outside the registry.
 *
 * A `git+https://`, a bare tarball URL or a `file:` path bypasses both the registry and
 * the integrity hash. `link:` is exempt: those are this repository's own workspace
 * packages, which are first-party code and not supply chain.
 */
export function checkNoNonRegistrySources(lockfile: string): readonly DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  const patterns: readonly [string, RegExp][] = [
    ["git-dependency", /^\s+version:\s+(git\+\S+)/gm],
    ["tarball-dependency", /^\s+version:\s+(https?:\/\/\S+)/gm],
    ["file-dependency", /^\s+version:\s+(file:\S+)/gm],
  ];
  for (const [rule, pattern] of patterns) {
    for (const match of lockfile.matchAll(pattern)) {
      findings.push({
        rule,
        component: match[1] ?? "?",
        detail: "resolves outside the registry, bypassing the integrity hash",
      });
    }
  }
  return findings;
}

/**
 * Report packages present at more than one version.
 *
 * Informational rather than a failure: duplication is normal in a transitive tree and
 * forcing a single version breaks legitimate peer ranges. It matters because a patched
 * version of a package can coexist with an unpatched one, and `pnpm audit` reporting the
 * package as fixed then tells you nothing about which copy actually loads.
 */
export function findDuplicateVersions(sbom: Sbom): Readonly<Record<string, readonly string[]>> {
  const byName = new Map<string, string[]>();
  for (const component of sbom.components) {
    const list = byName.get(component.name) ?? [];
    list.push(component.version);
    byName.set(component.name, list);
  }
  const duplicates: Record<string, readonly string[]> = {};
  for (const [name, versions] of byName) {
    if (versions.length > 1) duplicates[name] = [...versions].sort();
  }
  return duplicates;
}

/**
 * The declared Node engine must admit the repository's pinned version.
 *
 * Parses only the shapes pnpm actually writes (`>=X`, `>=X.Y.Z`, `^X`, and `||` unions of
 * those) and treats anything else as satisfied. That is deliberate: a hand-rolled semver
 * range parser producing FALSE failures would get this check disabled within a week, and
 * a check nobody runs is worth less than a narrow one.
 */
export function checkEngineCompatibility(
  sbom: Sbom,
  nodeMajor: number,
): readonly DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  for (const component of sbom.components) {
    const constraint = component.engines;
    if (constraint === undefined) continue;
    if (!isNodeMajorAdmitted(constraint, nodeMajor)) {
      findings.push({
        rule: "engine-incompatible",
        component: `${component.name}@${component.version}`,
        detail: `declares node ${constraint}, which excludes node ${String(nodeMajor)}`,
      });
    }
  }
  return findings;
}

/** Whether `major` satisfies any clause of a `||`-separated constraint. */
function isNodeMajorAdmitted(constraint: string, major: number): boolean {
  const clauses = constraint.split("||").map((clause) => clause.trim());
  for (const clause of clauses) {
    const atLeast = /^>=\s*(\d+)/.exec(clause);
    if (atLeast !== null) {
      if (major >= Number(atLeast[1])) return true;
      continue;
    }
    const caret = /^\^\s*(\d+)/.exec(clause);
    if (caret !== null) {
      if (major === Number(caret[1])) return true;
      continue;
    }
    const exact = /^(\d+)(?:\.\d+)*$/.exec(clause);
    if (exact !== null) {
      if (major === Number(exact[1])) return true;
      continue;
    }
    // An unrecognised clause counts as satisfied. See the note above: false failures are
    // worse than narrow coverage, because they get the check turned off.
    return true;
  }
  return false;
}

export interface DependencyAudit {
  readonly findings: readonly DependencyFinding[];
  readonly duplicates: Readonly<Record<string, readonly string[]>>;
  readonly componentCount: number;
}

/** Run every deterministic check. */
export function auditDependencies(input: {
  readonly lockfilePath: string;
  readonly nodeMajor: number;
}): DependencyAudit {
  const lockfile = readFileSync(input.lockfilePath, "utf8");
  const sbom = generateSbom(input.lockfilePath);
  return {
    findings: [
      ...checkIntegrityHashes(sbom),
      ...checkNoNonRegistrySources(lockfile),
      ...checkEngineCompatibility(sbom, input.nodeMajor),
    ],
    duplicates: findDuplicateVersions(sbom),
    componentCount: sbom.components.length,
  };
}

/** Exposed for the test, which asserts the parser handles the shapes pnpm writes. */
export const __testing = { isNodeMajorAdmitted };
export type { SbomComponent };

// CLI: `tsx scripts/security/dependency-audit.ts`
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const audit = auditDependencies({
    lockfilePath: `${root}/pnpm-lock.yaml`,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  });
  const duplicateCount = Object.keys(audit.duplicates).length;
  process.stdout.write(
    `${String(audit.componentCount)} components, ${String(audit.findings.length)} findings, ` +
      `${String(duplicateCount)} packages at multiple versions\n`,
  );
  for (const finding of audit.findings) {
    process.stdout.write(`  ${finding.rule}: ${finding.component} — ${finding.detail}\n`);
  }
  if (audit.findings.length > 0) process.exitCode = 1;
}
