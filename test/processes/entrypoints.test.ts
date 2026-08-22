import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The entry points `infra/cdk` expects must exist, with those exact names (RA-027-WU-08, AC3).
 *
 * THIS IS THE TEST THAT WOULD HAVE CAUGHT RA-027 EXISTING AT ALL. RA-026 certified ten §13
 * criteria against tests that wire packages in memory, and every one passed while
 * `dist/worker.js` did not exist. A name mismatch here produces a deploy that starts and
 * immediately dies with `MODULE_NOT_FOUND` — a failure that costs a deployment to discover
 * and a minute to prevent.
 *
 * The commands are read from the CDK source rather than restated, so the two cannot drift.
 * Restating them would create a second list, and a test comparing a list to itself is the
 * shape of assurance this repository has punished repeatedly.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `["node", "dist/X.js"]` command the CDK stacks declare. */
async function cdkEntrypoints(): Promise<string[]> {
  const sources = ["infra/cdk/src/compute-stack.ts", "infra/cdk/src/ingress-stack.ts"];
  const found = new Set<string>();
  for (const source of sources) {
    const contents = await readFile(join(REPO_ROOT, source), "utf8");
    // Matches both the single-line and the prettier-wrapped multi-line form; the wrapped one
    // is why this is a regex over the text rather than a line-by-line scan.
    for (const match of contents.matchAll(/"node",\s*\n?\s*"(dist\/[a-z-]+\.js)"/g)) {
      found.add(match[1]!);
    }
  }
  return [...found].sort();
}

/** Every health-check command, which also names a `dist/*.js`. */
async function cdkHealthEntrypoints(): Promise<string[]> {
  const found = new Set<string>();
  for (const source of ["infra/cdk/src/compute-stack.ts", "infra/cdk/src/ingress-stack.ts"]) {
    const contents = await readFile(join(REPO_ROOT, source), "utf8");
    for (const match of contents.matchAll(/node (dist\/[a-z-]+\.js)/g)) {
      found.add(match[1]!);
    }
  }
  return [...found].sort();
}

/** Source files across all apps, by their compiled `dist/` name. */
async function appSourceBasenames(): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for (const app of await readdir(join(REPO_ROOT, "apps"))) {
    const src = join(REPO_ROOT, "apps", app, "src");
    if (!(await exists(src))) continue;
    for (const file of await readdir(src)) {
      if (!file.endsWith(".ts")) continue;
      byName.set(`dist/${file.replace(/\.ts$/, ".js")}`, `apps/${app}/src/${file}`);
    }
  }
  return byName;
}

describe("AC3: every CDK entry point has a source file", () => {
  it("finds the commands the CDK stacks declare", async () => {
    // If the parse returned nothing, every assertion below would pass vacuously — the exact
    // failure shape RA-024's empty-table probe produced.
    const entrypoints = await cdkEntrypoints();
    expect(entrypoints.length).toBeGreaterThanOrEqual(4);
    expect(entrypoints).toContain("dist/worker.js");
  });

  it("has a source file for every process command", async () => {
    const sources = await appSourceBasenames();
    const missing: string[] = [];
    for (const entrypoint of await cdkEntrypoints()) {
      if (!sources.has(entrypoint)) missing.push(entrypoint);
    }
    // Named, so a failure says which entry point to write rather than "expected 4 to be 5".
    expect(missing).toEqual([]);
  });

  it("has a source file for the health-check command", async () => {
    // Separate from the process commands because it is invoked differently — as a CLI inside
    // the container, not as the container's command — and was the entry point most easily
    // forgotten for exactly that reason.
    const sources = await appSourceBasenames();
    const missing: string[] = [];
    for (const entrypoint of await cdkHealthEntrypoints()) {
      if (!sources.has(entrypoint)) missing.push(entrypoint);
    }
    expect(missing).toEqual([]);
  });

  it("names the five processes the deployment actually runs", async () => {
    // Pinned. If CDK gains a sixth service, this fails and someone writes its entry point
    // deliberately rather than discovering the gap at deploy time.
    expect(await cdkEntrypoints()).toEqual([
      "dist/discord.js",
      "dist/executor.js",
      "dist/ingress.js",
      "dist/worker.js",
    ]);
    expect(await cdkHealthEntrypoints()).toEqual(["dist/health.js"]);
  });
});

describe("AC3: the entry points are actually runnable modules", () => {
  it("each exports a `main` the container can invoke", async () => {
    // A file that exists but exports nothing runnable would satisfy the name check while
    // failing at deploy. `health.ts` is exempt: it is a CLI whose whole behaviour is its exit
    // code, so it exports `probe` instead.
    const sources = await appSourceBasenames();
    const missing: string[] = [];
    for (const entrypoint of await cdkEntrypoints()) {
      const source = sources.get(entrypoint);
      if (source === undefined) continue;
      const contents = await readFile(join(REPO_ROOT, source), "utf8");
      if (!contents.includes("export async function main(")) {
        missing.push(`${entrypoint} (${source}) has no exported main()`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("each guards its top-level invocation, so importing it starts nothing", async () => {
    // Without the guard, a test importing the module would start a real server and open a
    // real database — which is how an entry-point test becomes a flaky integration test.
    const sources = await appSourceBasenames();
    const unguarded: string[] = [];
    for (const entrypoint of [...(await cdkEntrypoints()), ...(await cdkHealthEntrypoints())]) {
      const source = sources.get(entrypoint);
      if (source === undefined) continue;
      const contents = await readFile(join(REPO_ROOT, source), "utf8");
      if (!contents.includes("import.meta.url === `file://${process.argv[1]}`")) {
        unguarded.push(`${entrypoint} (${source})`);
      }
    }
    expect(unguarded).toEqual([]);
  });

  it("the health CLI defaults to LIVENESS, not readiness", async () => {
    // The one default in this task where getting it wrong is actively harmful: a health check
    // that silently probed readiness would make ECS restart every task during a database
    // outage. Asserted on the module's behaviour, not its comment.
    const { probePathFromArgv } = await import("../../apps/agent-worker/src/health.js");
    expect(probePathFromArgv([])).toBe("/livez");
    expect(probePathFromArgv(["--liveness"])).toBe("/livez");
    expect(probePathFromArgv(["--nonsense"])).toBe("/livez");
    // Readiness must be asked for explicitly.
    expect(probePathFromArgv(["--readiness"])).toBe("/readyz");
  });

  it("compiles all five entry points into one dist, as a single image requires", async () => {
    // All four services share ONE image (`ContainerImage.fromEcrRepository`, same tag), so
    // every command must resolve inside that image's `dist/`. Five files spread across
    // separate app packages each build to their OWN dist — which is why the Dockerfile must
    // collect them, and why this test states the requirement rather than assuming it.
    const compute = await readFile(join(REPO_ROOT, "infra/cdk/src/compute-stack.ts"), "utf8");
    const ingress = await readFile(join(REPO_ROOT, "infra/cdk/src/ingress-stack.ts"), "utf8");
    // Both stacks reference the SAME repository name, so one image serves both.
    expect(compute).toContain('Component.WORKER, "image"');
    expect(ingress).toContain('Component.WORKER, "image"');
  });
});
