import {
  agentCompletion,
  caseCheckpoint,
  decisionAnswer,
  decisionRequest,
  idString,
  isoTimestamp,
  type DecisionAnswer,
  type DecisionRequest,
} from "@remoteagent/contracts";
import { DecisionPreparationError, DecisionPreparationErrorCode } from "./errors.js";

export interface DecisionRequestPreparationInput {
  readonly completion: unknown;
  readonly currentCheckpoint: unknown;
}

export interface DecisionAnswerPreparationInput {
  readonly request: unknown;
  readonly selection: unknown;
  readonly system: unknown;
}

interface Selection {
  readonly decisionId: string;
  readonly selectedOptionId: string;
  readonly note?: string;
}

interface AnswerSystem {
  readonly caseId: string;
  readonly currentRevision: number;
  readonly answeredBy: string;
  readonly answeredAt: string;
}

function fail(message: string, code: DecisionPreparationErrorCode, cause?: unknown): never {
  throw new DecisionPreparationError(message, code, cause instanceof Error ? { cause } : undefined);
}

function parseSelection(input: unknown): Selection {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail("Selection is invalid", DecisionPreparationErrorCode.INVALID_SELECTION);
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !["decisionId", "selectedOptionId", "note"].includes(key)) ||
    !Object.hasOwn(value, "decisionId") ||
    !Object.hasOwn(value, "selectedOptionId")
  ) {
    return fail("Selection is invalid", DecisionPreparationErrorCode.INVALID_SELECTION);
  }
  const decisionId = idString.safeParse(value.decisionId);
  const selectedOptionId = idString.safeParse(value.selectedOptionId);
  const note =
    value.note === undefined ? undefined : typeof value.note === "string" ? value.note : null;
  if (
    !decisionId.success ||
    !selectedOptionId.success ||
    note === null ||
    (note !== undefined && note.length > 65_536)
  ) {
    return fail("Selection is invalid", DecisionPreparationErrorCode.INVALID_SELECTION);
  }
  return {
    decisionId: decisionId.data,
    selectedOptionId: selectedOptionId.data,
    ...(note === undefined ? {} : { note }),
  };
}

function parseSystem(input: unknown): AnswerSystem {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail("System answer authority is invalid", DecisionPreparationErrorCode.INVALID_SYSTEM);
  }
  const value = input as Record<string, unknown>;
  const expected = ["caseId", "currentRevision", "answeredBy", "answeredAt"];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    return fail("System answer authority is invalid", DecisionPreparationErrorCode.INVALID_SYSTEM);
  }
  const caseId = idString.safeParse(value.caseId);
  const answeredBy = idString.safeParse(value.answeredBy);
  const answeredAt = isoTimestamp.safeParse(value.answeredAt);
  const revisionValid =
    typeof value.currentRevision === "number" &&
    Number.isSafeInteger(value.currentRevision) &&
    value.currentRevision >= 0;
  if (!caseId.success || !answeredBy.success || !answeredAt.success || !revisionValid) {
    return fail("System answer authority is invalid", DecisionPreparationErrorCode.INVALID_SYSTEM);
  }
  return {
    caseId: caseId.data,
    currentRevision: value.currentRevision as number,
    answeredBy: answeredBy.data,
    answeredAt: answeredAt.data,
  };
}

export function prepareDecisionRequest({
  completion: rawCompletion,
  currentCheckpoint: rawCheckpoint,
}: DecisionRequestPreparationInput): DecisionRequest {
  const completionResult = agentCompletion.safeParse(rawCompletion);
  if (!completionResult.success)
    return fail(
      "Completion is invalid",
      DecisionPreparationErrorCode.INVALID_COMPLETION,
      completionResult.error,
    );
  const checkpointResult = caseCheckpoint.safeParse(rawCheckpoint);
  if (!checkpointResult.success)
    return fail(
      "Checkpoint is invalid",
      DecisionPreparationErrorCode.INVALID_CHECKPOINT,
      checkpointResult.error,
    );
  if (completionResult.data.status !== "WAITING_FOR_USER")
    return fail("Completion is not waiting for a user", DecisionPreparationErrorCode.NOT_WAITING);
  const completion = completionResult.data;
  const checkpoint = checkpointResult.data;
  if (completion.case_id !== checkpoint.case_id || checkpoint.last_run_id !== completion.run_id) {
    return fail("Completion and checkpoint do not match", DecisionPreparationErrorCode.MISMATCH);
  }
  const result = decisionRequest.safeParse({
    ...completion.decision_request,
    case_id: checkpoint.case_id,
    checkpoint_revision: checkpoint.revision,
  });
  if (!result.success)
    return fail(
      "Prepared decision request is invalid",
      DecisionPreparationErrorCode.INVALID_RESULT,
      result.error,
    );
  return result.data;
}

export function prepareDecisionAnswer({
  request: rawRequest,
  selection: rawSelection,
  system: rawSystem,
}: DecisionAnswerPreparationInput): DecisionAnswer {
  const requestResult = decisionRequest.safeParse(rawRequest);
  if (!requestResult.success)
    return fail(
      "Decision request is invalid",
      DecisionPreparationErrorCode.INVALID_REQUEST,
      requestResult.error,
    );
  const selection = parseSelection(rawSelection);
  const system = parseSystem(rawSystem);
  const request = requestResult.data;
  if (selection.decisionId !== request.decision_id)
    return fail("Decision identity does not match", DecisionPreparationErrorCode.MISMATCH);
  if (system.caseId !== request.case_id)
    return fail("Case identity does not match", DecisionPreparationErrorCode.MISMATCH);
  if (system.currentRevision !== request.checkpoint_revision)
    return fail("Decision revision is stale", DecisionPreparationErrorCode.STALE_REVISION);
  if (!request.options.some((option) => option.id === selection.selectedOptionId))
    return fail("Selected option is unknown", DecisionPreparationErrorCode.UNKNOWN_OPTION);
  if (
    request.expires_at !== undefined &&
    Date.parse(system.answeredAt) >= Date.parse(request.expires_at)
  )
    return fail("Decision has expired", DecisionPreparationErrorCode.EXPIRED);
  const result = decisionAnswer.safeParse({
    schema_version: request.schema_version,
    decision_id: request.decision_id,
    case_id: request.case_id,
    checkpoint_revision: request.checkpoint_revision,
    selected_option_id: selection.selectedOptionId,
    ...(selection.note === undefined ? {} : { note: selection.note }),
    answered_by: system.answeredBy,
    answered_at: system.answeredAt,
  });
  if (!result.success)
    return fail(
      "Prepared decision answer is invalid",
      DecisionPreparationErrorCode.INVALID_RESULT,
      result.error,
    );
  return result.data;
}
