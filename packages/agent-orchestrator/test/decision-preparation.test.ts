import { TrustLevel, type CaseCheckpoint } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";
import {
  DecisionPreparationError,
  DecisionPreparationErrorCode as Code,
  prepareDecisionAnswer,
  prepareDecisionRequest,
  type DecisionPreparationErrorCode,
} from "../src/index.js";

const checkpoint = (overrides: Partial<CaseCheckpoint> = {}): CaseCheckpoint => ({
  schema_version: 1,
  case_id: "case-1",
  revision: 7,
  goal: "goal",
  current_phase: "planning",
  summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "summary" },
  plan_revision: 1,
  completed_work: [],
  decisions: [],
  assumptions: [],
  evidence: [],
  open_questions: [],
  next_actions: [],
  blockers: [],
  pending_approvals: [],
  workspace_state: { tree_digest: null, base_sha: null },
  branch_state: { branch_name: null, ahead: 0, behind: 0 },
  test_runs: [],
  snapshot_changes: [],
  review_findings: [],
  merge_request_state: { mr_ref: null, status: null },
  external_state_versions: [],
  last_event_id: null,
  last_run_id: "run-1",
  updated_at: "2026-08-20T10:00:00Z",
  ...overrides,
});

const completion = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  run_id: "run-1",
  case_id: "case-1",
  status: "WAITING_FOR_USER" as const,
  summary: "model summary",
  completed_steps: [],
  evidence: [],
  checkpoint_patch: {},
  next_actions: [],
  decision_request: {
    schema_version: 1,
    decision_id: "decision-1",
    case_id: "case-1",
    question: "question-sentinel",
    why_now: "now",
    options: [
      { id: "a", label: "label-sentinel-a", consequences: "consequence-sentinel-a" },
      { id: "b", label: "label-sentinel-b", consequences: "consequence-sentinel-b" },
    ],
    recommendation: "a",
    blocked_scope: "scope",
    checkpoint_revision: 999,
    expires_at: "2026-08-20T12:00:00Z",
  },
  ...overrides,
});

const request = () =>
  prepareDecisionRequest({ completion: completion(), currentCheckpoint: checkpoint() });
const system = (overrides: Record<string, unknown> = {}) => ({
  caseId: "case-1",
  currentRevision: 7,
  answeredBy: "owner-1",
  answeredAt: "2026-08-20T11:00:00Z",
  ...overrides,
});
const selection = (overrides: Record<string, unknown> = {}) => ({
  decisionId: "decision-1",
  selectedOptionId: "a",
  ...overrides,
});

function expectError(
  call: () => unknown,
  code: DecisionPreparationErrorCode,
): DecisionPreparationError {
  let thrown: unknown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown).toBeInstanceOf(DecisionPreparationError);
  expect((thrown as DecisionPreparationError).code).toBe(code);
  return thrown as DecisionPreparationError;
}

describe("decision preparation", () => {
  it.each([0, 999])(
    "binds committed revision and preserves all request content for model revision %s",
    (modelRevision) => {
      const modelCompletion = completion({
        decision_request: { ...completion().decision_request, checkpoint_revision: modelRevision },
      });
      const committedCheckpoint = checkpoint();
      const before = structuredClone({ modelCompletion, committedCheckpoint });
      const result = prepareDecisionRequest({
        completion: modelCompletion,
        currentCheckpoint: committedCheckpoint,
      });
      expect(result).toMatchObject({ ...completion().decision_request, checkpoint_revision: 7 });
      expect(result.checkpoint_revision).toBe(7);
      expect({ modelCompletion, committedCheckpoint }).toEqual(before);
    },
  );

  it("rejects invalid completion, checkpoint and non-waiting completion", () => {
    expectError(
      () => prepareDecisionRequest({ completion: { nope: true }, currentCheckpoint: checkpoint() }),
      Code.INVALID_COMPLETION,
    );
    expectError(
      () => prepareDecisionRequest({ completion: completion(), currentCheckpoint: { nope: true } }),
      Code.INVALID_CHECKPOINT,
    );
    const nonWaiting = Object.fromEntries(
      Object.entries(completion()).filter(([key]) => key !== "decision_request"),
    );
    expectError(
      () =>
        prepareDecisionRequest({
          completion: { ...nonWaiting, status: "CONTINUE" },
          currentCheckpoint: checkpoint(),
        }),
      Code.NOT_WAITING,
    );
  });

  it("rejects checkpoint case and last-run mismatches", () => {
    expectError(
      () =>
        prepareDecisionRequest({
          completion: completion(),
          currentCheckpoint: checkpoint({ case_id: "other" }),
        }),
      Code.MISMATCH,
    );
    expectError(
      () =>
        prepareDecisionRequest({
          completion: completion(),
          currentCheckpoint: checkpoint({ last_run_id: "other" }),
        }),
      Code.MISMATCH,
    );
  });

  it("requires strict selection and system inputs", () => {
    expectError(
      () =>
        prepareDecisionAnswer({
          request: { nope: true },
          selection: selection(),
          system: system(),
        }),
      Code.INVALID_REQUEST,
    );
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: { ...selection(), extra: true },
          system: system(),
        }),
      Code.INVALID_SELECTION,
    );
    for (const value of [undefined, "", 1])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection({ decisionId: value }),
            system: system(),
          }),
        Code.INVALID_SELECTION,
      );
    for (const value of [undefined, "", 1])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection({ selectedOptionId: value }),
            system: system(),
          }),
        Code.INVALID_SELECTION,
      );
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: selection({ note: 1 }),
          system: system(),
        }),
      Code.INVALID_SELECTION,
    );
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: selection({ note: "x".repeat(65_537) }),
          system: system(),
        }),
      Code.INVALID_SELECTION,
    );
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: selection(),
          system: { ...system(), extra: true },
        }),
      Code.INVALID_SYSTEM,
    );
    for (const value of ["", 1])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection(),
            system: system({ caseId: value }),
          }),
        Code.INVALID_SYSTEM,
      );
    for (const value of ["", 1])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection(),
            system: system({ answeredBy: value }),
          }),
        Code.INVALID_SYSTEM,
      );
    for (const value of ["bad", 1])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection(),
            system: system({ answeredAt: value }),
          }),
        Code.INVALID_SYSTEM,
      );
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection(),
            system: system({ currentRevision: value }),
          }),
        Code.INVALID_SYSTEM,
      );
  });

  it("rejects identity, stale revision and unknown option errors", () => {
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: selection({ decisionId: "other" }),
          system: system(),
        }),
      Code.MISMATCH,
    );
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: selection(),
          system: system({ caseId: "other" }),
        }),
      Code.MISMATCH,
    );
    for (const revision of [6, 8])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: request(),
            selection: selection(),
            system: system({ currentRevision: revision }),
          }),
        Code.STALE_REVISION,
      );
    expectError(
      () =>
        prepareDecisionAnswer({
          request: request(),
          selection: selection({ selectedOptionId: "other" }),
          system: system(),
        }),
      Code.UNKNOWN_OPTION,
    );
  });

  it("accepts before expiry and rejects exact expiry and after", () => {
    const current = request();
    expect(
      prepareDecisionAnswer({
        request: current,
        selection: selection(),
        system: system({ answeredAt: "2026-08-20T11:59:59.999Z" }),
      }),
    ).toBeDefined();
    for (const answeredAt of ["2026-08-20T12:00:00Z", "2026-08-20T12:00:00.001Z"])
      expectError(
        () =>
          prepareDecisionAnswer({
            request: current,
            selection: selection(),
            system: system({ answeredAt }),
          }),
        Code.EXPIRED,
      );
  });

  it("returns exact answer shapes, preserves inputs and is deterministic", () => {
    const req = request();
    const sel = selection();
    const sys = system();
    const before = structuredClone({ req, sel, sys });
    const withoutNote = prepareDecisionAnswer({ request: req, selection: sel, system: sys });
    expect(withoutNote).toEqual({
      schema_version: 1,
      decision_id: "decision-1",
      case_id: "case-1",
      checkpoint_revision: 7,
      selected_option_id: "a",
      answered_by: "owner-1",
      answered_at: sys.answeredAt,
    });
    const withNote = prepareDecisionAnswer({
      request: req,
      selection: { ...sel, note: "note" },
      system: sys,
    });
    expect(withNote.note).toBe("note");
    expect(prepareDecisionAnswer({ request: req, selection: sel, system: sys })).toEqual(
      withoutNote,
    );
    expect({ req, sel, sys }).toEqual(before);
  });

  it("does not expose request or selection sentinels in error messages", () => {
    const req = request();
    const error = expectError(
      () =>
        prepareDecisionAnswer({
          request: req,
          selection: {
            decisionId: "decision-1",
            selectedOptionId: "missing",
            note: "note-sentinel",
          },
          system: system(),
        }),
      Code.UNKNOWN_OPTION,
    );
    for (const sentinel of [
      "question-sentinel",
      "note-sentinel",
      "label-sentinel-a",
      "consequence-sentinel-a",
    ])
      expect(error.message).not.toContain(sentinel);
  });
});
