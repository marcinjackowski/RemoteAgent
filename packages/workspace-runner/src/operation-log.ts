import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";

const MAX_LOG_BYTES = 8 * 1024 * 1024;

export type OperationRecord = Readonly<{
  version: 1;
  operationId: string;
  identity: Readonly<{ caseId: string; workspaceId: string }>;
  kind: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  outcome: "SUCCEEDED" | "FAILED";
}>;

export class OperationLogConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperationLogConflictError";
  }
}

const chains = new Map<string, Promise<void>>();

function safe(record: OperationRecord): OperationRecord {
  if (
    record.version !== 1 ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.operationId) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(record.identity.caseId) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(record.identity.workspaceId) ||
    !/^[A-Z_]{1,64}$/.test(record.kind) ||
    (record.beforeDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(record.beforeDigest)) ||
    (record.afterDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(record.afterDigest))
  ) {
    throw new OperationLogConflictError("Invalid operation record");
  }
  return record;
}

export class OperationLedger {
  public constructor(private readonly metadataRoot: string) {}

  public async append(record: OperationRecord): Promise<"APPENDED" | "REPLAYED"> {
    const checked = safe(record);
    const canonicalRoot = await realpath(this.metadataRoot).catch(() => resolve(this.metadataRoot));
    const previous = chains.get(canonicalRoot) ?? Promise.resolve();
    let result: "APPENDED" | "REPLAYED" = "APPENDED";
    const next = previous.then(async () => {
      await mkdir(canonicalRoot, { recursive: true });
      const file = join(canonicalRoot, "operations.jsonl");
      const size = await stat(file)
        .then((value) => value.size)
        .catch(() => 0);
      if (size > MAX_LOG_BYTES)
        throw new OperationLogConflictError("Operation log exceeds bounded size");
      const existing = await readFile(file, "utf8").catch(() => "");
      if (Buffer.byteLength(existing) > MAX_LOG_BYTES)
        throw new OperationLogConflictError("Operation log exceeds bounded size");
      for (const line of existing.split("\n").filter(Boolean)) {
        const candidate = JSON.parse(line) as OperationRecord;
        if (candidate.operationId === checked.operationId) {
          if (
            candidate.version !== checked.version ||
            candidate.operationId !== checked.operationId ||
            candidate.identity.caseId !== checked.identity.caseId ||
            candidate.identity.workspaceId !== checked.identity.workspaceId ||
            candidate.kind !== checked.kind ||
            candidate.beforeDigest !== checked.beforeDigest ||
            candidate.afterDigest !== checked.afterDigest ||
            candidate.outcome !== checked.outcome
          ) {
            throw new OperationLogConflictError(
              "Operation replay does not match the original record",
            );
          }
          result = "REPLAYED";
          return;
        }
      }
      const line = `${JSON.stringify(checked)}\n`;
      if (size + Buffer.byteLength(line) > MAX_LOG_BYTES)
        throw new OperationLogConflictError("Operation log exceeds bounded size");
      await appendFile(file, line, { encoding: "utf8" });
    });
    const holder: { tail?: Promise<void> } = {};
    const settled = next.finally(() => {
      if (chains.get(canonicalRoot) === holder.tail) chains.delete(canonicalRoot);
    });
    const tail = settled.catch(() => undefined);
    holder.tail = tail;
    chains.set(canonicalRoot, tail);
    await next;
    return result;
  }
}
