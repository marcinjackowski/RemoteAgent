import { describe, expect, it } from "vitest";
import {
  createSupervisorState,
  selectNextWorkUnit,
  supervisorTransitionMatrix,
  transitionSupervisor,
  type SupervisorStatus,
} from "../src/index.js";
import type { WorkUnit } from "@remoteagent/contracts";

const unit = (id: string, status: WorkUnit["status"] = "PENDING"): WorkUnit => ({
  schema_version: 1,
  work_unit_id: id,
  case_id: "case-1",
  status,
  role: "REVIEWER",
  objective: id,
  run_id: null,
  authoritative_scope: { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

describe("supervisor state machine", () => {
  it("exposes an exhaustive transition matrix", () => {
    const states: SupervisorStatus[] = [
      "READY",
      "RUNNING",
      "WAITING_FOR_USER",
      "COMPLETED",
      "FAILED",
      "BLOCKED",
      "CANCELLED",
    ];
    expect(Object.keys(supervisorTransitionMatrix).sort()).toEqual([...states].sort());
    expect(supervisorTransitionMatrix.COMPLETED).toEqual([]);
    expect(supervisorTransitionMatrix.FAILED).toEqual([]);
    expect(supervisorTransitionMatrix.CANCELLED).toEqual([]);
  });

  it("rejects illegal transitions", () => {
    expect(() =>
      transitionSupervisor(createSupervisorState([unit("a")]), { type: "RESUME" }),
    ).toThrow();
    const done = transitionSupervisor(createSupervisorState([unit("a", "COMPLETED")]), {
      type: "START",
    });
    expect(done.status).toBe("COMPLETED");
    expect(() => transitionSupervisor(done, { type: "START" })).toThrow();
  });

  it("does not dispatch a second unit while one is active", () => {
    const running = transitionSupervisor(createSupervisorState([unit("a"), unit("b")]), {
      type: "START",
    });
    expect(() => transitionSupervisor(running, { type: "START" })).toThrow();
    expect(running.activeWorkUnitId).toBe("a");
    expect(running.workUnits.find((candidate) => candidate.work_unit_id === "b")?.status).toBe(
      "PENDING",
    );
  });

  it("never requeues a completed unit", () => {
    const initial = createSupervisorState([unit("done", "COMPLETED"), unit("next"), unit("last")]);
    expect(selectNextWorkUnit(initial)?.work_unit_id).toBe("next");
    const running = transitionSupervisor(initial, { type: "START" });
    const next = transitionSupervisor(running, { type: "WORK_UNIT_COMPLETED", workUnitId: "next" });
    expect(next.activeWorkUnitId).toBe("last");
    expect(next.workUnits.find((candidate) => candidate.work_unit_id === "last")?.status).toBe(
      "RUNNING",
    );
    const completed = transitionSupervisor(next, {
      type: "WORK_UNIT_COMPLETED",
      workUnitId: "last",
    });
    expect(completed.status).toBe("COMPLETED");
    expect(selectNextWorkUnit(completed)).toBeNull();
  });

  it("terminates the current run when waiting for the user", () => {
    const running = transitionSupervisor(createSupervisorState([unit("a")]), { type: "START" });
    const waiting = transitionSupervisor(running, { type: "WAIT_FOR_USER", workUnitId: "a" });
    expect(waiting).toMatchObject({ status: "WAITING_FOR_USER", activeWorkUnitId: null });
    expect(() => transitionSupervisor(waiting, { type: "START" })).toThrow();
    expect(transitionSupervisor(waiting, { type: "RESUME" }).status).toBe("READY");
  });

  it.each([
    ["BLOCK", "FAILED"],
    ["CANCEL", "CANCELLED"],
  ] as const)("does not orphan a running unit on %s", (event, status) => {
    const running = transitionSupervisor(createSupervisorState([unit("a")]), { type: "START" });
    const stopped = transitionSupervisor(running, { type: event });
    expect(stopped.activeWorkUnitId).toBeNull();
    expect(stopped.workUnits[0]?.status).toBe(status);
  });
});
