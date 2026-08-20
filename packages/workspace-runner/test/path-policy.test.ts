import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspacePathPolicy,
  validateWorkspaceRoot,
  WorkspacePathPolicyError,
} from "../src/index.js";

const created: string[] = [];
afterEach(async () => {
  // Test cleanup is intentionally outside the policy under test.
  const { rm } = await import("node:fs/promises");
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "workspace-policy-parent-"));
  const root = join(parent, "workspace");
  await mkdir(root);
  created.push(parent);
  return root;
}

describe("workspace path policy", () => {
  it.each(["..", ".", "nested/../../escape", "workspace-sibling/file"])(
    "rejects traversal and prefix collisions: %s",
    async (candidate) => {
      const root = await workspace();
      const policy = await createWorkspacePathPolicy(root);
      await expect(policy.validateDestructiveTarget(candidate)).rejects.toBeInstanceOf(
        WorkspacePathPolicyError,
      );
    },
  );

  it("rejects broad roots and symlink escapes fail closed", async () => {
    await expect(validateWorkspaceRoot(tmpdir())).rejects.toMatchObject({
      code: "BROAD_WORKSPACE_ROOT",
    });
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "workspace-policy-outside-"));
    created.push(outside);
    await writeFile(join(outside, "secret"), "nope");
    await symlink(outside, join(root, "link"));
    const policy = await createWorkspacePathPolicy(root);
    await expect(policy.validateCommandCwd("link")).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
    });
  });

  it("rejects a protected parent while allowing its dedicated child", async () => {
    const parent = await mkdtemp(join(tmpdir(), "workspace-policy-protected-"));
    const root = join(parent, "workspace");
    await mkdir(root);
    created.push(parent);
    await expect(validateWorkspaceRoot(parent, { protectedRoots: [parent] })).rejects.toMatchObject(
      {
        code: "BROAD_WORKSPACE_ROOT",
      },
    );
    await expect(validateWorkspaceRoot(root, { protectedRoots: [parent] })).resolves.toBeTruthy();
  });

  it("fails closed when a validated directory is swapped for a symlink", async () => {
    const root = await workspace();
    const target = join(root, "target");
    const moved = join(root, "target-moved");
    const outside = await mkdtemp(join(tmpdir(), "workspace-policy-swap-outside-"));
    await mkdir(target);
    created.push(outside);
    const policy = await createWorkspacePathPolicy(root);
    await expect(policy.validateCommandCwd("target")).resolves.toBeTruthy();
    await rename(target, moved);
    await symlink(outside, target);
    await expect(policy.validateCommandCwd("target")).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
    });
  });

  it("returns a verified typed boundary for create, command and destructive operations", async () => {
    const root = await workspace();
    const policy = await createWorkspacePathPolicy(root);
    const createTarget = await policy.validateCreateTarget("new/file.txt");
    expect(createTarget).toBe(join(policy.root, "new/file.txt"));
    expect(await policy.validateCommandCwd()).toBe(policy.root);
    await mkdir(join(root, "new"));
    await writeFile(join(root, "new/file.txt"), "content");
    expect(await policy.validateDestructiveTarget("new/file.txt")).toBe(createTarget);
  });
});
