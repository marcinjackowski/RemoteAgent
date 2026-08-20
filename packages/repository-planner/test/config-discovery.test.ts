import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspacePathPolicy } from "@remoteagent/workspace-runner";
import { discoverAllowedConfig } from "../src/config-discovery.js";
import { createPlannerReadPort } from "../src/read-tools.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server-owned config discovery", () => {
  it("reads only the fixed allowlist and never executes config content", async () => {
    const root = await mkdtemp(join(tmpdir(), "repository-planner-config-"));
    roots.push(root);
    await mkdir(join(root, ".github"), { recursive: true });
    await mkdir(join(root, ".github", "workflows"));
    await writeFile(join(root, "README.md"), "CI: run ./script.sh\n");
    await writeFile(join(root, "package.json"), '{"scripts":{"test":"./script.sh"}}\n');
    await writeFile(join(root, ".gitlab-ci.yml"), "run: ./gitlab.sh\n");
    await writeFile(join(root, ".github", "workflows", "build.yaml"), "run: ./build.sh\n");
    await writeFile(join(root, ".github", "workflows", "ci.yml"), "run: ./ci.sh\n");
    await writeFile(join(root, ".github", "workflows", "script.sh"), "echo not config\n");
    const port = await createPlannerReadPort((await createWorkspacePathPolicy(root)).root);
    const result = await discoverAllowedConfig(port);
    expect(result.entries.map((entry) => entry.provenance.relative_path)).toEqual([
      "README.md",
      "package.json",
      ".gitlab-ci.yml",
      ".github/workflows/build.yaml",
      ".github/workflows/ci.yml",
    ]);
    expect(result.entries.every((entry) => entry.content.trust === "UNTRUSTED_DATA")).toBe(true);
    await expect(port.config({ relative_path: "src/app.ts" })).rejects.toMatchObject({
      code: "FILE_NOT_ALLOWED",
    });
    await expect(
      port.config({ relative_path: ".github/workflows/script.sh" }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_ALLOWED",
    });
    await expect(port.config({ relative_path: "../.gitlab-ci.yml" } as never)).rejects.toThrow();
    expect(port.manifest.can_execute_commands).toBe(false);
  });
});
