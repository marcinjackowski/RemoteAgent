import { describe, expect, it } from "vitest";

import { defineStateMachine, InvalidTransitionError } from "../src/state-machine.js";
import { caseStatusMachine, CaseStatus } from "../src/case.js";
import { runSafetyMachine, RunSafetyState } from "../src/agent-run.js";
import {
  externalActionStatusMachine,
  assertExternalActionTransition,
  PolicyTransitionError,
} from "../src/external-action-machine.js";
import { ExternalActionStatus } from "../src/external-action-status.js";
import { workUnitStatusMachine, WorkUnitStatus } from "../src/work-unit.js";

describe("generic state machine", () => {
  it("rejects transitions to unknown states at definition time", () => {
    expect(() =>
      defineStateMachine<"A" | "B">("Broken", {
        A: ["B", "C" as "B"],
        B: [],
      }),
    ).toThrow(/unknown state/);
  });

  it("returns the target on an allowed transition", () => {
    const m = defineStateMachine<"A" | "B">("M", { A: ["B"], B: [] });
    expect(m.assertTransition("A", "B")).toBe("B");
    expect(m.canTransition("A", "B")).toBe(true);
  });

  it("throws a typed error and does not mutate on a disallowed transition", () => {
    const m = defineStateMachine<"A" | "B">("M", { A: ["B"], B: [] });
    const from = "B" as const;
    expect(() => m.assertTransition(from, "A")).toThrow(InvalidTransitionError);
    // Input value is untouched (immutability by contract).
    expect(from).toBe("B");
  });
});

describe("Case state machine", () => {
  it("allows the documented happy path", () => {
    let s: CaseStatus = CaseStatus.NEW;
    const path: CaseStatus[] = [
      CaseStatus.TRIAGED,
      CaseStatus.PLANNING,
      CaseStatus.IMPLEMENTING,
      CaseStatus.VERIFYING,
      CaseStatus.REVIEWING,
      CaseStatus.READY_FOR_MR,
      CaseStatus.MR_OPEN,
      CaseStatus.DONE,
    ];
    for (const next of path) {
      s = caseStatusMachine.assertTransition(s, next);
    }
    expect(s).toBe(CaseStatus.DONE);
  });

  it("supports the review fix loop", () => {
    expect(caseStatusMachine.assertTransition(CaseStatus.REVIEWING, CaseStatus.FIXING)).toBe(
      CaseStatus.FIXING,
    );
    expect(caseStatusMachine.assertTransition(CaseStatus.FIXING, CaseStatus.IMPLEMENTING)).toBe(
      CaseStatus.IMPLEMENTING,
    );
  });

  it("permits BLOCKED/CANCELLED from active states", () => {
    expect(caseStatusMachine.assertTransition(CaseStatus.PLANNING, CaseStatus.BLOCKED)).toBe(
      CaseStatus.BLOCKED,
    );
    expect(caseStatusMachine.assertTransition(CaseStatus.IMPLEMENTING, CaseStatus.CANCELLED)).toBe(
      CaseStatus.CANCELLED,
    );
  });

  it("has exactly {DONE, CANCELLED} as its complete terminal set", () => {
    expect(new Set(caseStatusMachine.terminalStates())).toEqual(
      new Set([CaseStatus.DONE, CaseStatus.CANCELLED]),
    );
    expect(caseStatusMachine.isTerminal(CaseStatus.DONE)).toBe(true);
    expect(caseStatusMachine.isTerminal(CaseStatus.CANCELLED)).toBe(true);
    // BLOCKED is a recoverable hold, not terminal.
    expect(caseStatusMachine.isTerminal(CaseStatus.BLOCKED)).toBe(false);
  });

  it("recovers from BLOCKED via exactly its documented transitions", () => {
    expect(new Set(caseStatusMachine.transitions[CaseStatus.BLOCKED])).toEqual(
      new Set([CaseStatus.PLANNING, CaseStatus.IMPLEMENTING, CaseStatus.CANCELLED]),
    );
    expect(caseStatusMachine.assertTransition(CaseStatus.BLOCKED, CaseStatus.PLANNING)).toBe(
      CaseStatus.PLANNING,
    );
    expect(caseStatusMachine.assertTransition(CaseStatus.BLOCKED, CaseStatus.IMPLEMENTING)).toBe(
      CaseStatus.IMPLEMENTING,
    );
    expect(caseStatusMachine.assertTransition(CaseStatus.BLOCKED, CaseStatus.CANCELLED)).toBe(
      CaseStatus.CANCELLED,
    );
    // A recovery target outside the documented set is rejected.
    expect(() => caseStatusMachine.assertTransition(CaseStatus.BLOCKED, CaseStatus.DONE)).toThrow(
      InvalidTransitionError,
    );
  });

  it("does not mutate state on a disallowed transition", () => {
    const from = CaseStatus.DONE;
    expect(() => caseStatusMachine.assertTransition(from, CaseStatus.PLANNING)).toThrow(
      InvalidTransitionError,
    );
    expect(from).toBe(CaseStatus.DONE);
  });

  it("rejects skipping phases", () => {
    expect(() =>
      caseStatusMachine.assertTransition(CaseStatus.NEW, CaseStatus.IMPLEMENTING),
    ).toThrow(InvalidTransitionError);
  });
});

describe("run safety machine", () => {
  it("follows PLANNED -> INTENT_RECORDED -> STARTED -> SUCCEEDED", () => {
    let s: RunSafetyState = RunSafetyState.PLANNED;
    s = runSafetyMachine.assertTransition(s, RunSafetyState.INTENT_RECORDED);
    s = runSafetyMachine.assertTransition(s, RunSafetyState.STARTED);
    s = runSafetyMachine.assertTransition(s, RunSafetyState.SUCCEEDED);
    expect(s).toBe(RunSafetyState.SUCCEEDED);
  });

  it("can end AMBIGUOUS from STARTED and then is terminal", () => {
    expect(
      runSafetyMachine.assertTransition(RunSafetyState.STARTED, RunSafetyState.AMBIGUOUS),
    ).toBe(RunSafetyState.AMBIGUOUS);
    expect(runSafetyMachine.isTerminal(RunSafetyState.AMBIGUOUS)).toBe(true);
  });

  it("can end FAILED from STARTED and then is terminal", () => {
    expect(runSafetyMachine.assertTransition(RunSafetyState.STARTED, RunSafetyState.FAILED)).toBe(
      RunSafetyState.FAILED,
    );
    expect(runSafetyMachine.isTerminal(RunSafetyState.FAILED)).toBe(true);
  });

  it("has exactly {SUCCEEDED, FAILED, AMBIGUOUS} as its complete terminal set", () => {
    expect(new Set(runSafetyMachine.terminalStates())).toEqual(
      new Set([RunSafetyState.SUCCEEDED, RunSafetyState.FAILED, RunSafetyState.AMBIGUOUS]),
    );
    expect(runSafetyMachine.isTerminal(RunSafetyState.SUCCEEDED)).toBe(true);
    expect(runSafetyMachine.isTerminal(RunSafetyState.FAILED)).toBe(true);
    expect(runSafetyMachine.isTerminal(RunSafetyState.AMBIGUOUS)).toBe(true);
  });

  it("has no automatic transition out of AMBIGUOUS (terminal for auto replay)", () => {
    expect(runSafetyMachine.transitions[RunSafetyState.AMBIGUOUS]).toEqual([]);
    expect(() =>
      runSafetyMachine.assertTransition(RunSafetyState.AMBIGUOUS, RunSafetyState.SUCCEEDED),
    ).toThrow(InvalidTransitionError);
  });

  it("does not mutate state on a disallowed transition", () => {
    const from = RunSafetyState.SUCCEEDED;
    expect(() => runSafetyMachine.assertTransition(from, RunSafetyState.STARTED)).toThrow(
      InvalidTransitionError,
    );
    expect(from).toBe(RunSafetyState.SUCCEEDED);
  });

  it("covers all terminal recovery states", () => {
    expect(new Set(runSafetyMachine.terminalStates())).toEqual(
      new Set([RunSafetyState.SUCCEEDED, RunSafetyState.FAILED, RunSafetyState.AMBIGUOUS]),
    );
  });

  it("forbids skipping INTENT_RECORDED", () => {
    expect(() =>
      runSafetyMachine.assertTransition(RunSafetyState.PLANNED, RunSafetyState.STARTED),
    ).toThrow(InvalidTransitionError);
  });
});

describe("external action machine", () => {
  it("auto-allow path proposes straight to executing", () => {
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.EXECUTING,
      ),
    ).toBe(ExternalActionStatus.EXECUTING);
  });

  it("approval path requires APPROVED before EXECUTING", () => {
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.APPROVED,
        ExternalActionStatus.EXECUTING,
      ),
    ).toBe(ExternalActionStatus.EXECUTING);
  });

  it("AMBIGUOUS is only reconciled manually to SUCCEEDED/FAILED", () => {
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.EXECUTING,
        ExternalActionStatus.AMBIGUOUS,
      ),
    ).toBe(ExternalActionStatus.AMBIGUOUS);
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.AMBIGUOUS,
        ExternalActionStatus.SUCCEEDED,
      ),
    ).toBe(ExternalActionStatus.SUCCEEDED);
  });

  it("rejects a decision request from PROPOSED to REJECTED then treats REJECTED as terminal", () => {
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.REJECTED,
      ),
    ).toBe(ExternalActionStatus.REJECTED);
    expect(externalActionStatusMachine.isTerminal(ExternalActionStatus.REJECTED)).toBe(true);
    expect(() =>
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.REJECTED,
        ExternalActionStatus.EXECUTING,
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("has exactly {REJECTED, SUCCEEDED, FAILED} as its complete terminal set", () => {
    expect(new Set(externalActionStatusMachine.terminalStates())).toEqual(
      new Set([
        ExternalActionStatus.REJECTED,
        ExternalActionStatus.SUCCEEDED,
        ExternalActionStatus.FAILED,
      ]),
    );
    // AMBIGUOUS is explicitly NOT terminal — it awaits manual reconciliation.
    expect(externalActionStatusMachine.isTerminal(ExternalActionStatus.AMBIGUOUS)).toBe(false);
  });

  it("allows out of AMBIGUOUS exactly the manual SUCCEEDED/FAILED transitions", () => {
    expect(
      new Set(externalActionStatusMachine.transitions[ExternalActionStatus.AMBIGUOUS]),
    ).toEqual(new Set([ExternalActionStatus.SUCCEEDED, ExternalActionStatus.FAILED]));
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.AMBIGUOUS,
        ExternalActionStatus.FAILED,
      ),
    ).toBe(ExternalActionStatus.FAILED);
    // No automatic replay: AMBIGUOUS cannot re-enter EXECUTING or reset.
    expect(() =>
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.AMBIGUOUS,
        ExternalActionStatus.EXECUTING,
      ),
    ).toThrow(InvalidTransitionError);
    expect(() =>
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.AMBIGUOUS,
        ExternalActionStatus.PROPOSED,
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("can end EXECUTING as SUCCEEDED or FAILED, both terminal", () => {
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.EXECUTING,
        ExternalActionStatus.SUCCEEDED,
      ),
    ).toBe(ExternalActionStatus.SUCCEEDED);
    expect(
      externalActionStatusMachine.assertTransition(
        ExternalActionStatus.EXECUTING,
        ExternalActionStatus.FAILED,
      ),
    ).toBe(ExternalActionStatus.FAILED);
    expect(externalActionStatusMachine.isTerminal(ExternalActionStatus.SUCCEEDED)).toBe(true);
    expect(externalActionStatusMachine.isTerminal(ExternalActionStatus.FAILED)).toBe(true);
  });

  it("does not mutate state on a disallowed transition", () => {
    const from = ExternalActionStatus.SUCCEEDED;
    expect(() =>
      externalActionStatusMachine.assertTransition(from, ExternalActionStatus.EXECUTING),
    ).toThrow(InvalidTransitionError);
    expect(from).toBe(ExternalActionStatus.SUCCEEDED);
  });
});

describe("policy-aware external action transitions", () => {
  it("AUTO_ALLOW permits the PROPOSED -> EXECUTING shortcut", () => {
    expect(
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.EXECUTING,
        "AUTO_ALLOW",
      ),
    ).toBe(ExternalActionStatus.EXECUTING);
  });

  it("REQUIRES_APPROVAL forbids the PROPOSED -> EXECUTING shortcut", () => {
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.EXECUTING,
        "REQUIRES_APPROVAL",
      ),
    ).toThrow(PolicyTransitionError);
  });

  it("REQUIRES_APPROVAL permits execution only via APPROVED", () => {
    expect(
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.APPROVED,
        "REQUIRES_APPROVAL",
      ),
    ).toBe(ExternalActionStatus.APPROVED);
    expect(
      assertExternalActionTransition(
        ExternalActionStatus.APPROVED,
        ExternalActionStatus.EXECUTING,
        "REQUIRES_APPROVAL",
      ),
    ).toBe(ExternalActionStatus.EXECUTING);
  });

  it("DENY permits only PROPOSED -> REJECTED", () => {
    expect(
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.REJECTED,
        "DENY",
      ),
    ).toBe(ExternalActionStatus.REJECTED);
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.APPROVED,
        "DENY",
      ),
    ).toThrow(PolicyTransitionError);
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.EXECUTING,
        "DENY",
      ),
    ).toThrow(PolicyTransitionError);
  });

  it("still enforces the structural machine before policy (illegal shape rejected)", () => {
    // SUCCEEDED is terminal; even under AUTO_ALLOW the structural machine rejects
    // it, and the error is the structural InvalidTransitionError.
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.SUCCEEDED,
        ExternalActionStatus.EXECUTING,
        "AUTO_ALLOW",
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("AUTO_ALLOW never enters APPROVED (reserved for the approval path)", () => {
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.APPROVED,
        "AUTO_ALLOW",
      ),
    ).toThrow(PolicyTransitionError);
  });

  it("AUTO_ALLOW never enters REJECTED (reserved for DENY / rejected approval path)", () => {
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.REJECTED,
        "AUTO_ALLOW",
      ),
    ).toThrow(PolicyTransitionError);
  });

  it("fails closed on an unknown policy decision (runtime, not just the type)", () => {
    expect(() =>
      assertExternalActionTransition(
        ExternalActionStatus.PROPOSED,
        ExternalActionStatus.EXECUTING,
        // Value outside the PolicyDecision union, cast to simulate an
        // unvalidated runtime caller. A permissive fallback would be a
        // fail-open authorization hole.
        "UNKNOWN_POLICY" as unknown as "AUTO_ALLOW",
      ),
    ).toThrow(PolicyTransitionError);
  });
});

describe("work unit machine", () => {
  it("runs to COMPLETED", () => {
    let s: WorkUnitStatus = WorkUnitStatus.PENDING;
    s = workUnitStatusMachine.assertTransition(s, WorkUnitStatus.DISPATCHED);
    s = workUnitStatusMachine.assertTransition(s, WorkUnitStatus.RUNNING);
    s = workUnitStatusMachine.assertTransition(s, WorkUnitStatus.COMPLETED);
    expect(workUnitStatusMachine.isTerminal(s)).toBe(true);
  });

  it("can FAIL from RUNNING and then is terminal", () => {
    expect(
      workUnitStatusMachine.assertTransition(WorkUnitStatus.RUNNING, WorkUnitStatus.FAILED),
    ).toBe(WorkUnitStatus.FAILED);
    expect(workUnitStatusMachine.isTerminal(WorkUnitStatus.FAILED)).toBe(true);
  });

  it("can CANCEL from PENDING, DISPATCHED and RUNNING", () => {
    expect(
      workUnitStatusMachine.assertTransition(WorkUnitStatus.PENDING, WorkUnitStatus.CANCELLED),
    ).toBe(WorkUnitStatus.CANCELLED);
    expect(
      workUnitStatusMachine.assertTransition(WorkUnitStatus.DISPATCHED, WorkUnitStatus.CANCELLED),
    ).toBe(WorkUnitStatus.CANCELLED);
    expect(
      workUnitStatusMachine.assertTransition(WorkUnitStatus.RUNNING, WorkUnitStatus.CANCELLED),
    ).toBe(WorkUnitStatus.CANCELLED);
  });

  it("has exactly {COMPLETED, FAILED, CANCELLED} as its complete terminal set", () => {
    expect(new Set(workUnitStatusMachine.terminalStates())).toEqual(
      new Set([WorkUnitStatus.COMPLETED, WorkUnitStatus.FAILED, WorkUnitStatus.CANCELLED]),
    );
    expect(workUnitStatusMachine.isTerminal(WorkUnitStatus.COMPLETED)).toBe(true);
    expect(workUnitStatusMachine.isTerminal(WorkUnitStatus.FAILED)).toBe(true);
    expect(workUnitStatusMachine.isTerminal(WorkUnitStatus.CANCELLED)).toBe(true);
  });

  it("rejects skipping DISPATCHED and does not mutate on a disallowed transition", () => {
    expect(() =>
      workUnitStatusMachine.assertTransition(WorkUnitStatus.PENDING, WorkUnitStatus.RUNNING),
    ).toThrow(InvalidTransitionError);
    const from = WorkUnitStatus.COMPLETED;
    expect(() => workUnitStatusMachine.assertTransition(from, WorkUnitStatus.RUNNING)).toThrow(
      InvalidTransitionError,
    );
    expect(from).toBe(WorkUnitStatus.COMPLETED);
  });
});
