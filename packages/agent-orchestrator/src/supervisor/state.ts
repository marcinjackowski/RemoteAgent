import type { WorkUnit, WorkUnitStatus } from "@remoteagent/contracts";

export const SupervisorStatus = {
  READY: "READY",
  RUNNING: "RUNNING",
  WAITING_FOR_USER: "WAITING_FOR_USER",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
} as const;
export type SupervisorStatus = (typeof SupervisorStatus)[keyof typeof SupervisorStatus];

export type SupervisorState = Readonly<{
  status: SupervisorStatus;
  workUnits: readonly WorkUnit[];
  activeWorkUnitId: string | null;
}>;

export type SupervisorEvent =
  | { readonly type: "START" }
  | { readonly type: "WORK_UNIT_COMPLETED"; readonly workUnitId: string }
  | { readonly type: "WORK_UNIT_FAILED"; readonly workUnitId: string }
  | { readonly type: "WAIT_FOR_USER"; readonly workUnitId: string }
  | { readonly type: "RESUME" }
  | { readonly type: "BLOCK" }
  | { readonly type: "CANCEL" };

export const SUPERVISOR_TRANSITIONS: Readonly<
  Record<SupervisorStatus, readonly SupervisorStatus[]>
> = {
  READY: ["RUNNING", "BLOCKED", "CANCELLED", "COMPLETED"],
  RUNNING: ["RUNNING", "WAITING_FOR_USER", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  WAITING_FOR_USER: ["READY", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: ["READY", "CANCELLED"],
  CANCELLED: [],
};

export const TERMINAL_SUPERVISOR_STATUSES: readonly SupervisorStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export function createSupervisorState(workUnits: readonly WorkUnit[]): SupervisorState {
  return { status: "READY", workUnits: [...workUnits], activeWorkUnitId: null };
}

/** PENDING is the only queueable status; terminal units can never be replayed. */
export function selectNextWorkUnit(state: SupervisorState): WorkUnit | null {
  if (state.status !== "READY" && state.status !== "RUNNING") return null;
  return state.workUnits.find((unit) => unit.status === "PENDING") ?? null;
}

export function isTerminalSupervisorStatus(status: SupervisorStatus): boolean {
  return TERMINAL_SUPERVISOR_STATUSES.includes(status);
}

export function isTerminalWorkUnitStatus(status: WorkUnitStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}
