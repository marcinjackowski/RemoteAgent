import { TrustLevel, type CaseCheckpoint, type DecisionRequest } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  BudgetLedger,
  ControlPersistenceError,
  ControlConflictError,
  ControlStateError,
  DecisionPreparationError,
  InvalidBudgetError,
  SupervisorControl,
  type CheckpointAndStop,
  type ControlPersistence,
} from "../src/index.js";

const binding = { caseId: "case-1", runId: "run-1", checkpointRevision: 7 } as const;

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

const completion = (
  status: "CONTINUE" | "COMPLETED" | "WAITING_FOR_USER" = "CONTINUE",
  overrides: Record<string, unknown> = {},
) => ({
  schema_version: 1,
  run_id: "run-1",
  case_id: "case-1",
  status,
  summary: "summary",
  completed_steps: [],
  evidence: [],
  checkpoint_patch: {},
  next_actions: [],
  ...(status === "WAITING_FOR_USER"
    ? {
        decision_request: {
          schema_version: 1,
          decision_id: "decision-1",
          case_id: "case-1",
          question: "question",
          why_now: "now",
          options: [
            { id: "a", label: "A", consequences: "use A" },
            { id: "b", label: "B", consequences: "use B" },
          ],
          recommendation: "a",
          blocked_scope: "scope",
          checkpoint_revision: 999,
        },
      }
    : {}),
  ...overrides,
});

function ports(overrides: Partial<ControlPersistence> = {}) {
  const stops: CheckpointAndStop[] = [];
  const waiting: DecisionRequest[] = [];
  let allocated = 0;
  return {
    stops,
    waiting,
    get allocated(): number {
      return allocated;
    },
    port: {
      persistCheckpointAndStop: async (stop) => {
        stops.push(stop);
      },
      materializeWaiting: async ({ request }) => {
        waiting.push(request);
      },
      allocateRunId: () => {
        allocated += 1;
        return `run-${allocated + 1}`;
      },
      ...overrides,
    } satisfies ControlPersistence,
  };
}

describe("supervisor control and budgets", () => {
  it("uses positive server budgets with exact boundary counts", async () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new BudgetLedger({ maxIterations: value, maxFixes: 1 })).toThrow(
        InvalidBudgetError,
      );
    }
    const state = ports();
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 2, maxFixes: 3 },
      state.port,
    );
    expect(
      (await controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }))
        .kind,
    ).toBe("CONTINUE");
    const stop = await controller.complete({
      completion: completion(),
      currentCheckpoint: checkpoint(),
    });
    expect(stop).toMatchObject({
      kind: "CHECKPOINT_AND_STOP",
      reason: "ITERATION_BUDGET_EXHAUSTED",
      caseId: "case-1",
      runId: "run-1",
      checkpointRevision: 7,
      counts: { iterations: 2, fixes: 0 },
    });
    expect(state.stops).toHaveLength(1);
    expect(
      await controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }),
    ).toEqual(stop);
    expect(state.stops).toHaveLength(1);
  });

  it("does not declare checkpoint stop until persistence succeeds", async () => {
    let attempts = 0;
    const state = ports({
      persistCheckpointAndStop: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected failure");
      },
    });
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 1, maxFixes: 1 },
      state.port,
    );
    await expect(
      controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }),
    ).rejects.toBeInstanceOf(ControlPersistenceError);
    expect(controller.counts.iterations).toBe(0);
    expect(
      (await controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }))
        .kind,
    ).toBe("CHECKPOINT_AND_STOP");
    expect(attempts).toBe(2);
  });

  it("serializes exact concurrent checkpoint stops to one persistence call", async () => {
    let release!: () => void;
    let calls = 0;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = ports({
      persistCheckpointAndStop: async () => {
        calls += 1;
        await persisted;
      },
    });
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 1, maxFixes: 1 },
      state.port,
    );
    const first = controller.complete({
      completion: completion(),
      currentCheckpoint: checkpoint(),
    });
    const second = controller.complete({
      completion: completion(),
      currentCheckpoint: checkpoint(),
    });
    expect(calls).toBe(1);
    expect(controller.canDispatch()).toBe(false);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("CHECKPOINT_AND_STOP");
  });

  it("uses fix budget boundaries and never stops a completed run at its exact limit", async () => {
    const fixState = ports();
    const fixController = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 1 },
      fixState.port,
    );
    const fixStop = await fixController.complete({
      completion: completion(),
      successKind: "FIX",
      currentCheckpoint: checkpoint(),
    });
    expect(fixStop).toMatchObject({ kind: "CHECKPOINT_AND_STOP", reason: "FIX_BUDGET_EXHAUSTED" });

    const completedState = ports();
    const completedController = new SupervisorControl(
      binding,
      { maxIterations: 1, maxFixes: 1 },
      completedState.port,
    );
    expect(
      (
        await completedController.complete({
          completion: completion("COMPLETED"),
          currentCheckpoint: checkpoint(),
        })
      ).kind,
    ).toBe("COMPLETED");
    expect(completedState.stops).toHaveLength(0);
  });

  it("keeps pause sticky, gives cancel priority, and never dispatches after the gate", async () => {
    const state = ports();
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    controller.pause();
    expect(controller.canDispatch()).toBe(false);
    expect(
      (await controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }))
        .kind,
    ).toBe("PAUSED");
    expect(controller.counts.iterations).toBe(0);
    controller.resume();
    expect(
      (await controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }))
        .kind,
    ).toBe("CONTINUE");
    controller.pause();
    controller.cancel();
    expect(
      (await controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }))
        .kind,
    ).toBe("CANCELLED");
    expect(controller.canDispatch()).toBe(false);
    expect(state.stops).toHaveLength(0);
  });

  it("wins cancel during an awaited persistence boundary", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = ports({ persistCheckpointAndStop: async () => persisted });
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 1, maxFixes: 1 },
      state.port,
    );
    const pending = controller.complete({
      completion: completion(),
      currentCheckpoint: checkpoint(),
    });
    controller.cancel();
    release();
    expect((await pending).kind).toBe("CANCELLED");
  });

  it("materializes waiting with committed revision and resumes exactly once", async () => {
    const state = ports();
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    const waiting = await controller.complete({
      completion: completion("WAITING_FOR_USER"),
      currentCheckpoint: checkpoint(),
    });
    expect(waiting).toMatchObject({ kind: "WAITING_FOR_USER", source: binding });
    if (waiting.kind !== "WAITING_FOR_USER") throw new Error("expected waiting action");
    expect(waiting.request.checkpoint_revision).toBe(7);
    expect(state.waiting).toHaveLength(1);

    const answer = {
      answerId: "answer-1",
      selection: { decisionId: "decision-1", selectedOptionId: "a" },
      system: {
        caseId: "case-1",
        currentRevision: 7,
        answeredBy: "owner-1",
        answeredAt: "2026-08-20T11:00:00Z",
      },
    };
    const resumed = await controller.answer(answer);
    expect(resumed).toMatchObject({
      kind: "DISPATCH_NEW_RUN",
      caseId: "case-1",
      sourceRunId: "run-1",
      runId: "run-2",
      answerId: "answer-1",
      checkpointRevision: 7,
    });
    expect(await controller.answer(answer)).toEqual(resumed);
    expect(state.allocated).toBe(1);
  });

  it("serializes exact waiting materialization and rejects a conflicting in-flight completion", async () => {
    let release!: () => void;
    let calls = 0;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = ports({
      materializeWaiting: async () => {
        calls += 1;
        await persisted;
      },
    });
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    const first = controller.complete({
      completion: completion("WAITING_FOR_USER"),
      currentCheckpoint: checkpoint(),
    });
    const second = controller.complete({
      completion: completion("WAITING_FOR_USER", { summary: "different" }),
      currentCheckpoint: checkpoint(),
    });
    expect(calls).toBe(1);
    expect(controller.canDispatch()).toBe(false);
    await expect(second).rejects.toBeInstanceOf(ControlConflictError);
    release();
    expect((await first).kind).toBe("WAITING_FOR_USER");
  });

  it("rejects a conflicting completion after waiting materialization", async () => {
    const state = ports();
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    await controller.complete({
      completion: completion("WAITING_FOR_USER"),
      currentCheckpoint: checkpoint(),
    });
    await expect(
      controller.complete({
        completion: completion("WAITING_FOR_USER", { summary: "different" }),
        currentCheckpoint: checkpoint(),
      }),
    ).rejects.toBeInstanceOf(ControlConflictError);
    await expect(
      controller.complete({ completion: completion(), currentCheckpoint: checkpoint() }),
    ).rejects.toBeInstanceOf(ControlConflictError);
  });

  it("retries waiting materialization after persistence failure without declaring waiting", async () => {
    let attempts = 0;
    const state = ports({
      materializeWaiting: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected failure");
      },
    });
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    const event = { completion: completion("WAITING_FOR_USER"), currentCheckpoint: checkpoint() };
    await expect(controller.complete(event)).rejects.toBeInstanceOf(ControlPersistenceError);
    expect(controller.canDispatch()).toBe(true);
    expect((await controller.complete(event)).kind).toBe("WAITING_FOR_USER");
    expect(attempts).toBe(2);
  });

  it("gives cancel priority during waiting persistence", async () => {
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = ports({ materializeWaiting: async () => persisted });
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    const pending = controller.complete({
      completion: completion("WAITING_FOR_USER"),
      currentCheckpoint: checkpoint(),
    });
    controller.cancel();
    release();
    expect((await pending).kind).toBe("CANCELLED");
    expect(
      (
        await controller.answer({
          answerId: "answer-1",
          selection: { decisionId: "decision-1", selectedOptionId: "a" },
          system: {
            caseId: "case-1",
            currentRevision: 7,
            answeredBy: "owner-1",
            answeredAt: "2026-08-20T11:00:00Z",
          },
        })
      ).kind,
    ).toBe("CANCELLED");
  });

  it("rejects stale or foreign answers and model-controlled budget fields", async () => {
    const state = ports();
    const controller = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      state.port,
    );
    await expect(
      controller.complete({
        completion: completion("WAITING_FOR_USER"),
        currentCheckpoint: checkpoint({ revision: 8 }),
      }),
    ).rejects.toThrow("waiting decision revision does not match the active run");
    await controller.complete({
      completion: completion("WAITING_FOR_USER"),
      currentCheckpoint: checkpoint(),
    });
    await expect(
      controller.answer({
        answerId: "answer-stale",
        selection: { decisionId: "decision-1", selectedOptionId: "a" },
        system: {
          caseId: "case-1",
          currentRevision: 6,
          answeredBy: "owner-1",
          answeredAt: "2026-08-20T11:00:00Z",
        },
      }),
    ).rejects.toBeInstanceOf(DecisionPreparationError);
    await expect(
      controller.answer({
        answerId: "answer-foreign",
        selection: { decisionId: "decision-1", selectedOptionId: "a" },
        system: {
          caseId: "case-2",
          currentRevision: 7,
          answeredBy: "owner-1",
          answeredAt: "2026-08-20T11:00:00Z",
        },
      }),
    ).rejects.toBeInstanceOf(DecisionPreparationError);

    const fresh = ports();
    const freshController = new SupervisorControl(
      binding,
      { maxIterations: 3, maxFixes: 3 },
      fresh.port,
    );
    await expect(
      freshController.complete({
        completion: { ...completion(), budget: { maxIterations: 999 } },
        currentCheckpoint: checkpoint(),
      }),
    ).rejects.toBeInstanceOf(ControlStateError);
  });
});
