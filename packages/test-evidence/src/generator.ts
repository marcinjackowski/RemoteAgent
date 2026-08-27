import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { canonicalDigest, idString, relativeRepositoryPath } from "@remoteagent/contracts";
import type { Transaction as DatabaseTransaction } from "@remoteagent/database";
import {
  MAX_WRITE_FILE_BYTES,
  MAX_WRITE_TOTAL_BYTES,
  OperationLedgerRepository,
  ToolOutcome,
  commandCatalogueEntry,
  createImplementationCommandTool,
  createImplementationWriteTools,
  type ImplementationToolResult,
  type ToolIdentity,
} from "@remoteagent/implementation-tools";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import * as z from "zod";

import { runInDisposableWorkspace } from "./disposable-workspace.js";

const canonicalUniquePaths = z
  .array(relativeRepositoryPath)
  .min(1)
  .max(32)
  .superRefine((paths, ctx) => {
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({ code: "custom", message: "paths must be unique" });
    }
    const sorted = [...paths].sort();
    if (paths.some((path, index) => path !== sorted[index])) {
      ctx.addIssue({ code: "custom", message: "paths must be sorted" });
    }
  });

export const codeOwnedGeneratorDefinition = z
  .object({
    generator_id: idString,
    trigger_paths: canonicalUniquePaths,
    output_paths: canonicalUniquePaths,
    command: commandCatalogueEntry,
  })
  .strict();

export type CodeOwnedGeneratorDefinition = z.infer<typeof codeOwnedGeneratorDefinition>;

function pathContained(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export class CodeOwnedGeneratorCatalog {
  public readonly definitions: readonly CodeOwnedGeneratorDefinition[];
  public readonly config_digest: string;

  private constructor(definitions: readonly CodeOwnedGeneratorDefinition[]) {
    this.definitions = Object.freeze(definitions);
    this.config_digest = canonicalDigest({
      schema_version: 1,
      generators: this.definitions,
    });
    Object.freeze(this);
  }

  public static async create(input: {
    definitions: readonly unknown[];
    executable_allowlist: readonly string[];
  }): Promise<CodeOwnedGeneratorCatalog> {
    const allowed = new Set<string>();
    for (const executable of input.executable_allowlist) {
      if (!isAbsolute(executable))
        throw new Error("generator executable allowlist must be absolute");
      const canonical = await realpath(executable);
      if (canonical !== executable)
        throw new Error("generator executable allowlist must be canonical");
      allowed.add(canonical);
    }
    const definitions = input.definitions
      .map((value) => codeOwnedGeneratorDefinition.parse(value))
      .sort((left, right) => left.generator_id.localeCompare(right.generator_id));
    if (new Set(definitions.map((item) => item.generator_id)).size !== definitions.length) {
      throw new Error("generator ids must be unique");
    }
    const ownedOutputs = new Set<string>();
    for (const definition of definitions) {
      const executable = await realpath(definition.command.executable);
      if (executable !== definition.command.executable || !allowed.has(executable)) {
        throw new Error("generator executable is not on the server allowlist");
      }
      for (const output of definition.output_paths) {
        if (ownedOutputs.has(output)) throw new Error("generator output paths must not overlap");
        ownedOutputs.add(output);
      }
      Object.freeze(definition.trigger_paths);
      Object.freeze(definition.output_paths);
      Object.freeze(definition.command.args);
      Object.freeze(definition.command.env);
      Object.freeze(definition.command);
      Object.freeze(definition);
    }
    return new CodeOwnedGeneratorCatalog(definitions);
  }

  public selected(changedPaths: readonly string[]): readonly CodeOwnedGeneratorDefinition[] {
    return Object.freeze(
      this.definitions.filter((definition) =>
        changedPaths.some((path) => pathContained(path, definition.trigger_paths)),
      ),
    );
  }
}

export const GeneratorBoundaryErrorCode = {
  OUTPUT_OUTSIDE_SLICE: "GENERATOR_OUTPUT_OUTSIDE_SLICE",
  OUTPUT_ALREADY_CHANGED: "GENERATOR_OUTPUT_ALREADY_CHANGED",
  COMMAND_FAILED: "GENERATOR_COMMAND_FAILED",
  STALE_RECEIPT: "GENERATOR_STALE_RECEIPT",
  OUTPUT_MISSING: "GENERATOR_OUTPUT_MISSING",
  OUTPUT_NOT_UTF8: "GENERATOR_OUTPUT_NOT_UTF8",
  MATERIALIZATION_FAILED: "GENERATOR_MATERIALIZATION_FAILED",
} as const;

export type GeneratorBoundaryErrorCode =
  (typeof GeneratorBoundaryErrorCode)[keyof typeof GeneratorBoundaryErrorCode];

export class GeneratorBoundaryError extends Error {
  public constructor(public readonly code: GeneratorBoundaryErrorCode) {
    super(code);
    this.name = "GeneratorBoundaryError";
  }
}

async function readTextFile(root: string, relativePath: string): Promise<string | null> {
  const target = join(root, ...relativePath.split("/"));
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await open(target, constants.O_RDONLY | noFollow).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_WRITE_FILE_BYTES) {
      throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.OUTPUT_MISSING);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
    } catch (error) {
      if (error instanceof GeneratorBoundaryError) throw error;
      throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.OUTPUT_NOT_UTF8);
    }
  } finally {
    await handle.close();
  }
}

export type CodeOwnedGeneratorExecution = Readonly<{
  operationResults: readonly ImplementationToolResult[];
  changedFiles: readonly string[];
}>;

/**
 * Run every server-selected generator in a disposable copy, prove its exact
 * output surface, then materialize only changed UTF-8 outputs through the
 * durable write ledger under a fresh writer fence.
 */
export async function executeCodeOwnedGenerators(input: {
  authoritativeRoot: string;
  artifactRoot: string;
  identity: ToolIdentity;
  ledger: OperationLedgerRepository;
  runTransaction: <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>;
  catalog: CodeOwnedGeneratorCatalog;
  implementationChangedPaths: readonly string[];
  allowedPaths: readonly string[];
  beforeMutation: () => Promise<void>;
  operationIdFor: (generatorId: string, phase: "command" | "materialize") => string;
}): Promise<CodeOwnedGeneratorExecution> {
  const results: ImplementationToolResult[] = [];
  const changed = new Set<string>();
  for (const definition of input.catalog.selected(input.implementationChangedPaths)) {
    if (definition.output_paths.some((path) => !pathContained(path, input.allowedPaths))) {
      throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.OUTPUT_OUTSIDE_SLICE);
    }
    if (definition.output_paths.some((path) => input.implementationChangedPaths.includes(path))) {
      throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.OUTPUT_ALREADY_CHANGED);
    }
    const disposable = await runInDisposableWorkspace(
      { authoritativeRoot: input.authoritativeRoot, mutableOutputs: definition.output_paths },
      async (root) => {
        const command = await createImplementationCommandTool({
          root,
          identity: input.identity,
          ledger: input.ledger,
          runTransaction: input.runTransaction,
          catalogue: { [definition.generator_id]: definition.command },
          network: "DENY",
          artifactRoot: input.artifactRoot,
        });
        const result = await command.run({
          operation_id: input.operationIdFor(definition.generator_id, "command"),
          command: definition.generator_id,
        });
        if (result.outcome !== ToolOutcome.SUCCEEDED) {
          throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.COMMAND_FAILED);
        }
        const files: { relative_path: string; content: string }[] = [];
        let total = 0;
        for (const relativePath of definition.output_paths) {
          const content = await readTextFile(root, relativePath);
          if (content === null) {
            throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.OUTPUT_MISSING);
          }
          total += new TextEncoder().encode(content).length;
          if (total > MAX_WRITE_TOTAL_BYTES) {
            throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.OUTPUT_MISSING);
          }
          files.push({ relative_path: relativePath, content });
        }
        return { result, files: Object.freeze(files) };
      },
    );
    if (disposable.value.result.after_digest !== disposable.evidence.disposableTreeDigestAfter) {
      throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.STALE_RECEIPT);
    }
    results.push(disposable.value.result);
    const files = [] as { relative_path: string; content: string }[];
    for (const file of disposable.value.files) {
      const current = await readTextFile(input.authoritativeRoot, file.relative_path);
      if (current !== file.content) files.push(file);
    }
    if (files.length === 0) continue;
    const writes = await createImplementationWriteTools({
      root: input.authoritativeRoot,
      identity: input.identity,
      ledger: input.ledger,
      runTransaction: input.runTransaction,
      beforeMutation: () => input.beforeMutation(),
    });
    const materialized = await writes.patch({
      operation_id: input.operationIdFor(definition.generator_id, "materialize"),
      files,
      expected_before_digest: await computeTreeDigest(input.authoritativeRoot),
    });
    results.push(materialized);
    if (materialized.outcome !== ToolOutcome.SUCCEEDED) {
      throw new GeneratorBoundaryError(GeneratorBoundaryErrorCode.MATERIALIZATION_FAILED);
    }
    for (const path of materialized.changed_files) changed.add(path);
  }
  return Object.freeze({
    operationResults: Object.freeze(results),
    changedFiles: Object.freeze([...changed].sort()),
  });
}
