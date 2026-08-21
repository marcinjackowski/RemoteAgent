import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  generateSbom,
  packageUrl,
  parseLockfile,
  toCycloneDx,
} from "../../scripts/security/sbom.ts";

/**
 * SBOM generation (RA-024-WU-10).
 *
 * The property that matters is COMPLETENESS: an SBOM that silently under-reports
 * passes every downstream scanner while describing something other than what ships.
 * So the parser fails loudly on anything it does not recognise, and this suite checks
 * that it does — a parser that skips unknown lines is indistinguishable from a
 * correct one until the day it matters.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LOCKFILE = join(REPO_ROOT, "pnpm-lock.yaml");

describe("SBOM completeness", () => {
  const sbom = generateSbom(LOCKFILE);

  it("finds every entry in the lockfile's packages section", () => {
    // Counted independently of the parser, from the raw text, so the assertion is not
    // "the parser agrees with itself". `snapshots:` repeats every package with the
    // same shape, so the range matters: counting the whole file would double it.
    const lines = readFileSync(LOCKFILE, "utf8").split("\n");
    const packagesStart = lines.indexOf("packages:");
    const snapshotsStart = lines.indexOf("snapshots:");
    expect(packagesStart).toBeGreaterThan(-1);
    expect(snapshotsStart).toBeGreaterThan(packagesStart);
    const expected = lines
      .slice(packagesStart + 1, snapshotsStart)
      .filter((line) => /^ {2}[^ ].*@.*:( \{\})?$/.test(line)).length;
    expect(sbom.components).toHaveLength(expected);
  });

  it("does not double-count the snapshots section", () => {
    // `snapshots:` lists the same packages again. A parser that ran past the section
    // boundary would report ~2× the real count, which looks like thoroughness.
    const names = sbom.components.map((component) => `${component.name}@${component.version}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("records every workspace package", () => {
    // 19 packages + apps + infra. Asserted as a floor plus a name check rather than an
    // exact number, so adding a package does not fail this test for the wrong reason.
    expect(sbom.workspace.length).toBeGreaterThanOrEqual(19);
    const paths = sbom.workspace.map((entry) => entry.path);
    for (const required of [
      "packages/contracts",
      "packages/database",
      "packages/policy",
      "packages/observability",
    ]) {
      expect(paths).toContain(required);
    }
  });

  it("separates first-party workspace packages from the supply chain", () => {
    // A workspace package is not a third-party dependency, and counting it as one
    // would inflate the supply chain while hiding that it is code we wrote.
    for (const component of sbom.components) {
      expect(component.name.startsWith("@remoteagent/")).toBe(false);
    }
  });

  it("captures an integrity hash for every third-party component", () => {
    // The whole supply-chain value of an SBOM: without a hash, a component entry says
    // a version was requested, not which bytes arrived.
    const missing = sbom.components
      .filter((component) => component.integrity === undefined)
      .map((component) => component.name);
    expect(missing).toEqual([]);
  });

  it("captures the declared node engine where a package states one", () => {
    expect(sbom.components.some((component) => component.engines !== undefined)).toBe(true);
  });

  it("parses scoped and unscoped names correctly", () => {
    const scoped = sbom.components.find((component) => component.name === "@opentelemetry/api");
    expect(scoped).toBeDefined();
    expect(scoped!.version).toMatch(/^\d+\.\d+\.\d+/);
    const unscoped = sbom.components.find((component) => component.name === "zod");
    expect(unscoped).toBeDefined();
    // A parser splitting on the FIRST `@` would produce name `""` for a scoped
    // package and a version containing a slash.
    expect(scoped!.version).not.toContain("/");
  });

  it("records the lockfile version", () => {
    expect(sbom.lockfileVersion).toMatch(/^\d+\.\d+$/);
  });
});

describe("SBOM parser fails loudly rather than under-reporting", () => {
  it("refuses a lockfile with no packages section", () => {
    expect(() => parseLockfile("lockfileVersion: '9.0'\n\nimporters:\n")).toThrow(
      /no `packages:` section/,
    );
  });

  it("refuses to emit an empty SBOM", () => {
    // An SBOM claiming zero dependencies passes every downstream check while
    // describing nothing, which is worse than no SBOM at all.
    expect(() => parseLockfile("lockfileVersion: '9.0'\n\npackages:\n\nsnapshots:\n")).toThrow(
      /zero components/,
    );
  });

  it("throws on an entry with no version separator", () => {
    expect(() =>
      parseLockfile(
        "lockfileVersion: '9.0'\n\npackages:\n\n  'no-version-here':\n    resolution: {integrity: sha512-x}\n",
      ),
    ).toThrow(/unparseable/);
  });

  it("parses both the `{}` and the nested-children entry forms", () => {
    // Both occur in a real pnpm v9 lockfile. The first version of this parser handled
    // only the nested form and then threw on `peerDependencies` — loudly, which is how
    // the bug was found in one run instead of producing a short SBOM.
    const parsed = parseLockfile(
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  '@scope/with-children@1.2.3':",
        "    resolution: {integrity: sha512-aaa}",
        "    engines: {node: '>=20.0.0'}",
        "    peerDependencies:",
        "      eslint: ^9.0.0",
        "",
        "  'plain-empty@4.5.6': {}",
        "",
        "  'plain-with-hash@7.8.9':",
        "    resolution: {integrity: sha512-bbb}",
        "",
      ].join("\n"),
    );
    expect(parsed.components).toEqual([
      {
        name: "@scope/with-children",
        version: "1.2.3",
        integrity: "sha512-aaa",
        engines: ">=20.0.0",
      },
      { name: "plain-empty", version: "4.5.6" },
      { name: "plain-with-hash", version: "7.8.9", integrity: "sha512-bbb" },
    ]);
  });

  it("does not treat a nested key as a component", () => {
    // The bug that broke the first version: `peerDependencies` is four-space indented
    // and has no `@`, so a two-space prefix match without the lookahead swallowed it.
    const parsed = parseLockfile(
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  'a@1.0.0':",
        "    resolution: {integrity: sha512-aaa}",
        "    peerDependencies:",
        "      b: ^2.0.0",
        "    os: [win32]",
        "",
      ].join("\n"),
    );
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0]!.name).toBe("a");
  });
});

describe("CycloneDX output", () => {
  const sbom = generateSbom(LOCKFILE);
  const metadata = {
    serialNumber: "urn:uuid:11111111-1111-1111-1111-111111111111",
    timestamp: "2026-08-21T00:00:00.000Z",
    component: "remoteagent",
  };

  it("is valid JSON with the expected CycloneDX shape", () => {
    const parsed = JSON.parse(toCycloneDx(sbom, metadata)) as {
      bomFormat: string;
      specVersion: string;
      components: { name: string; version: string; purl: string }[];
    };
    expect(parsed.bomFormat).toBe("CycloneDX");
    expect(parsed.specVersion).toBe("1.5");
    expect(parsed.components).toHaveLength(sbom.components.length);
  });

  it("is byte-identical for the same lockfile and metadata", () => {
    // A diffable SBOM is how a reviewer sees that a release added one dependency
    // rather than three hundred. Non-determinism destroys that, which is why the
    // serial and timestamp are inputs rather than generated here.
    expect(toCycloneDx(sbom, metadata)).toBe(toCycloneDx(sbom, metadata));
  });

  it("sorts components, so ordering is not install-dependent", () => {
    const parsed = JSON.parse(toCycloneDx(sbom, metadata)) as {
      components: { name: string; version: string }[];
    };
    const keys = parsed.components.map((component) => `${component.name}@${component.version}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it("encodes a scoped purl the way the spec requires", () => {
    // A scanner that cannot parse the purl cannot match the component against an
    // advisory, which silently turns the SBOM into decoration.
    expect(packageUrl({ name: "@opentelemetry/api", version: "1.9.1" })).toBe(
      "pkg:npm/%40opentelemetry/api@1.9.1",
    );
    expect(packageUrl({ name: "zod", version: "4.4.3" })).toBe("pkg:npm/zod@4.4.3");
  });

  it("names the hash algorithm rather than emitting a bare SRI string", () => {
    const parsed = JSON.parse(toCycloneDx(sbom, metadata)) as {
      components: { hashes?: { alg: string; content: string }[] }[];
    };
    const withHashes = parsed.components.filter((component) => component.hashes !== undefined);
    expect(withHashes.length).toBeGreaterThan(0);
    for (const component of withHashes) {
      expect(["SHA-512", "SHA-256"]).toContain(component.hashes![0]!.alg);
      expect(component.hashes![0]!.content).not.toMatch(/^sha\d+-/);
    }
  });
});
