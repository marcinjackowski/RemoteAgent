import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { computeTreeDigest } from "@remoteagent/workspace-runner";

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

function uiHarnessInputs() {
  const files = [
    ["Tests/RemoteAgentUIHarness/App/RemoteAgentUIHarnessApp.swift", "import SwiftUI\n"],
    ["Tests/RemoteAgentUIHarness/UITests/RemoteAgentUIHarnessUITests.swift", "import XCTest\n"],
    ["Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.pbxproj", "// project\n"],
    [
      "Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme",
      "<Scheme/>\n",
    ],
    [
      "Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
      '{"pins":[]}\n',
    ],
  ] as const;
  return {
    files: files.map(([relative_path, content]) => ({
      relative_path,
      content,
      content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    })),
    required_executed_test_ids: [
      "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testGeneralHelp",
      "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testActivitySharing",
    ],
    layout: "XCODE_UI_HARNESS_V1" as const,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("disposable verification workspace", () => {
  it("installs the UI harness project and scheme as protected evaluator inputs", async () => {
    const authoritativeRoot = await repository();
    const input = uiHarnessInputs();
    let disposableRoot = "";
    const result = await runInDisposableWorkspace(
      { authoritativeRoot, mutableOutputs: [], trustedEvaluatorInputs: input },
      async (root) => {
        disposableRoot = root;
        await expect(readFile(join(root, input.files[2]!.relative_path), "utf8")).resolves.toBe(
          input.files[2]!.content,
        );
        await expect(readFile(join(root, input.files[3]!.relative_path), "utf8")).resolves.toBe(
          input.files[3]!.content,
        );
        await expect(readFile(join(root, input.files[4]!.relative_path), "utf8")).resolves.toBe(
          input.files[4]!.content,
        );
        return undefined;
      },
    );
    expect(result.evidence.evaluatorInputsDigest).toBeTruthy();
    await expect(access(disposableRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects UI harness project collisions, symlink parents, and protected mutations", async () => {
    const input = uiHarnessInputs();
    for (const collisionIndex of [2, 3, 4]) {
      const collisionRoot = await repository();
      await mkdir(join(collisionRoot, input.files[collisionIndex]!.relative_path, ".."), {
        recursive: true,
      });
      await writeFile(
        join(collisionRoot, input.files[collisionIndex]!.relative_path),
        "existing\n",
      );
      await expect(
        runInDisposableWorkspace(
          { authoritativeRoot: collisionRoot, mutableOutputs: [], trustedEvaluatorInputs: input },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code: DisposableWorkspaceErrorCode.INVALID_TRUSTED_EVALUATOR_INPUT,
      });
    }

    const outside = await mkdtemp(join(tmpdir(), "ui-harness-outside-"));
    roots.push(outside);
    const symlinkRoot = await repository();
    await symlink(outside, join(symlinkRoot, "Tests"));
    await expect(
      runInDisposableWorkspace(
        { authoritativeRoot: symlinkRoot, mutableOutputs: [], trustedEvaluatorInputs: input },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: DisposableWorkspaceErrorCode.UNSAFE_TREE_SYMLINK });

    for (const mutationIndex of [2, 3, 4]) {
      const mutationRoot = await repository();
      await expect(
        runInDisposableWorkspace(
          { authoritativeRoot: mutationRoot, mutableOutputs: [], trustedEvaluatorInputs: input },
          async (root) =>
            writeFile(join(root, input.files[mutationIndex]!.relative_path), "mutated\n"),
        ),
      ).rejects.toMatchObject({ code: DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED });
    }
  });

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

  it("installs frozen trusted evaluator inputs after copy and protects them", async () => {
    const authoritativeRoot = await repository();
    const content = "import XCTest\nfinal class Probe {}\n";
    const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    let callbackInput: { evaluatorInputsDigest?: string; disposableTreeDigest: string } | undefined;
    const result = await runInDisposableWorkspace(
      {
        authoritativeRoot,
        mutableOutputs: ["artifacts"],
        trustedEvaluatorInputs: {
          files: [
            {
              relative_path: "Tests/Generated/Probe.swift",
              content,
              content_digest: contentDigest,
            },
          ],
          required_executed_test_ids: ["SharedTests/ProbeTests/testProbe()"],
        },
      },
      async (root, input) => {
        callbackInput = input;
        await expect(readFile(join(root, "Tests/Generated/Probe.swift"), "utf8")).resolves.toBe(
          content,
        );
        return undefined;
      },
    );
    expect(callbackInput?.evaluatorInputsDigest).toBe(result.evidence.evaluatorInputsDigest);
    expect(callbackInput?.disposableTreeDigest).toBe(result.evidence.disposableTreeDigestBefore);
    expect(result.evidence.disposableTreeDigestBefore).not.toBe(
      result.evidence.authoritativeTreeDigestBefore,
    );
    await expect(access(join(authoritativeRoot, "Tests"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects evaluator input mutation as a protected change", async () => {
    const authoritativeRoot = await repository();
    const content = "probe\n";
    const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await expect(
      runInDisposableWorkspace(
        {
          authoritativeRoot,
          mutableOutputs: [],
          trustedEvaluatorInputs: {
            files: [
              {
                relative_path: "Tests/Generated/Probe.swift",
                content,
                content_digest: contentDigest,
              },
            ],
            required_executed_test_ids: ["SharedTests/ProbeTests/testProbe"],
          },
        },
        async (root) => writeFile(join(root, "Tests/Generated/Probe.swift"), "mutated\n"),
      ),
    ).rejects.toMatchObject({ code: DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED });
  });

  it.each(["collision", "mutable overlap"] as const)(
    "rejects trusted evaluator %s",
    async (kind) => {
      const authoritativeRoot = await repository();
      const content = "probe\n";
      const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      if (kind === "collision") await mkdir(join(authoritativeRoot, "Tests"));
      if (kind === "collision")
        await writeFile(join(authoritativeRoot, "Tests", "Probe.swift"), content);
      const path = kind === "collision" ? "Tests/Probe.swift" : "Tests/Mutable/Probe.swift";
      await expect(
        runInDisposableWorkspace(
          {
            authoritativeRoot,
            mutableOutputs: kind === "mutable overlap" ? ["Tests/Mutable"] : [],
            trustedEvaluatorInputs: {
              files: [{ relative_path: path, content, content_digest: contentDigest }],
              required_executed_test_ids: ["SharedTests/ProbeTests/testProbe"],
            },
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code: DisposableWorkspaceErrorCode.INVALID_TRUSTED_EVALUATOR_INPUT,
      });
    },
  );

  it("refuses unsafe evaluator parents and leaves before callback", async () => {
    const outside = await mkdtemp(join(tmpdir(), "trusted-input-outside-"));
    roots.push(outside);
    for (const kind of ["parent file", "parent symlink", "leaf symlink"] as const) {
      const authoritativeRoot = await repository();
      if (kind === "parent file") await writeFile(join(authoritativeRoot, "Tests"), "file\n");
      if (kind === "parent symlink") await symlink(outside, join(authoritativeRoot, "Tests"));
      if (kind === "leaf symlink") {
        await mkdir(join(authoritativeRoot, "Tests"));
        await symlink(join(outside, "target"), join(authoritativeRoot, "Tests", "Probe.swift"));
      }
      const value = "probe\n";
      const content_digest = `sha256:${createHash("sha256").update(value).digest("hex")}`;
      let called = false;
      await expect(
        runInDisposableWorkspace(
          {
            authoritativeRoot,
            mutableOutputs: [],
            trustedEvaluatorInputs: {
              files: [{ relative_path: "Tests/Probe.swift", content: value, content_digest }],
              required_executed_test_ids: ["T/S/test"],
            },
          },
          async () => {
            called = true;
          },
        ),
      ).rejects.toMatchObject({
        code:
          kind === "parent file"
            ? DisposableWorkspaceErrorCode.INVALID_TRUSTED_EVALUATOR_INPUT
            : DisposableWorkspaceErrorCode.UNSAFE_TREE_SYMLINK,
      });
      expect(called).toBe(false);
    }
  });

  it.each(["relative parent symlink", "relative leaf symlink"] as const)(
    "rejects an internal %s during input installation",
    async (kind) => {
      const authoritativeRoot = await repository();
      await mkdir(join(authoritativeRoot, "real-tests"));
      if (kind === "relative parent symlink")
        await symlink("real-tests", join(authoritativeRoot, "Tests"));
      else {
        await mkdir(join(authoritativeRoot, "Tests"));
        await symlink("../src/main.ts", join(authoritativeRoot, "Tests", "Probe.swift"));
      }
      const value = "probe\n";
      const content_digest = `sha256:${createHash("sha256").update(value).digest("hex")}`;
      let called = false;
      await expect(
        runInDisposableWorkspace(
          {
            authoritativeRoot,
            mutableOutputs: [],
            trustedEvaluatorInputs: {
              files: [{ relative_path: "Tests/Probe.swift", content: value, content_digest }],
              required_executed_test_ids: ["T/S/test"],
            },
          },
          async () => {
            called = true;
          },
        ),
      ).rejects.toMatchObject({
        code: DisposableWorkspaceErrorCode.INVALID_TRUSTED_EVALUATOR_INPUT,
      });
      expect(called).toBe(false);
    },
  );

  it("rejects evaluator leaves equal to and below mutable outputs", async () => {
    const value = "probe\n";
    const content_digest = `sha256:${createHash("sha256").update(value).digest("hex")}`;
    for (const mutableOutputs of [["Tests/Probe.swift"], ["Tests/Probe.swift/child"]]) {
      const authoritativeRoot = await repository();
      await expect(
        runInDisposableWorkspace(
          {
            authoritativeRoot,
            mutableOutputs,
            trustedEvaluatorInputs: {
              files: [{ relative_path: "Tests/Probe.swift", content: value, content_digest }],
              required_executed_test_ids: ["T/S/test"],
            },
          },
          async () => undefined,
        ),
      ).rejects.toMatchObject({
        code: DisposableWorkspaceErrorCode.INVALID_TRUSTED_EVALUATOR_INPUT,
      });
    }
  });

  it("snapshots caller input before asynchronous copy begins", async () => {
    const authoritativeRoot = await repository();
    const value = "original\n";
    const changed = "changed\n";
    const input = {
      files: [
        {
          relative_path: "Tests/Probe.swift",
          content: value,
          content_digest: `sha256:${createHash("sha256").update(value).digest("hex")}`,
        },
      ],
      required_executed_test_ids: ["T/S/test"],
    };
    const promise = runInDisposableWorkspace(
      { authoritativeRoot, mutableOutputs: [], trustedEvaluatorInputs: input },
      async (root, context) => ({
        content: await readFile(join(root, "Tests/Probe.swift"), "utf8"),
        digest: context.evaluatorInputsDigest,
      }),
    );
    input.files[0]!.content = changed;
    input.files[0]!.content_digest = `sha256:${createHash("sha256").update(changed).digest("hex")}`;
    input.required_executed_test_ids[0] = "T/S/changed";
    const result = await promise;
    expect(result.value.content).toBe(value);
    expect(result.evidence.evaluatorInputsDigest).toBe(result.value.digest);
  });

  it("preserves callback errors and cleans up trusted evaluator workspaces", async () => {
    const authoritativeRoot = await repository();
    const before = await computeTreeDigest(authoritativeRoot);
    let disposableRoot = "";
    const sentinel = new Error("sentinel");
    const value = "probe\n";
    const content_digest = `sha256:${createHash("sha256").update(value).digest("hex")}`;
    await expect(
      runInDisposableWorkspace(
        {
          authoritativeRoot,
          mutableOutputs: [],
          trustedEvaluatorInputs: {
            files: [{ relative_path: "Tests/Probe.swift", content: value, content_digest }],
            required_executed_test_ids: ["T/S/test"],
          },
        },
        async (root) => {
          disposableRoot = root;
          throw sentinel;
        },
      ),
    ).rejects.toBe(sentinel);
    await expect(access(disposableRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await computeTreeDigest(authoritativeRoot)).toBe(before);
  });

  it("keeps legacy no-input evidence shape and freezes callback context", async () => {
    const authoritativeRoot = await repository();
    let context: object | undefined;
    const result = await runInDisposableWorkspace(
      { authoritativeRoot, mutableOutputs: [] },
      async (_, value) => {
        context = value;
        return undefined;
      },
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect("evaluatorInputsDigest" in result.evidence).toBe(false);
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
