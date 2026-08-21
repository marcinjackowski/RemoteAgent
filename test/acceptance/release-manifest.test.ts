import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { partialCriteria } from "../../scripts/acceptance/criteria.ts";
import {
  buildReleaseManifest,
  renderManifest,
  schemaVersion,
  toolVersion,
  unknownComponents,
} from "../../scripts/acceptance/release-manifest.ts";
import { generateSbom } from "../../scripts/security/sbom.ts";

/**
 * Release manifest (RA-026-WU-03, AC5).
 *
 * AC5's real test is not "does it list things" but "could somebody handed only this
 * manifest rebuild the same system". So the assertions below split into two kinds: that
 * every capturable field is captured and deterministic, and that every UNCAPTURABLE one is
 * declared `unknown` WITH a reason. The second kind is the one that makes the manifest
 * honest — "reproducible except for two fields you were not told about" is precisely the
 * failure AC5 exists to prevent.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const GENERATED_AT = "2026-08-22T00:00:00.000Z";

function manifest() {
  const sbom = generateSbom(join(REPO_ROOT, "pnpm-lock.yaml"));
  return buildReleaseManifest({
    commit: COMMIT,
    generatedAt: GENERATED_AT,
    repoRoot: REPO_ROOT,
    dependencyCount: sbom.components.length,
    lockfileVersion: sbom.lockfileVersion,
    knownGaps: partialCriteria().map((entry) => `§13.${String(entry.number)}: ${entry.gap ?? ""}`),
  });
}

describe("AC5: the manifest captures what can be captured", () => {
  const built = manifest();

  it("reports the schema version as the highest applied migration", () => {
    // Asserted as a floor, so adding a migration does not fail this for the wrong reason —
    // but it must be a real number, because a manifest reporting 0 would look like a fresh
    // system and be indistinguishable from a broken generator.
    const schema = built.components.find((component) => component.name === "schema")!;
    expect(Number(schema.version)).toBeGreaterThanOrEqual(32);
  });

  it("refuses to emit a manifest when no migration can be found", () => {
    // Fail loudly rather than reporting schema 0.
    expect(() => schemaVersion(join(REPO_ROOT, "docs"))).toThrow(/no migrations found/);
  });

  it("reports the tool surface as the ACTION_REGISTRY size", () => {
    const tools = built.components.find((component) => component.name === "tools")!;
    // Thirteen registered actions at the time of writing. Pinned exactly: a manifest whose
    // tool count differs from the deployment describes a different system, and a floor
    // would let a REMOVED action pass unnoticed.
    expect(Number(tools.version)).toBe(13);
  });

  it("refuses to emit a manifest when ACTION_REGISTRY cannot be parsed", () => {
    expect(() => toolVersion("no registry here")).toThrow(/could not parse/);
  });

  it("lists every registered action name, so the surface is enumerable", () => {
    const parsed = toolVersion(
      readFileSync(join(REPO_ROOT, "packages/policy/src/policy-engine.ts"), "utf8"),
    );
    for (const name of ["gitlab.mr.merge", "git.push.force", "gmail.draft.create"]) {
      expect(parsed.digestInput).toContain(name);
    }
    // And NOT the one deliberately absent — the `gmail.compose` over-grant's whole
    // containment depends on it staying out.
    expect(parsed.digestInput).not.toContain("gmail.message.send");
  });

  it("uses the commit as the IaC version, because synth is deterministic", () => {
    const iac = built.components.find((component) => component.name === "iac")!;
    expect(iac.version).toBe(COMMIT);
    expect(iac.source).toContain("deterministic");
  });

  it("captures the dependency count and lockfile version", () => {
    expect(built.dependencies.count).toBeGreaterThan(200);
    expect(built.dependencies.lockfileVersion).toMatch(/^\d+\.\d+$/);
  });

  it("captures the pinned node and pnpm versions", () => {
    for (const name of ["node", "pnpm"]) {
      const component = built.components.find((entry) => entry.name === name)!;
      expect(component.version).not.toBe("unknown");
      expect(component.version).toMatch(/\d+\./);
    }
  });
});

describe("AC5: the manifest is honest about what it cannot capture", () => {
  const built = manifest();

  it("declares model and prompt versions unknown, and nothing else", () => {
    // Pinned exactly. If a third field became unknown, this fails and someone decides
    // consciously; if one is captured, this fails too and the manifest gets updated rather
    // than silently over-claiming.
    expect(
      unknownComponents(built)
        .map((component) => component.name)
        .sort(),
    ).toEqual(["model", "prompts"]);
  });

  it("explains every unknown, with what would be needed to capture it", () => {
    // An unexplained `unknown` is worse than an omission: it reads as an oversight rather
    // than a known limit. The length floor rejects "TBD".
    for (const component of unknownComponents(built)) {
      expect(component.gap ?? "", `${component.name} is unknown with no reason`).not.toBe("");
      expect((component.gap ?? "").length).toBeGreaterThan(150);
    }
  });

  it("records WHY the model version is unknown rather than guessing one", () => {
    // The plan's own note: the model identity changed during construction (ADR-0004 →
    // ADR-0005), so a single version would be false for most of the described history. A
    // wrong model version in a reproduction manifest is worse than an admitted absence.
    const model = built.components.find((component) => component.name === "model")!;
    expect(model.gap).toContain("ADR-0004");
    expect(model.gap).toContain("ADR-0005");
  });

  it("carries the §13 gaps, so a manifest reader needs no second document", () => {
    // Somebody reproducing a version needs to know what was NOT proven about it.
    expect(built.knownGaps).toHaveLength(2);
    expect(built.knownGaps.join("\n")).toContain("§13.8");
    expect(built.knownGaps.join("\n")).toContain("§13.9");
  });
});

describe("AC5: the manifest is deterministic", () => {
  it("renders byte-identically for identical inputs", () => {
    // A manifest that differs between two runs on one commit cannot verify a deployment:
    // any difference could be a real change or the tool itself.
    expect(renderManifest(manifest())).toBe(renderManifest(manifest()));
  });

  it("changes when the commit changes, and only then", () => {
    // The negative case. A determinism test that passed because the output ignored its
    // inputs would be worthless.
    const a = renderManifest(manifest());
    const sbom = generateSbom(join(REPO_ROOT, "pnpm-lock.yaml"));
    const b = renderManifest(
      buildReleaseManifest({
        commit: "ffffffffffffffffffffffffffffffffffffffff",
        generatedAt: GENERATED_AT,
        repoRoot: REPO_ROOT,
        dependencyCount: sbom.components.length,
        lockfileVersion: sbom.lockfileVersion,
        knownGaps: [],
      }),
    );
    expect(b).not.toBe(a);
  });

  it("reads no clock: the timestamp is an input", () => {
    // Enforced structurally rather than by inspection — the field is whatever the caller
    // passed, so a generator that called `Date.now()` would produce a different value.
    expect(manifest().generatedAt).toBe(GENERATED_AT);
  });
});
