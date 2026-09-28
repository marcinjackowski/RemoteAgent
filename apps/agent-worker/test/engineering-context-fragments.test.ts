import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EngineeringContextFragmentError,
  readEngineeringContextFragments,
} from "../src/engineering-context-fragments.js";
import {
  implementationToolResult,
  type ImplementationToolResult,
} from "@remoteagent/implementation-tools";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const result = (payload: Record<string, unknown>, truncated = false): ImplementationToolResult =>
  implementationToolResult.parse({
    schema_version: 1,
    operation_id: "fragment",
    identity: { case_id: "case", workspace_id: "workspace" },
    kind: "READ_FILE",
    outcome: "SUCCEEDED",
    before_digest: null,
    after_digest: "sha256:" + "0".repeat(64),
    changed_files: [],
    output: {
      trust: "UNTRUSTED_DATA",
      value: JSON.stringify(payload),
      truncated,
      original_byte_length: Buffer.byteLength(JSON.stringify(payload)),
    },
  });

describe("bounded engineering context fragments", () => {
  it("reads a large file as independent bounded fragments", async () => {
    const lines = Array.from(
      { length: 1_025 },
      (_, index) => `line-${String(index + 1).padStart(4, "0")} ${"x".repeat(68)}`,
    );
    const content = `${lines.join("\n")}\n`;
    const fileDigest = digest(content);
    const calls: number[] = [];
    const fragments = await readEngineeringContextFragments({
      relativePath: "Sources/Large.swift",
      budget: { used: 0 },
      readExcerpt: async (request) => {
        calls.push(request.start_line);
        const selected = lines.slice(request.start_line - 1, request.end_line);
        const text = `${selected.join("\n")}\n`;
        const end = request.start_line + selected.length - 1;
        return result({
          tool: "read_excerpt",
          refused: false,
          complete: false,
          relative_path: request.relative_path,
          start_line: request.start_line,
          end_line: end,
          full_file_digest: fileDigest,
          content: text,
          end_of_file: end === lines.length,
        });
      },
    });
    expect(calls).toEqual([1, 257, 513, 769, 1025]);
    expect(fragments).toHaveLength(5);
    expect(fragments.every((fragment) => fragment.kind === "READ")).toBe(true);
    expect(fragments.every((fragment) => Object.isFrozen(fragment))).toBe(true);
    expect(JSON.parse(fragments[0]!.evidence)).toMatchObject({ tool: "read_excerpt" });
    expect(fragments.at(-1)?.end_line).toBe(1_025);
  });

  it("requires explicit EOF and rejects malformed ranges or digest drift", async () => {
    const malformed = (payload: Record<string, unknown>) =>
      readEngineeringContextFragments({
        relativePath: "src/file.swift",
        budget: { used: 0 },
        readExcerpt: async () => result(payload),
      });
    await expect(
      malformed({
        tool: "read_excerpt",
        refused: false,
        complete: false,
        relative_path: "src/file.swift",
        start_line: 1,
        end_line: 1,
        full_file_digest: digest("x\n"),
        content: "x\n",
      }),
    ).rejects.toBeInstanceOf(EngineeringContextFragmentError);
    await expect(
      malformed({
        tool: "read_excerpt",
        refused: false,
        complete: false,
        relative_path: "other.swift",
        start_line: 1,
        end_line: 1,
        full_file_digest: digest("x\n"),
        content: "x\n",
        end_of_file: true,
      }),
    ).rejects.toBeInstanceOf(EngineeringContextFragmentError);
    const budget = { used: 0 };
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/file.swift",
        expectedDigest: digest("x\n"),
        budget,
        readExcerpt: async () =>
          result({
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: "src/file.swift",
            start_line: 1,
            end_line: 1,
            full_file_digest: digest("y\n"),
            content: "y\n",
            end_of_file: true,
          }),
      }),
    ).rejects.toBeInstanceOf(EngineeringContextFragmentError);
  });

  it.each([
    ["gap", { start_line: 2, end_line: 2, end_of_file: true, content: "x\n" }],
    ["overlap", { start_line: 1, end_line: 0, end_of_file: true, content: "" }],
    ["noninteger end", { start_line: 1, end_line: 1.5, end_of_file: true, content: "x\n" }],
    ["line count", { start_line: 1, end_line: 2, end_of_file: true, content: "x\n" }],
    ["short non-EOF", { start_line: 1, end_line: 1, end_of_file: false, content: "x\n" }],
    [
      "unterminated non-EOF",
      {
        start_line: 1,
        end_line: 256,
        end_of_file: false,
        content: Array.from({ length: 256 }, () => "x").join("\n"),
      },
    ],
    [
      "invalid SHA",
      {
        start_line: 1,
        end_line: 1,
        end_of_file: true,
        content: "x\n",
        full_file_digest: "sha256:bad",
      },
    ],
    ["missing EOF", { start_line: 1, end_line: 1, content: "x\n" }],
  ])("rejects %s fragment metadata", async (_name, fields) => {
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/file.swift",
        budget: { used: 0 },
        readExcerpt: async (request) =>
          result({
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: request.relative_path,
            full_file_digest: digest("x\n"),
            ...fields,
          }),
      }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  });

  it("rejects invalid budgets without invoking the reader", async () => {
    for (const used of [Number.NaN, -1]) {
      let calls = 0;
      await expect(
        readEngineeringContextFragments({
          relativePath: "src/file.swift",
          budget: { used },
          readExcerpt: async () => {
            calls += 1;
            return result({});
          },
        }),
      ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
      expect(calls).toBe(0);
    }
  });

  it.each(["FILE_NOT_FOUND", "DISCOVERY_FAILED", "SYMLINK_NOT_ALLOWED", "OVERSIZE"])(
    "does not retry fatal failure %s",
    async (failureCode) => {
      let calls = 0;
      await expect(
        readEngineeringContextFragments({
          relativePath: "src/file.swift",
          budget: { used: 0 },
          readExcerpt: async () => {
            calls += 1;
            return implementationToolResult.parse({
              schema_version: 1,
              operation_id: "fragment",
              identity: { case_id: "case", workspace_id: "workspace" },
              kind: "READ_FILE",
              outcome: "FAILED",
              before_digest: null,
              after_digest: null,
              changed_files: [],
              failure_code: failureCode,
              output: {
                trust: "UNTRUSTED_DATA",
                value: "{}",
                truncated: false,
                original_byte_length: 2,
              },
            });
          },
        }),
      ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
      expect(calls).toBe(1);
    },
  );

  it("redacts thrown reader errors and shares the call budget across files", async () => {
    const thrown = await readEngineeringContextFragments({
      relativePath: "src/file.swift",
      budget: { used: 0 },
      readExcerpt: async () => {
        throw new Error("/private/host/secret.swift");
      },
    }).then(
      () => new Error("resolved"),
      (error: unknown) => (error instanceof Error ? error : new Error("unknown")),
    );
    expect(thrown).toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
    expect(thrown.message).not.toContain("/private/host");
    const budget = { used: 23 };
    let calls = 0;
    const read = async (request: {
      relative_path: string;
      start_line: number;
      end_line: number;
    }) => {
      calls += 1;
      return result({
        tool: "read_excerpt",
        refused: false,
        complete: false,
        relative_path: request.relative_path,
        start_line: 1,
        end_line: 1,
        full_file_digest: digest("x\n"),
        content: "x\n",
        end_of_file: true,
      });
    };
    await expect(
      readEngineeringContextFragments({ relativePath: "a.swift", budget, readExcerpt: read }),
    ).resolves.toHaveLength(1);
    await expect(
      readEngineeringContextFragments({ relativePath: "b.swift", budget, readExcerpt: read }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
    expect(budget.used).toBe(25);
    expect(calls).toBe(1);
  });

  it("rejects a non-EOF fragment that omits its terminal newline", async () => {
    let calls = 0;
    const fileDigest = digest("x\n");
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/boundary.swift",
        budget: { used: 0 },
        readExcerpt: async (request) => {
          calls += 1;
          if (calls === 1)
            return result({
              tool: "read_excerpt",
              refused: false,
              complete: false,
              relative_path: request.relative_path,
              start_line: 1,
              end_line: 256,
              full_file_digest: fileDigest,
              content: Array.from({ length: 256 }, () => "x").join("\n"),
              end_of_file: false,
            });
          return result({
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: request.relative_path,
            start_line: request.start_line,
            end_line: request.start_line,
            full_file_digest: fileDigest,
            content: "x\n",
            end_of_file: true,
          });
        },
      }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
    expect(calls).toBe(1);
  });

  it("stops on an exact 256-line EOF and rejects a cross-chunk digest change", async () => {
    const content = `${Array.from({ length: 256 }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
    const fileDigest = digest(content);
    let calls = 0;
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/exact.swift",
        budget: { used: 0 },
        readExcerpt: async (request) => {
          calls += 1;
          return result({
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: request.relative_path,
            start_line: request.start_line,
            end_line: 256,
            full_file_digest: fileDigest,
            content,
            end_of_file: true,
          });
        },
      }),
    ).resolves.toHaveLength(1);
    expect(calls).toBe(1);
    let chunk = 0;
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/drift.swift",
        budget: { used: 0 },
        readExcerpt: async (request) => {
          chunk += 1;
          const text = `${Array.from({ length: 256 }, (_, index) => `line-${request.start_line + index}`).join("\n")}\n`;
          return result({
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: request.relative_path,
            start_line: request.start_line,
            end_line: request.start_line,
            full_file_digest: digest(chunk === 1 ? "a" : "b"),
            content: text,
            end_of_file: true,
          });
        },
      }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  });

  it("shrinks a truncated response and enforces the shared call budget", async () => {
    const calls: number[] = [];
    const budget = { used: 0 };
    const fragments = await readEngineeringContextFragments({
      relativePath: "src/file.swift",
      budget,
      readExcerpt: async (request) => {
        calls.push(request.end_line - request.start_line + 1);
        if (calls.length === 1)
          return result(
            {
              tool: "read_excerpt",
              refused: false,
              complete: false,
              relative_path: request.relative_path,
              start_line: request.start_line,
              end_line: request.end_line,
              full_file_digest: digest("x\n"),
              content: "x\n",
              end_of_file: false,
            },
            true,
          );
        return result({
          tool: "read_excerpt",
          refused: false,
          complete: false,
          relative_path: request.relative_path,
          start_line: request.start_line,
          end_line: request.start_line,
          full_file_digest: digest("x\n"),
          content: "x\n",
          end_of_file: true,
        });
      },
    });
    expect(calls).toEqual([256, 128]);
    expect(fragments).toHaveLength(1);
    const exhausted = { used: 24 };
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/file.swift",
        budget: exhausted,
        readExcerpt: async () => result({}),
      }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  });

  it("rejects oversized envelopes and cumulative file bytes", async () => {
    const oversized = "x".repeat(70_000);
    let calls = 0;
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/large.swift",
        budget: { used: 0 },
        readExcerpt: async (request) => {
          calls += 1;
          return {
            schema_version: 1,
            operation_id: "fragment",
            identity: { case_id: "case", workspace_id: "workspace" },
            kind: "READ_FILE",
            outcome: "SUCCEEDED",
            before_digest: null,
            after_digest: "sha256:" + "0".repeat(64),
            changed_files: [],
            output: {
              trust: "UNTRUSTED_DATA",
              value: JSON.stringify({
                tool: "read_excerpt",
                refused: false,
                complete: false,
                relative_path: request.relative_path,
                start_line: request.start_line,
                end_line: request.start_line,
                full_file_digest: digest(oversized),
                content: oversized,
                end_of_file: true,
              }),
              truncated: false,
              original_byte_length: 70_100,
            },
          } as unknown as ImplementationToolResult;
        },
      }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE" });
    expect(calls).toBeLessThanOrEqual(9);
    let chunks = 0;
    const chunkText = `${"x".repeat(210)}\n`.repeat(256);
    await expect(
      readEngineeringContextFragments({
        relativePath: "src/cumulative.swift",
        budget: { used: 0 },
        readExcerpt: async (request) => {
          chunks += 1;
          return result({
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: request.relative_path,
            start_line: request.start_line,
            end_line: request.end_line,
            full_file_digest: digest("stable"),
            content: chunkText,
            end_of_file: chunks === 5,
          });
        },
      }),
    ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE" });
  });
});
