import { workUnitStatusMachine, type WorkUnit } from "@remoteagent/contracts";
import { SupervisorInvariantError, SupervisorTransitionError } from "./errors.js";
import {
  isTerminalSupervisorStatus,
  selectNextWorkUnit,
  SUPERVISOR_TRANSITIONS,
  type SupervisorEvent,
  type SupervisorState,
  type SupervisorStatus,
} from "./state.js";

function assertSupervisorTransition(from: SupervisorStatus, to: SupervisorStatus, event: string) {
  const allowed = SUPERVISOR_TRANSITIONS[from];
  if (!allowed.includes(to)) throw new SupervisorTransitionError(from, event, allowed);
}

function replaceUnit(
  units: readonly WorkUnit[],
  id: string,
  status: WorkUnit["status"],
): readonly WorkUnit[] {
  const unit = units.find((candidate) => candidate.work_unit_id === id);
  if (!unit) throw new SupervisorInvariantError(`Unknown work unit '${id}'`);
  if (!workUnitStatusMachine.canTransition(unit.status, status))
    throw new SupervisorInvariantError(`Illegal work-unit transition ${unit.status} -> ${status}`);
  return units.map((candidate) =>
    candidate.work_unit_id === id ? { ...candidate, status } : candidate,
  );
}

export function transitionSupervisor(
  state: SupervisorState,
  event: SupervisorEvent,
): SupervisorState {
  if (isTerminalSupervisorStatus(state.status))
    throw new SupervisorTransitionError(
      state.status,
      event.type,
      SUPERVISOR_TRANSITIONS[state.status],
    );
  switch (event.type) {
    case "START": {
      if (state.status === "RUNNING")
        throw new SupervisorInvariantError("A running supervisor already has an active work unit");
      const next = selectNextWorkUnit(state);
      if (!next) {
        assertSupervisorTransition(state.status, "COMPLETED", event.type);
        return { ...state, status: "COMPLETED", activeWorkUnitId: null };
      }
      assertSupervisorTransition(state.status, "RUNNING", event.type);
      const dispatched = replaceUnit(state.workUnits, next.work_unit_id, "DISPATCHED");
      const workUnits = replaceUnit(dispatched, next.work_unit_id, "RUNNING");
      return { ...state, status: "RUNNING", workUnits, activeWorkUnitId: next.work_unit_id };
    }
    case "WORK_UNIT_COMPLETED": {
      if (state.status !== "RUNNING" || state.activeWorkUnitId !== event.workUnitId)
        throw new SupervisorInvariantError("Completed work unit is not the active unit");
      const workUnits = replaceUnit(state.workUnits, event.workUnitId, "COMPLETED");
      const next = selectNextWorkUnit({
        ...state,
        workUnits,
        status: "RUNNING",
        activeWorkUnitId: null,
      });
      const status: SupervisorStatus = next ? "RUNNING" : "COMPLETED";
      assertSupervisorTransition(state.status, status, event.type);
      if (!next) return { ...state, workUnits, status, activeWorkUnitId: null };
      const dispatched = replaceUnit(workUnits, next.work_unit_id, "DISPATCHED");
      const running = replaceUnit(dispatched, next.work_unit_id, "RUNNING");
      return { ...state, workUnits: running, status, activeWorkUnitId: next.work_unit_id };
    }
    case "WORK_UNIT_FAILED": {
      if (state.status !== "RUNNING" || state.activeWorkUnitId !== event.workUnitId)
        throw new SupervisorInvariantError("Failed work unit is not the active unit");
      const workUnits = replaceUnit(state.workUnits, event.workUnitId, "FAILED");
      assertSupervisorTransition(state.status, "FAILED", event.type);
      return { ...state, workUnits, status: "FAILED", activeWorkUnitId: null };
    }
    case "WAIT_FOR_USER": {
      if (state.status !== "RUNNING" || state.activeWorkUnitId !== event.workUnitId)
        throw new SupervisorInvariantError("Waiting work unit is not the active unit");
      const workUnits = replaceUnit(state.workUnits, event.workUnitId, "COMPLETED");
      assertSupervisorTransition(state.status, "WAITING_FOR_USER", event.type);
      return { ...state, workUnits, status: "WAITING_FOR_USER", activeWorkUnitId: null };
    }
    case "RESUME":
      assertSupervisorTransition(state.status, "READY", event.type);
      return { ...state, status: "READY", activeWorkUnitId: null };
    case "BLOCK": {
      assertSupervisorTransition(state.status, "BLOCKED", event.type);
      const workUnits =
        state.status === "RUNNING" && state.activeWorkUnitId
          ? replaceUnit(state.workUnits, state.activeWorkUnitId, "FAILED")
          : state.workUnits;
      return { ...state, workUnits, status: "BLOCKED", activeWorkUnitId: null };
    }
    case "CANCEL": {
      assertSupervisorTransition(state.status, "CANCELLED", event.type);
      const workUnits =
        state.status === "RUNNING" && state.activeWorkUnitId
          ? replaceUnit(state.workUnits, state.activeWorkUnitId, "CANCELLED")
          : state.workUnits;
      return { ...state, workUnits, status: "CANCELLED", activeWorkUnitId: null };
    }
  }
}

export const supervisorTransitionMatrix = SUPERVISOR_TRANSITIONS;
