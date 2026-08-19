import {
  agentCompletion,
  caseCheckpoint,
  idString,
  isoTimestamp,
  type RunSafetyState,
  type AgentCompletion,
  type CaseCheckpoint,
} from "@remoteagent/contracts";
import { applyCheckpointPatch } from "./apply-patch.js";
import { CheckpointPatchError } from "./errors.js";
import { CompletionPreparationError, CompletionPreparationErrorCode } from "./completion-errors.js";
interface SystemAuthority {
  readonly completionId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly expectedRevision: number;
  readonly finishedAt: string;
}

function parseSystemAuthority(
  input: unknown,
): { success: true; data: SystemAuthority } | { success: false; error: unknown } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { success: false, error: new Error("authority must be an object") };
  }
  const value = input as Record<string, unknown>;
  const expectedKeys = ["caseId", "completionId", "expectedRevision", "finishedAt", "runId"];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    return { success: false, error: new Error("authority has unexpected fields") };
  }
  const fields = [value.completionId, value.runId, value.caseId].map((field) =>
    idString.safeParse(field),
  );
  const revisionValid =
    typeof value.expectedRevision === "number" &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0;
  const timeValid = isoTimestamp.safeParse(value.finishedAt);
  if (fields.some((field) => !field.success) || !revisionValid || !timeValid.success) {
    return { success: false, error: new Error("authority field is invalid") };
  }
  return {
    success: true,
    data: {
      completionId: value.completionId as string,
      runId: value.runId as string,
      caseId: value.caseId as string,
      expectedRevision: value.expectedRevision as number,
      finishedAt: value.finishedAt as string,
    },
  };
}

export interface CompletionPreparationInput {
  readonly completion: unknown;
  readonly current: unknown;
  readonly system: unknown;
}

export interface CompletionPreparationResult {
  readonly completion: AgentCompletion;
  readonly checkpoint: CaseCheckpoint;
  readonly runSafetyState: Extract<RunSafetyState, "SUCCEEDED" | "FAILED">;
  readonly finishedAt: string;
  readonly outbox: {
    readonly aggregate: "case";
    readonly aggregateId: string;
    readonly eventType: "agent.completion.recorded";
    readonly payload: {
      readonly completionId: string;
      readonly runId: string;
      readonly caseId: string;
      readonly status: AgentCompletion["status"];
      readonly checkpointRevision: number;
    };
  };
}

export function prepareCompletion(input: CompletionPreparationInput): CompletionPreparationResult {
  const completionResult = agentCompletion.safeParse(input.completion);
  if (!completionResult.success) {
    throw new CompletionPreparationError(
      "Completion does not satisfy the AgentCompletion contract",
      CompletionPreparationErrorCode.INVALID_COMPLETION,
      completionResult.error,
    );
  }

  const authorityResult = parseSystemAuthority(input.system);
  if (!authorityResult.success) {
    throw new CompletionPreparationError(
      "System completion authority is invalid",
      CompletionPreparationErrorCode.INVALID_SYSTEM_AUTHORITY,
      authorityResult.error,
    );
  }

  const completion = completionResult.data;
  const authority = authorityResult.data;
  const currentResult = caseCheckpoint.safeParse(input.current);
  if (!currentResult.success) {
    throw new CompletionPreparationError(
      "Current checkpoint cannot be used for completion",
      CompletionPreparationErrorCode.CHECKPOINT_APPLICATION,
      currentResult.error,
    );
  }
  const current = currentResult.data;

  if (
    completion.run_id !== authority.runId ||
    completion.case_id !== authority.caseId ||
    current.case_id !== authority.caseId ||
    current.revision !== authority.expectedRevision
  ) {
    throw new CompletionPreparationError(
      "Completion, system authority and current checkpoint do not match",
      CompletionPreparationErrorCode.MISMATCH,
    );
  }

  let applied: CaseCheckpoint;
  try {
    applied = applyCheckpointPatch({
      current,
      patch: completion.checkpoint_patch,
      updatedAt: authority.finishedAt,
    });
  } catch (error) {
    if (error instanceof CheckpointPatchError) {
      throw new CompletionPreparationError(
        "Checkpoint patch could not be applied",
        error.code === "INVALID_FINAL_RESULT"
          ? CompletionPreparationErrorCode.INVALID_FINAL_RESULT
          : CompletionPreparationErrorCode.CHECKPOINT_APPLICATION,
        error,
      );
    }
    throw error;
  }

  const finalResult = caseCheckpoint.safeParse({ ...applied, last_run_id: authority.runId });
  if (!finalResult.success) {
    throw new CompletionPreparationError(
      "Prepared checkpoint does not satisfy the CaseCheckpoint contract",
      CompletionPreparationErrorCode.INVALID_FINAL_RESULT,
      finalResult.error,
    );
  }

  const runSafetyState =
    completion.status === "FAILED" || completion.status === "CANCELLED" ? "FAILED" : "SUCCEEDED";

  return {
    completion,
    checkpoint: finalResult.data,
    runSafetyState,
    finishedAt: authority.finishedAt,
    outbox: {
      aggregate: "case",
      aggregateId: authority.caseId,
      eventType: "agent.completion.recorded",
      payload: {
        completionId: authority.completionId,
        runId: authority.runId,
        caseId: authority.caseId,
        status: completion.status,
        checkpointRevision: finalResult.data.revision,
      },
    },
  };
}
