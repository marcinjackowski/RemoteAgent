import {
  MAX_TOOL_OUTPUT_BYTES,
  type ImplementationToolResult,
} from "@remoteagent/implementation-tools";

export const ENGINEERING_CONTEXT_FRAGMENT_POLICY = Object.freeze({
  windowLines: 256,
  maxCalls: 24,
  maxFileBytes: 262_144,
  version: "engineering-context-fragments-v1",
});

export class EngineeringContextFragmentError extends Error {
  public constructor(
    public readonly code:
      "IMPLEMENTATION_CONTEXT_READ_FAILED" | "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE",
  ) {
    super(code);
    this.name = "EngineeringContextFragmentError";
  }
}

export type EngineeringContextFragment = Readonly<{
  kind: "READ";
  relative_path: string;
  query: null;
  evidence: string;
  start_line: number;
  end_line: number;
  full_file_digest: string;
}>;

export async function readEngineeringContextFragments(input: {
  relativePath: string;
  readExcerpt: (request: {
    relative_path: string;
    start_line: number;
    end_line: number;
  }) => Promise<ImplementationToolResult>;
  budget: { used: number };
  expectedDigest?: string;
}): Promise<readonly EngineeringContextFragment[]> {
  if (!Number.isSafeInteger(input.budget.used) || input.budget.used < 0)
    throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
  if (input.expectedDigest !== undefined && !isDigest(input.expectedDigest))
    throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
  const fragments: EngineeringContextFragment[] = [];
  let start = 1;
  let window: number = ENGINEERING_CONTEXT_FRAGMENT_POLICY.windowLines;
  let digest: string | undefined = input.expectedDigest;
  let totalBytes = 0;

  while (true) {
    const end = start + window - 1;
    if (++input.budget.used > ENGINEERING_CONTEXT_FRAGMENT_POLICY.maxCalls)
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    let result: ImplementationToolResult;
    try {
      result = await input.readExcerpt({
        relative_path: input.relativePath,
        start_line: start,
        end_line: end,
      });
    } catch {
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    }
    if (result.outcome !== "SUCCEEDED") {
      const failureCode = result.outcome === "FAILED" ? result.failure_code : undefined;
      if (failureCode === "OUTPUT_TOO_LARGE" && window > 1) {
        window = Math.max(1, Math.floor(window / 2));
        continue;
      }
      throw new EngineeringContextFragmentError(
        failureCode === "OUTPUT_TOO_LARGE"
          ? "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE"
          : "IMPLEMENTATION_CONTEXT_READ_FAILED",
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.output.value) as unknown;
    } catch {
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    }
    const fragment = payload as FragmentPayload;
    if (
      !isRecord(payload) ||
      payload.tool !== "read_excerpt" ||
      payload.refused !== false ||
      payload.complete !== false ||
      payload.relative_path !== input.relativePath ||
      !Number.isSafeInteger(payload.start_line) ||
      payload.start_line !== start ||
      !Number.isSafeInteger(fragment.end_line) ||
      typeof fragment.end_line !== "number" ||
      fragment.end_line < start ||
      fragment.end_line > end ||
      typeof payload.full_file_digest !== "string" ||
      typeof payload.content !== "string" ||
      typeof payload.end_of_file !== "boolean"
    ) {
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    }
    if (
      !isDigest(fragment.full_file_digest) ||
      (digest !== undefined && fragment.full_file_digest !== digest)
    )
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    digest ??= fragment.full_file_digest;
    if (
      result.output.truncated ||
      Buffer.byteLength(result.output.value, "utf8") > MAX_TOOL_OUTPUT_BYTES
    ) {
      if (window === 1)
        throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE");
      window = Math.max(1, Math.floor(window / 2));
      continue;
    }
    const bytes = Buffer.byteLength(fragment.content, "utf8");
    totalBytes += bytes;
    if (totalBytes > ENGINEERING_CONTEXT_FRAGMENT_POLICY.maxFileBytes)
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE");
    const lineCount =
      fragment.content.length === 0
        ? 0
        : fragment.content.endsWith("\n")
          ? fragment.content.split("\n").length - 1
          : fragment.content.split("\n").length;
    if (lineCount !== fragment.end_line - fragment.start_line + 1)
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    if (fragment.end_line < end && fragment.end_of_file !== true)
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    if (fragment.end_of_file !== true && !fragment.content.endsWith("\n"))
      throw new EngineeringContextFragmentError("IMPLEMENTATION_CONTEXT_READ_FAILED");
    fragments.push(
      Object.freeze({
        kind: "READ",
        relative_path: input.relativePath,
        query: null,
        evidence: result.output.value,
        start_line: fragment.start_line,
        end_line: fragment.end_line,
        full_file_digest: fragment.full_file_digest,
      }),
    );
    if (fragment.end_of_file === true) break;
    start = fragment.end_line + 1;
    window = ENGINEERING_CONTEXT_FRAGMENT_POLICY.windowLines;
  }
  return Object.freeze(fragments);
}

type FragmentPayload = {
  tool: "read_excerpt";
  refused: false;
  complete: false;
  relative_path: string;
  start_line: number;
  end_line: number;
  full_file_digest: string;
  content: string;
  end_of_file: boolean;
};

function isDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
