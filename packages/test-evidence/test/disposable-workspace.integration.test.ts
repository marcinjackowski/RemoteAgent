import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DisposableWorkspaceErrorCode, runInDisposableWorkspace } from "../src/index.js";

const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "disposable-authority-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n");
  await writeFile(join(root, "README.md"), "authoritative\n");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("disposable verification workspace", () => {
  it("copies the exact current tree without .git and permits only output roots and ancestors", async () => {
    const authoritativeRoot = await repository();
    await mkdir(join(authoritativeRoot, ".git"));
    await writeFile(join(authoritativeRoot, ".git", "authority-edge"), "must not be copied\n");
    let disposableRoot = "";

    const result = await runInDisposableWorkspace(
      { authoritativeRoot, mutableOutputs: ["artifacts/results"] },
      async (root) => {
        disposableRoot = root;
        await expect(readFile(join(root, "src", "main.ts"), "utf8")).resolves.toBe(
          "export const value = 1;\n",
        );
        await expect(readFile(join(root, ".git", "authority-edge"))).rejects.toThrow();
        await mkdir(join(root, "artifacts", "results"), { recursive: true });
        await writeFile(join(root, "artifacts", "results", "report.json"), "{}\n");
        return "finished";
      },
    );

    expect(result.value).toBe("finished");
    expect(result.evidence.disposableTreeDigestBefore).toBe(
      result.evidence.authoritativeTreeDigestBefore,
    );
    expect(result.evidence.authoritativeTreeDigestAfter).toBe(
      result.evidence.authoritativeTreeDigestBefore,
    );
    expect(result.evidence.protectedTreeDigestAfter).toBe(
      result.evidence.protectedTreeDigestBefore,
    );
    expect(result.evidence.disposableTreeDigestAfter).not.toBe(
      result.evidence.disposableTreeDigestBefore,
    );
    await expect(readFile(join(authoritativeRoot, "README.md"), "utf8")).resolves.toBe(
      "authoritative\n",
    );
    await expect(access(disposableRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a write to a sibling of a mutable output", async () => {
    const authoritativeRoot = await repository();
    let disposableRoot = "";

    await expect(
      runInDisposableWorkspace(
        { authoritativeRoot, mutableOutputs: ["artifacts/results"] },
        async (root) => {
          disposableRoot = root;
          await mkdir(join(root, "artifacts", "results"), { recursive: true });
          await writeFile(join(root, "artifacts", "results", "allowed"), "ok\n");
          await writeFile(join(root, "artifacts", "sibling"), "not allowed\n");
        },
      ),
    ).rejects.toMatchObject({
      code: DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
      protectedChanges: [{ path: "artifacts/sibling", change: "ADDED" }],
    });
    await expect(access(disposableRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a newly created .git edge as a protected mutation", async () => {
    const authoritativeRoot = await repository();

    await expect(
      runInDisposableWorkspace(
        { authoritativeRoot, mutableOutputs: ["artifacts"] },
        async (root) => {
          await mkdir(join(root, ".git"));
          await writeFile(join(root, ".git", "payload"), "not protected by the copy filter\n");
        },
      ),
    ).rejects.toMatchObject({
      code: DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
    });
  });

  it.each(["ancestor", "root"] as const)(
    "rejects an outside symlink installed at the mutable %s after preflight",
    async (replacement) => {
      const authoritativeRoot = await repository();
      const outside = await mkdtemp(join(tmpdir(), "disposable-mutable-escape-"));
      roots.push(outside);

      await expect(
        runInDisposableWorkspace(
          { authoritativeRoot, mutableOutputs: ["artifacts/results"] },
          async (root) => {
            if (replacement === "ancestor") {
              await symlink(outside, join(root, "artifacts"));
              await writeFile(join(root, "artifacts", "outside-canary"), "escaped\n");
            } else {
              await mkdir(join(root, "artifacts"));
              await symlink(outside, join(root, "artifacts", "results"));
              await writeFile(join(root, "artifacts", "results", "outside-canary"), "escaped\n");
            }
          },
        ),
      ).rejects.toMatchObject({
        code: DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
      });
      // The direct callback demonstrates that the escape was real; the important
      // invariant is that it cannot be reported as successful verification.
      await expect(readFile(join(outside, "outside-canary"), "utf8")).resolves.toBe("escaped\n");
    },
  );

  it("rejects escaping, absolute and symlink mutable output paths", async () => {
    const authoritativeRoot = await repository();
    await mkdir(join(authoritativeRoot, "real-output"));
    await symlink("real-output", join(authoritativeRoot, "linked-output"));

    for (const mutableOutput of [
      "../escape",
      join(tmpdir(), "absolute-output"),
      "linked-output",
      ".git/output",
    ]) {
      await expect(
        runInDisposableWorkspace(
          { authoritativeRoot, mutableOutputs: [mutableOutput] },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code: DisposableWorkspaceErrorCode.INVALID_MUTABLE_OUTPUT,
      });
    }
  });

  it("rejects an authoritative tree whose symlink target escapes", async () => {
    const authoritativeRoot = await repository();
    const outside = await mkdtemp(join(tmpdir(), "disposable-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret"), "outside\n");
    await symlink(join(outside, "secret"), join(authoritativeRoot, "escape"));

    await expect(
      runInDisposableWorkspace({ authoritativeRoot, mutableOutputs: [] }, async () => undefined),
    ).rejects.toMatchObject({
      code: DisposableWorkspaceErrorCode.UNSAFE_TREE_SYMLINK,
    });
  });

  it("rejects an absolute symlink even when it points inside the authoritative tree", async () => {
    const authoritativeRoot = await repository();
    await symlink(join(authoritativeRoot, "README.md"), join(authoritativeRoot, "absolute-inside"));

    await expect(
      runInDisposableWorkspace({ authoritativeRoot, mutableOutputs: [] }, async () => undefined),
    ).rejects.toMatchObject({
      code: DisposableWorkspaceErrorCode.UNSAFE_TREE_SYMLINK,
    });
  });

  it("detects writes to the authoritative tree during the disposable run", async () => {
    const authoritativeRoot = await repository();

    await expect(
      runInDisposableWorkspace({ authoritativeRoot, mutableOutputs: [] }, async () =>
        writeFile(join(authoritativeRoot, "README.md"), "mutated\n"),
      ),
    ).rejects.toMatchObject({
      code: DisposableWorkspaceErrorCode.AUTHORITATIVE_TREE_CHANGED,
    });
  });

  it("cleans up after a failed operation without converting its error", async () => {
    const authoritativeRoot = await repository();
    const operationError = new Error("gate failed before receipt");
    let disposableRoot = "";

    await expect(
      runInDisposableWorkspace({ authoritativeRoot, mutableOutputs: [] }, async (root) => {
        disposableRoot = root;
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    await expect(access(disposableRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
