import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { Provider } from "@remoteagent/contracts";
import { TRUST_BOUNDARIES, ThreatClass, providerBoundaries } from "@remoteagent/observability";
import { describe, expect, it } from "vitest";

/**
 * AC1: "the threat model covers every external boundary and data flow."
 *
 * A threat model that lives only in prose drifts the moment a provider is added,
 * and nothing fails. That is the `CTF-010` pattern — a document describing a
 * guarantee the code does not give — applied to security documentation. So the
 * document is checked against the code here, in both directions:
 *
 *   - every `Provider` in the contracts must have a boundary entry;
 *   - every boundary entry must appear in `THREAT_MODEL.md`;
 *   - every control a boundary names must be a file that actually exists.
 *
 * The third check is the one that matters most. A registry listing
 * `packages/connector-gitlab/src/allowlist.ts` as its control reads exactly as
 * authoritative as one listing a real path — and while writing this registry, four
 * of the cited paths were wrong. Without this test the threat model would have
 * shipped naming controls that do not exist at the locations claimed.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const DOCUMENT = join(REPO_ROOT, "docs", "security", "THREAT_MODEL.md");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const document = await readFile(DOCUMENT, "utf8");

describe("threat model completeness (AC1)", () => {
  it("has a boundary entry for every provider in the contracts", () => {
    const registered = new Set(providerBoundaries().map((boundary) => boundary.provider));
    const missing = Object.values(Provider).filter((provider) => !registered.has(provider));
    // Named in the failure rather than counted, so adding a sixth provider tells the
    // author which one is undescribed instead of "expected 5 to be 6".
    expect(missing).toEqual([]);
  });

  it("registers no boundary for a provider that does not exist", () => {
    const known = new Set<string>(Object.values(Provider));
    const bogus = providerBoundaries()
      .map((boundary) => boundary.provider)
      .filter((provider) => provider !== null && !known.has(provider));
    expect(bogus).toEqual([]);
  });

  it("covers the non-provider boundaries AC1 names explicitly", () => {
    // AC1's list is Jira, GitLab, both Gmails, both Calendars, Discord, Bedrock,
    // MCP/Gateway, the workspace filesystem, PostgreSQL and artifacts. The five
    // providers are checked above; these are the rest, plus secret storage, which
    // holds the credential material every other boundary depends on.
    const ids = new Set(TRUST_BOUNDARIES.map((boundary) => boundary.id));
    for (const required of ["bedrock", "mcp", "workspace", "postgres", "artifacts", "secrets"]) {
      expect(ids).toContain(required);
    }
  });

  it("gives every boundary at least one threat and one control", () => {
    // "Reviewed and found fine" is the shape of assurance this repository has
    // repeatedly punished, so an empty control list is rejected outright rather
    // than read as "nothing needed".
    for (const boundary of TRUST_BOUNDARIES) {
      expect(boundary.threats.length, `${boundary.id} has no threats`).toBeGreaterThan(0);
      expect(boundary.controls.length, `${boundary.id} has no controls`).toBeGreaterThan(0);
    }
  });

  it("names only threat classes from the closed vocabulary", () => {
    const known = new Set<string>(Object.values(ThreatClass));
    for (const boundary of TRUST_BOUNDARIES) {
      for (const threat of boundary.threats) {
        expect(known, `${boundary.id} names unknown threat ${threat}`).toContain(threat);
      }
    }
  });

  it("has unique boundary ids", () => {
    const ids = TRUST_BOUNDARIES.map((boundary) => boundary.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names a control file that actually exists, for every control", async () => {
    // The check that caught four wrong paths in this very registry. A control cited
    // at a path that does not exist is worse than an uncited one: it reads as
    // reviewed.
    const broken: string[] = [];
    for (const boundary of TRUST_BOUNDARIES) {
      for (const control of boundary.controls) {
        const path = control.split(" ")[0]!;
        if (!(await exists(join(REPO_ROOT, path)))) {
          broken.push(`${boundary.id}: ${path}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("describes every registered boundary in THREAT_MODEL.md", () => {
    const undocumented = TRUST_BOUNDARIES.filter(
      (boundary) => !document.includes(`<a id="tb-${boundary.id}"></a>`),
    ).map((boundary) => boundary.id);
    expect(undocumented).toEqual([]);
  });

  it("documents every threat class, so the vocabulary is not aspirational", () => {
    const undocumented = Object.values(ThreatClass).filter(
      (threat) => !document.includes(threat),
    );
    expect(undocumented).toEqual([]);
  });

  it("states the ADR-0007 verification rule rather than only listing risks", () => {
    // A threat model is only useful if it says how each control is proven. This
    // pins the section that maps boundaries to the suites that exercise them.
    expect(document).toContain("test/security/");
  });
});
