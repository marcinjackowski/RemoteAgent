import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  __testing,
  auditDependencies,
  checkEngineCompatibility,
  checkIntegrityHashes,
  checkNoNonRegistrySources,
  findDuplicateVersions,
} from "../../scripts/security/dependency-audit.ts";
import { generateSbom } from "../../scripts/security/sbom.ts";

/**
 * Deterministic dependency checks (RA-025-WU-10).
 *
 * Every check here is decidable from the lockfile with no network, which is what makes it
 * a legitimate release gate. `pnpm audit` is deliberately NOT one of them: it needs the
 * network and answers differently each day, so it belongs in a scheduled job whose failure
 * is a ticket rather than a blocked release. Recorded in the runbook as a limitation.
 */
const LOCKFILE = join(import.meta.dirname, "..", "..", "pnpm-lock.yaml");
const NODE_MAJOR = 24;

describe("this repository's actual dependency tree", () => {
  const audit = auditDependencies({ lockfilePath: LOCKFILE, nodeMajor: NODE_MAJOR });

  it("has zero findings", () => {
    // Listed rather than counted, so a failure names what to fix.
    expect(
      audit.findings.map((finding) => `${finding.rule}: ${finding.component} — ${finding.detail}`),
    ).toEqual([]);
  });

  it("has an integrity hash on every third-party component", () => {
    // The most valuable property: without one, an entry records which version was
    // requested, not which bytes arrived.
    expect(checkIntegrityHashes(generateSbom(LOCKFILE))).toEqual([]);
  });

  it("resolves every dependency through the registry", () => {
    // A git URL, a bare tarball or a `file:` path bypasses the registry AND the integrity
    // hash together.
    expect(checkNoNonRegistrySources(readFileSync(LOCKFILE, "utf8"))).toEqual([]);
  });

  it("reports duplicate versions without failing on them", () => {
    // Informational: duplication is normal in a transitive tree, and forcing a single
    // version breaks legitimate peer ranges. It matters because a patched copy can coexist
    // with an unpatched one, so "the package is fixed" says nothing about which loads.
    const duplicates = findDuplicateVersions(generateSbom(LOCKFILE));
    for (const versions of Object.values(duplicates)) {
      expect(versions.length).toBeGreaterThan(1);
      // Sorted, so the report is diffable between runs.
      expect(versions).toEqual([...versions].sort());
    }
  });
});

describe("the checks detect what they claim to", () => {
  /**
   * Negative cases, for the reason the RA-025 mutation run made unavoidable: three policy
   * checks in this task initially had only "the real tree is clean" assertions, and
   * mutations gutting the checkers stayed green. A check that never fires is
   * indistinguishable from a passing system.
   */
  it("checkIntegrityHashes fires on a component with no hash", () => {
    const findings = checkIntegrityHashes({
      components: [{ name: "sketchy", version: "1.0.0" }],
      workspace: [],
      lockfileVersion: "9.0",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("integrity-hash-required");
  });

  it.each([
    ["git-dependency", "    version: git+https://github.com/x/y.git#abc"],
    ["tarball-dependency", "    version: https://example.test/pkg.tgz"],
    ["file-dependency", "    version: file:../vendored"],
  ])("checkNoNonRegistrySources fires on %s", (rule, line) => {
    const findings = checkNoNonRegistrySources(`lockfileVersion: '9.0'\n${line}\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe(rule);
  });

  it("checkNoNonRegistrySources allows a workspace `link:`", () => {
    // First-party code, not supply chain. Flagging it would make the check unusable in a
    // monorepo, which is how a check gets disabled.
    expect(
      checkNoNonRegistrySources("lockfileVersion: '9.0'\n    version: link:packages/contracts\n"),
    ).toEqual([]);
  });

  it("checkEngineCompatibility fires on an excluded major", () => {
    const findings = checkEngineCompatibility(
      {
        components: [{ name: "old", version: "1.0.0", integrity: "sha512-x", engines: ">=99.0.0" }],
        workspace: [],
        lockfileVersion: "9.0",
      },
      NODE_MAJOR,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain("excludes node 24");
  });

  it("findDuplicateVersions fires on a genuine duplicate and not on a single version", () => {
    const duplicates = findDuplicateVersions({
      components: [
        { name: "dup", version: "1.0.0", integrity: "sha512-a" },
        { name: "dup", version: "2.0.0", integrity: "sha512-b" },
        { name: "single", version: "1.0.0", integrity: "sha512-c" },
      ],
      workspace: [],
      lockfileVersion: "9.0",
    });
    expect(Object.keys(duplicates)).toEqual(["dup"]);
    expect(duplicates["dup"]).toEqual(["1.0.0", "2.0.0"]);
  });
});

describe("the engine range parser handles the shapes pnpm writes", () => {
  it.each([
    [">=20.0.0", 24, true],
    [">=20", 24, true],
    [">=26", 24, false],
    ["^24", 24, true],
    ["^22", 24, false],
    ["^12.22.0 || ^14.17.0 || >=16.0.0", 24, true],
    ["^20.19.0 || ^22.13.0 || >=24", 24, true],
    ["^20.19.0 || ^22.13.0", 24, false],
    ["24", 24, true],
    ["22", 24, false],
  ])("%s admits node %i -> %s", (constraint, major, expected) => {
    expect(__testing.isNodeMajorAdmitted(constraint, major)).toBe(expected);
  });

  it("treats an unrecognised range as satisfied rather than failing", () => {
    // Deliberate. A hand-rolled semver parser producing FALSE failures would get this
    // check disabled within a week, and a check nobody runs is worth less than a narrow
    // one. Asserted so the choice is visible rather than looking like a parser bug.
    expect(__testing.isNodeMajorAdmitted(">=18 <21", 24)).toBe(true);
    expect(__testing.isNodeMajorAdmitted("weird-range", 24)).toBe(true);
  });
});
