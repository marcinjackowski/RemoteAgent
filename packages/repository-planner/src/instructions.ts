import {
  instructionFact,
  plannerReadResult,
  plannerTreeResult,
  type InstructionFact,
  type PlannerReadPort,
} from "@remoteagent/contracts";

import { InstructionDiscoveryError } from "./errors.js";

const INSTRUCTION_NAME = "AGENTS.md";
const MAX_INSTRUCTION_FILES = 128;
const MAX_INSTRUCTION_BYTES = 1_048_576;

export type InstructionDiscoveryResult = Readonly<{
  instructions: readonly InstructionFact[];
}>;

type ReadHook = (path: string) => Promise<void> | void;

function fail(code: InstructionDiscoveryErrorCode, message: string): never {
  throw new InstructionDiscoveryError(code, message);
}

type InstructionDiscoveryErrorCode = ConstructorParameters<typeof InstructionDiscoveryError>[0];

function depth(path: string): number {
  return path.split("/").length;
}

async function discover(
  port: PlannerReadPort,
  beforeRead?: ReadHook,
): Promise<InstructionDiscoveryResult> {
  let tree;
  try {
    tree = plannerTreeResult.parse(await port.tree({}));
  } catch {
    fail("INSTRUCTION_INCOMPLETE", "Instruction tree is unavailable or invalid");
  }
  const seen = new Set<string>();
  const symlinkPaths = new Set<string>();
  const candidates: Array<{ path: string; digest: string }> = [];
  for (const entry of tree.entries) {
    const path = entry.provenance.relative_path;
    if (seen.has(path)) fail("INSTRUCTION_CONFLICT", "Duplicate instruction tree entry");
    seen.add(path);
    if (entry.kind === "symlink") symlinkPaths.add(path);
    if (path.split("/").includes(INSTRUCTION_NAME)) {
      if (path.endsWith(`/${INSTRUCTION_NAME}`) || path === INSTRUCTION_NAME)
        candidates.push({ path, digest: entry.provenance.digest });
    }
  }
  if (candidates.length > MAX_INSTRUCTION_FILES)
    fail("INSTRUCTION_OVERSIZE", "Instruction file count exceeds the bounded limit");
  candidates.sort(
    (a, b) => depth(a.path) - depth(b.path) || Buffer.from(a.path).compare(Buffer.from(b.path)),
  );
  const instructions: InstructionFact[] = [];
  let totalBytes = 0;
  for (const [precedence, candidate] of candidates.entries()) {
    const segments = candidate.path.split("/");
    if (segments.some((_, index) => symlinkPaths.has(segments.slice(0, index + 1).join("/"))))
      fail("SYMLINK_NOT_ALLOWED", "Instruction path or ancestor is a symlink");
    await beforeRead?.(candidate.path);
    let read;
    try {
      read = plannerReadResult.parse(await port.read({ relative_path: candidate.path }));
    } catch {
      fail("INSTRUCTION_READ_FAILED", "Instruction file could not be read safely");
    }
    if (read.relative_path !== candidate.path || read.digest !== candidate.digest)
      fail("INSTRUCTION_DIGEST_MISMATCH", "Instruction path or digest changed during read");
    const bytes = Buffer.byteLength(read.content.value, "utf8");
    totalBytes += bytes;
    if (totalBytes > MAX_INSTRUCTION_BYTES)
      fail("INSTRUCTION_OVERSIZE", "Instruction content exceeds the bounded limit");
    instructions.push(
      instructionFact.parse({
        provenance: {
          relative_path: read.relative_path,
          digest: read.digest,
          trust: "UNTRUSTED_DATA",
        },
        scope: candidate.path.includes("/") ? "NESTED" : "ROOT",
        precedence,
        content: read.content,
      }),
    );
  }
  if (instructions.length === 0)
    fail("INSTRUCTION_INCOMPLETE", "No AGENTS.md instruction was found");
  return { instructions };
}

export async function discoverInstructions(input: {
  port: PlannerReadPort;
}): Promise<InstructionDiscoveryResult> {
  return discover(input.port);
}

/** Source-only seam used by adversarial tests; it is intentionally not package-exported. */
export async function discoverInstructionsWithTestSeam(
  input: { port: PlannerReadPort },
  beforeRead: ReadHook,
): Promise<InstructionDiscoveryResult> {
  return discover(input.port, beforeRead);
}
