import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterEach, describe, expect, it } from "vitest";

import {
  BaselineWorkspaceErrorCode,
  BaselineWorkspaceStore,
  deriveBaselineTreeDelta,
  type BaselineWorkspaceBinding,
} from "../src/index.js";

const roots: string[] = [];
const binding: BaselineWorkspaceBinding = {
  case_id: "case-baseline",
  workspace_id: "workspace-baseline",
  run_id: "run-baseline",
  checkpoint_revision: 3,
  slice_id: "slice-one",
  attempt: 1,
};

async function fixture(): Promise<{ parent: string; worktree: string; storage: string }> {
  const parent = await mkdtemp(join(tmpdir(), "ra-baseline-"));
  roots.push(parent);
  const worktree = join(parent, "worktrees", "case");
  const storage = join(parent, "metadata", "baselines");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(parent, "metadata"));
  await writeFile(join(worktree, "src", "subject.ts"), "export const value = 1;\n");
  await mkdir(join(worktree, ".git"));
  await writeFile(join(worktree, ".git", "config"), "target control edge\n");
  return { parent, worktree, storage };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable per-slice baseline workspace", () => {
  it("captures before mutation, recovers in a new store instance and cleans up after use", async () => {
    const { worktree, storage } = await fixture();
    const initialDigest = await computeTreeDigest(worktree);
    const firstStore = new BaselineWorkspaceStore({ root: storage });
    const reference = await firstStore.prepare(binding, worktree);
    expect(reference.tree_digest).toBe(initialDigest);

    await writeFile(join(worktree, "src", "subject.ts"), "export const value = 2;\n");
    const currentDigest = await computeTreeDigest(worktree);
    expect(currentDigest).not.toBe(reference.tree_digest);

    let baselineRoot = "";
    const recoveredStore = new BaselineWorkspaceStore({ root: storage });
    const observed = await recoveredStore.consume(binding, worktree, reference, async (root) => {
      baselineRoot = root;
      await expect(readFile(join(root, "src", "subject.ts"), "utf8")).resolves.toContain(
        "value = 1",
      );
      await expect(access(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      return computeTreeDigest(root);
    });
    expect(observed).toBe(reference.tree_digest);
    await expect(access(baselineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures slice two from the actual tree left by slice one", async () => {
    const { worktree, storage } = await fixture();
    const store = new BaselineWorkspaceStore({ root: storage });
    const first = await store.prepare(binding, worktree);
    await writeFile(join(worktree, "src", "slice-one.ts"), "slice one\n");
    await store.consume(binding, worktree, first, async () => undefined);

    const afterSliceOne = await computeTreeDigest(worktree);
    const secondBinding = { ...binding, slice_id: "slice-two", attempt: 2 };
    const second = await store.prepare(secondBinding, worktree);
    expect(second.tree_digest).toBe(afterSliceOne);
    expect(second.tree_digest).not.toBe(first.tree_digest);
    await store.consume(secondBinding, worktree, second, async (root) => {
      await expect(readFile(join(root, "src", "slice-one.ts"), "utf8")).resolves.toBe(
        "slice one\n",
      );
    });
  });

  it("rejects source symlink escapes and a storage root inside the worktree", async () => {
    const { parent, worktree, storage } = await fixture();
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "secret\n");
    await symlink(outside, join(worktree, "escape"));
    await expect(
      new BaselineWorkspaceStore({ root: storage }).prepare(binding, worktree),
    ).rejects.toMatchObject({ code: "UNSAFE_TREE_SYMLINK" });
    await rm(join(worktree, "escape"));
    const before = await computeTreeDigest(worktree);
    await expect(
      new BaselineWorkspaceStore({ root: join(worktree, "baselines") }).prepare(binding, worktree),
    ).rejects.toMatchObject({ code: BaselineWorkspaceErrorCode.UNSAFE_LOCATION });
    expect(await computeTreeDigest(worktree)).toBe(before);
    await expect(access(join(worktree, "baselines"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when baseline bytes, manifest, reference or binding are tampered", async () => {
    const { worktree, storage } = await fixture();
    const store = new BaselineWorkspaceStore({ root: storage });
    const reference = await store.prepare(binding, worktree);
    const baselineParent = join(storage, reference.baseline_id);
    await writeFile(join(baselineParent, "tree", "src", "subject.ts"), "tampered\n");
    await expect(
      store.consume(binding, worktree, reference, async () => undefined),
    ).rejects.toMatchObject({ code: BaselineWorkspaceErrorCode.BASELINE_CHANGED });

    await rm(baselineParent, { recursive: true, force: true });
    const fresh = await store.prepare(binding, worktree);
    await expect(
      store.consume({ ...binding, attempt: 2 }, worktree, fresh, async () => undefined),
    ).rejects.toMatchObject({ code: BaselineWorkspaceErrorCode.MANIFEST_MISMATCH });
    await expect(
      store.consume(
        binding,
        worktree,
        { ...fresh, tree_digest: `sha256:${"f".repeat(64)}` },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: BaselineWorkspaceErrorCode.MANIFEST_MISMATCH });
  });

  it("rechecks the baseline after gate use and cleans it after callback failure", async () => {
    const { worktree, storage } = await fixture();
    const store = new BaselineWorkspaceStore({ root: storage });
    const reference = await store.prepare(binding, worktree);
    let baselineRoot = "";
    await expect(
      store.consume(binding, worktree, reference, async (root) => {
        baselineRoot = root;
        await writeFile(join(root, "src", "subject.ts"), "gate tamper\n");
      }),
    ).rejects.toMatchObject({ code: BaselineWorkspaceErrorCode.BASELINE_CHANGED });
    await expect(access(baselineRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await store.prepare({ ...binding, attempt: 2 }, worktree);
    const gateError = new Error("gate batch failed");
    let secondRoot = "";
    await expect(
      store.consume({ ...binding, attempt: 2 }, worktree, second, async (root) => {
        secondRoot = root;
        throw gateError;
      }),
    ).rejects.toBe(gateError);
    await expect(access(secondRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a nested .git edge in the current tree instead of hiding it from delta", async () => {
    const { worktree, storage } = await fixture();
    const store = new BaselineWorkspaceStore({ root: storage });
    const reference = await store.prepare(binding, worktree);
    await mkdir(join(worktree, "src", "nested", ".git"), { recursive: true });
    await writeFile(join(worktree, "src", "nested", ".git", "config"), "foreign edge\n");
    await expect(
      store.inspect(binding, worktree, reference, (baselineRoot) =>
        deriveBaselineTreeDelta(baselineRoot, worktree),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_TREE_SYMLINK" });
  });
});
