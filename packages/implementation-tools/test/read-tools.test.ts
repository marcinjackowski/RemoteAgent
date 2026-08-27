/**
 * Specs for the four read-only model-facing tools.
 *
 * The bounded-read primitives themselves are covered by
 * `packages/repository-planner/test/read-tools.test.ts`; these specs pin what
 * this layer adds — that the limits are still enforced through the composition,
 * that each of the four refusal classes produces a `FAILED` envelope rather than
 * a leaked read, that truncation is always declared, and that a repeated read of
 * unchanged state returns an identical digest.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  IMPLEMENTATION_READ_TOOL_KINDS,
  MAX_TOOL_OUTPUT_BYTES,
  OUTPUT_TOO_LARGE,
  ToolKind,
  ToolOutcome,
  createImplementationReadTools,
  implementationToolResult,
  type ImplementationReadTools,
  type ImplementationToolResult,
} from "../src/index.js";

const roots: string[] = [];
const identity = { case_id: "case-1", workspace_id: "ws-1" };

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "implementation-read-"));
  roots.push(root);
  return root;
}

async function fixture(): Promise<{ root: string; tools: ImplementationReadTools }> {
  const root = await makeRoot();
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "[core]\n");
  await writeFile(join(root, ".env"), "TOKEN=super-secret\n");
  await writeFile(join(root, "README.md"), "read me\n");
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(root, "src", "app.ts"), "const needle = 42;\nfunction run() {}\n");
  return { root, tools: await createImplementationReadTools({ root, identity }) };
}

/** Every result must survive a re-parse: a malformed envelope cannot escape. */
function payload(result: ImplementationToolResult): Record<string, unknown> {
  expect(implementationToolResult.safeParse(result).success).toBe(true);
  return JSON.parse(result.output.value) as Record<string, unknown>;
}

function expectRefused(result: ImplementationToolResult, code: string): void {
  expect(result.outcome).toBe(ToolOutcome.FAILED);
  if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
  expect(result.failure_code).toBe(code);
  expect(result.changed_files).toEqual([]);
  const body = payload(result);
  expect(body["refused"]).toBe(true);
  // The refusal body must not carry file content of any kind.
  expect(body["content"]).toBeUndefined();
  expect(result.output.value).not.toContain("super-secret");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("four bounded read-only tools", () => {
  it("reads, searches, lists and reads allowlisted config inside the root", async () => {
    const { tools } = await fixture();

    const read = await tools.read({ operation_id: "op-read", relative_path: "src/app.ts" });
    expect(read.outcome).toBe(ToolOutcome.SUCCEEDED);
    expect(read.kind).toBe(ToolKind.READ_FILE);
    expect(read.before_digest).toBeNull();
    expect(read.changed_files).toEqual([]);
    expect(read.output.trust).toBe("UNTRUSTED_DATA");
    expect(read.output.truncated).toBe(false);
    expect(payload(read)).toMatchObject({
      complete: true,
      relative_path: "src/app.ts",
      content: "const needle = 42;\nfunction run() {}\n",
    });

    const search = await tools.search({ operation_id: "op-search", query: "needle" });
    expect(search.outcome).toBe(ToolOutcome.SUCCEEDED);
    expect(search.kind).toBe(ToolKind.SEARCH_TEXT);
    const matches = payload(search)["items"] as { relative_path: string; line: number }[];
    expect(matches).toMatchObject([{ relative_path: "src/app.ts", line: 1 }]);
    expect(payload(search)["dropped"]).toBe(0);

    const scoped = await tools.search({
      operation_id: "op-search-scoped",
      query: "needle",
      relative_path: "src/app.ts",
    });
    expect(payload(scoped)["items"]).toMatchObject([{ relative_path: "src/app.ts", line: 1 }]);
    expect(JSON.stringify(payload(scoped)["items"])).toContain("function run() {}");

    const tree = await tools.tree({ operation_id: "op-tree" });
    expect(tree.outcome).toBe(ToolOutcome.SUCCEEDED);
    expect(tree.kind).toBe(ToolKind.LIST_FILES);
    const paths = (payload(tree)["items"] as { relative_path: string }[]).map(
      (entry) => entry.relative_path,
    );
    expect(paths).toContain("src/app.ts");
    // The discovery denylist is still in force through the composition.
    expect(paths).not.toContain(".env");
    expect(paths.some((path) => path.startsWith(".git"))).toBe(false);

    const config = await tools.config({ operation_id: "op-config", relative_path: "package.json" });
    expect(config.outcome).toBe(ToolOutcome.SUCCEEDED);
    expect(payload(config)).toMatchObject({ relative_path: "package.json", complete: true });

    // The delegated capability manifest states the absence of write/execute.
    expect(tools.manifest.can_write_workspace).toBe(false);
    expect(tools.manifest.can_execute_commands).toBe(false);
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it("turns a missing guessed path into bounded search-first recovery guidance", async () => {
    const { tools } = await fixture();

    const result = await tools.read({ operation_id: "op-missing", relative_path: "src/Guess.ts" });

    expectRefused(result, "DISCOVERY_FAILED");
    expect(payload(result)).toMatchObject({
      next_action: "Use search with a filename fragment before another read.",
    });
  });

  it("maps config onto READ_FILE, since its payload is one file's bytes", async () => {
    const { tools } = await fixture();
    expect(IMPLEMENTATION_READ_TOOL_KINDS).toEqual({
      read: ToolKind.READ_FILE,
      search: ToolKind.SEARCH_TEXT,
      tree: ToolKind.LIST_FILES,
      config: ToolKind.READ_FILE,
    });
    const config = await tools.config({ operation_id: "op-c", relative_path: "README.md" });
    expect(config.kind).toBe(ToolKind.READ_FILE);
    // A path off the server-owned config allowlist is refused, not read.
    expectRefused(
      await tools.config({ operation_id: "op-c2", relative_path: "src/app.ts" }),
      "FILE_NOT_ALLOWED",
    );
  });
});

/**
 * Four refusal classes, one spec each. Keeping them separate means a regression
 * in exactly one class turns exactly one spec red.
 */
describe("refusal class: path traversal", () => {
  it("refuses ../, ..\\ and absolute paths without reading", async () => {
    const { tools } = await fixture();
    for (const relative_path of ["../outside.txt", "..\\outside.txt", "/etc/passwd", ".."]) {
      const result = await tools.read({ operation_id: `op-${relative_path}`, relative_path });
      expect(result.outcome).toBe(ToolOutcome.FAILED);
      const body = payload(result);
      expect(body["refused"]).toBe(true);
      expect(body["content"]).toBeUndefined();
    }
  });
});

describe("refusal class: symlink escape", () => {
  it("refuses a symlink whose target leaves the root", async () => {
    const { root, tools } = await fixture();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.txt"), "outside-secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    await symlink(outside, join(root, "escape-dir"));

    expectRefused(
      await tools.read({ operation_id: "op-link", relative_path: "escape.txt" }),
      "SYMLINK_NOT_ALLOWED",
    );
    expectRefused(
      await tools.read({ operation_id: "op-link-dir", relative_path: "escape-dir/secret.txt" }),
      "SYMLINK_NOT_ALLOWED",
    );
    // A tree listing may name the link, but must never carry its target's bytes.
    const tree = await tools.tree({ operation_id: "op-link-tree" });
    expect(tree.output.value).not.toContain("outside-secret");
  });
});

describe("refusal class: forbidden paths", () => {
  it("refuses .git and .env even though both exist and are readable on disk", async () => {
    const { tools } = await fixture();
    expectRefused(
      await tools.read({ operation_id: "op-git", relative_path: ".git/config" }),
      "FILE_NOT_ALLOWED",
    );
    expectRefused(
      await tools.read({ operation_id: "op-env", relative_path: ".env" }),
      "FILE_NOT_ALLOWED",
    );
    expectRefused(
      await tools.config({ operation_id: "op-env-config", relative_path: ".env" }),
      "FILE_NOT_ALLOWED",
    );
    // Not even a search may surface the secret's bytes.
    const search = await tools.search({ operation_id: "op-env-search", query: "super-secret" });
    expect(search.output.value).not.toContain("super-secret");
  });
});

describe("refusal class: outside the workspace root", () => {
  it("cannot reach a sibling root by any spelling, and rejects an unusable root", async () => {
    const { root, tools } = await fixture();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.txt"), "outside-secret\n");
    await mkdir(join(root, "sub"));

    // Every spelling that resolves outside the root: an absolute host path, and
    // traversal from a real subdirectory. Both are refused at the request
    // boundary, before any filesystem access, so no read is even attempted.
    for (const relative_path of [
      join(outside, "secret.txt"),
      `sub/../../${outside.split("/").at(-1) ?? "x"}/secret.txt`,
    ]) {
      expectRefused(
        await tools.read({ operation_id: `op-out-${relative_path}`, relative_path }),
        "INVALID_REQUEST",
      );
    }
    // The same holds for tree and config, not just read.
    expectRefused(
      await tools.tree({ operation_id: "op-out-tree", relative_path: outside }),
      "INVALID_REQUEST",
    );
    expectRefused(
      await tools.config({ operation_id: "op-out-config", relative_path: join(outside, "x.json") }),
      "INVALID_REQUEST",
    );

    // Positively: a full scan of this root surfaces nothing from the sibling.
    const tree = await tools.tree({ operation_id: "op-out-scan" });
    expect(tree.output.value).not.toContain("outside-secret");
    expect(tree.output.value).not.toContain(outside);

    // An unusable root is a server-side configuration fault, not an envelope:
    // it throws at construction so no tool surface is ever handed out.
    await expect(createImplementationReadTools({ root: "/", identity })).rejects.toMatchObject({
      code: "BROAD_WORKSPACE_ROOT",
    });
    await expect(
      createImplementationReadTools({ root: join(outside, "missing"), identity }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("bounds are enforced and truncation is never silent", () => {
  it("refuses an oversize file with a typed code instead of a partial read", async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, "large.txt"), Buffer.alloc(1_048_577, 65));
    expectRefused(
      await tools.read({ operation_id: "op-large", relative_path: "large.txt" }),
      "OVERSIZE",
    );
  });

  it("declares truncation on a file whose payload exceeds the output bound", async () => {
    const { root, tools } = await fixture();
    // Exactly at the content bound: the file itself is carryable, but the JSON
    // envelope around it is not, so the payload must be clipped and say so.
    const content = "z".repeat(MAX_TOOL_OUTPUT_BYTES);
    await writeFile(join(root, "big.txt"), content);
    const result = await tools.read({ operation_id: "op-big", relative_path: "big.txt" });
    expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
    expect(result.output.truncated).toBe(true);
    expect(result.output.original_byte_length).toBeGreaterThan(MAX_TOOL_OUTPUT_BYTES);
    expect(new TextEncoder().encode(result.output.value).length).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    // The payload itself says it is incomplete, so a consumer that ignores the
    // envelope flag still cannot mistake it for the whole file.
    const body = payload(result);
    expect(body["complete"]).toBe(false);
    expect((body["content"] as string).length).toBeLessThan(content.length);
  });

  it("drops whole items and reports the count when a listing overflows", async () => {
    const root = await makeRoot();
    // One file with 100 ~1 KB matching lines: comfortably inside the upstream
    // 128-result and scan budgets, but well past the 64 KiB output bound.
    const line = "q".repeat(1_000);
    await writeFile(join(root, "many.txt"), `${Array(100).fill(line).join("\n")}\n`);
    const tools = await createImplementationReadTools({ root, identity });
    const result = await tools.search({ operation_id: "op-many", query: "qqq" });
    expect(result.outcome).toBe(ToolOutcome.SUCCEEDED);
    expect(result.output.truncated).toBe(true);
    const body = payload(result);
    expect(body["complete"]).toBe(false);
    const kept = (body["items"] as unknown[]).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(100);
    // Items are dropped whole, and the count of dropped ones is stated.
    expect(body["dropped"]).toBe(100 - kept);
  });

  it("shares one scan budget across a search and fails closed when exceeded", async () => {
    const root = await makeRoot();
    // Each file is under the per-file limit; together they exceed the total scan
    // budget, which only a shared accumulator can detect.
    for (let index = 0; index < 18; index += 1) {
      await writeFile(join(root, `huge-${String(index)}.txt`), Buffer.alloc(1_000_000, 65));
    }
    const tools = await createImplementationReadTools({ root, identity });
    expectRefused(
      await tools.search({ operation_id: "op-budget", query: "not-present" }),
      "OVERSIZE",
    );
    expectRefused(await tools.tree({ operation_id: "op-budget-tree" }), "OVERSIZE");
  });

  it("fails with OUTPUT_TOO_LARGE rather than carrying an over-bound observation", async () => {
    const root = await makeRoot();
    // A file over the port's own content bound but under the per-file byte limit:
    // the observation cannot be carried at all, so there is nothing honest to
    // truncate and the call must fail instead of returning a clipped read.
    await writeFile(join(root, "one.txt"), "m".repeat(MAX_TOOL_OUTPUT_BYTES + 1_000));
    const tools = await createImplementationReadTools({ root, identity });
    const result = await tools.read({ operation_id: "op-huge", relative_path: "one.txt" });
    expect(result.outcome).toBe(ToolOutcome.FAILED);
    if (result.outcome !== ToolOutcome.FAILED) throw new Error("expected FAILED");
    expect(result.failure_code).toBe(OUTPUT_TOO_LARGE);
    expect(result.output.value).not.toContain("mmm");
  });

  it("reports a malformed request as INVALID_REQUEST without touching the disk", async () => {
    const { tools } = await fixture();
    expectRefused(
      await tools.search({ operation_id: "op-empty", query: "   " }),
      "INVALID_REQUEST",
    );
    expectRefused(
      await tools.read({ operation_id: "op-uri", relative_path: "file://secret" }),
      "INVALID_REQUEST",
    );
  });
});

describe("idempotence of the observed digest", () => {
  it("returns the same digest for unchanged state and a different one after a change", async () => {
    const { root, tools } = await fixture();
    const first = await tools.read({ operation_id: "op-1", relative_path: "src/app.ts" });
    const second = await tools.read({ operation_id: "op-2", relative_path: "src/app.ts" });
    expect(first.outcome).toBe(ToolOutcome.SUCCEEDED);
    if (first.outcome !== ToolOutcome.SUCCEEDED || second.outcome !== ToolOutcome.SUCCEEDED) {
      throw new Error("expected SUCCEEDED");
    }
    expect(second.after_digest).toBe(first.after_digest);
    expect(second.output.value).toBe(first.output.value);

    const firstTree = await tools.tree({ operation_id: "op-t1" });
    const secondTree = await tools.tree({ operation_id: "op-t2" });
    if (firstTree.outcome !== ToolOutcome.SUCCEEDED || secondTree.outcome !== ToolOutcome.SUCCEEDED)
      throw new Error("expected SUCCEEDED");
    expect(secondTree.after_digest).toBe(firstTree.after_digest);

    await writeFile(join(root, "src", "app.ts"), "const needle = 43;\n");
    const changed = await tools.read({ operation_id: "op-3", relative_path: "src/app.ts" });
    if (changed.outcome !== ToolOutcome.SUCCEEDED) throw new Error("expected SUCCEEDED");
    expect(changed.after_digest).not.toBe(first.after_digest);
  });

  it("keeps the digest of the complete observation stable under truncation", async () => {
    const { root, tools } = await fixture();
    await writeFile(join(root, "big.txt"), "y".repeat(MAX_TOOL_OUTPUT_BYTES));
    const first = await tools.read({ operation_id: "op-b1", relative_path: "big.txt" });
    const second = await tools.read({ operation_id: "op-b2", relative_path: "big.txt" });
    if (first.outcome !== ToolOutcome.SUCCEEDED || second.outcome !== ToolOutcome.SUCCEEDED)
      throw new Error("expected SUCCEEDED");
    // The digest covers the full content, so it is unaffected by clipping.
    expect(second.after_digest).toBe(first.after_digest);
    expect(first.output.truncated).toBe(true);
  });
});
