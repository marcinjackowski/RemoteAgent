import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StructuredContractOutputError } from "@remoteagent/model-runtime";
import {
  EngineeringDebugJournal,
  runWithEngineeringDebugJournal,
  runWithEngineeringDebugStage,
} from "../src/engineering-debug-journal.js";

it("records safe scoped stage errors and rethrows the original error", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-stage-error-"));
  try {
    const journal = await EngineeringDebugJournal.create({
      artifactRoot: root,
      invocationId: "stage-error",
    });
    const error = new StructuredContractOutputError("PLANNING_MINIMUM_BLUEPRINTS");
    error.message = "PRIVATE_TASK_CONTENT must never be persisted";
    await expect(
      runWithEngineeringDebugJournal(journal, () =>
        runWithEngineeringDebugStage("PROGRAM_DESIGN", async () => {
          throw error;
        }),
      ),
    ).rejects.toBe(error);
    await journal.close();
    const text = await readFile(journal.filePath, "utf8");
    const events = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const stageError = events.find((event) => event.event === "STAGE_ERROR");
    expect(stageError.stage).toBe("PROGRAM_DESIGN");
    expect(stageError.error_detail_code).toBe("PLANNING_MINIMUM_BLUEPRINTS");
    expect(stageError.error_code).toBe("TRANSPORT_ERROR");
    expect(text).not.toContain("PRIVATE_TASK_CONTENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records safe fallback metadata for unknown errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-stage-error-"));
  try {
    const journal = await EngineeringDebugJournal.create({
      artifactRoot: root,
      invocationId: "unknown-stage-error",
    });
    await expect(
      runWithEngineeringDebugJournal(journal, () =>
        runWithEngineeringDebugStage("PROGRAM_DESIGN", async () => {
          throw new Error("PRIVATE");
        }),
      ),
    ).rejects.toThrow("PRIVATE");
    await journal.close();
    const text = await readFile(journal.filePath, "utf8");
    const stageError = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "STAGE_ERROR");
    expect(stageError.stage).toBe("PROGRAM_DESIGN");
    expect(stageError.error_name).toBe("Error");
    expect(text).not.toContain("PRIVATE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
