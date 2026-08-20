import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationLedger, runProcess } from "../src/index.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const record = (operationId: string) => ({
  version: 1 as const,
  operationId,
  identity: { caseId: "case", workspaceId: "workspace" },
  kind: "CREATE",
  beforeDigest: null,
  afterDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  outcome: "SUCCEEDED" as const,
});

describe("server-owned operation ledger", () => {
  it("is append-only, serialized, and exact replay safe", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-ledger-"));
    roots.push(root);
    const ledger = new OperationLedger(join(root, "metadata"));
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => ledger.append(record(`op-${index}`))),
    );
    expect(
      (await readFile(join(root, "metadata", "operations.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(20);
    await expect(ledger.append(record("op-1"))).resolves.toBe("REPLAYED");
    await expect(
      ledger.append({
        ...record("op-1"),
        afterDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).rejects.toThrow();
  });

  it("keeps the ledger outside the command sandbox", async () => {
    const parent = await mkdtemp(join(tmpdir(), "workspace-ledger-sandbox-"));
    const workspace = join(parent, "workspace");
    const metadata = join(parent, "metadata");
    await mkdir(workspace);
    roots.push(parent);
    const ledger = new OperationLedger(metadata);
    await ledger.append(record("sandbox-op"));
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        `require('node:fs').readFileSync(${JSON.stringify(join(metadata, "operations.jsonl"))})`,
      ],
      workspaceRoot: workspace,
      limits: { timeoutMs: 1000 },
      network: "ALLOW",
    });
    expect(result.exitCode).not.toBe(0);
  });
});
