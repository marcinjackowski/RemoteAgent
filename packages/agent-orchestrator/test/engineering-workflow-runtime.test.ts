import {
  agentCompletion,
  canonicalDigest,
  type AgentCompletion,
  type WorkUnit,
} from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  EngineeringStage,
  engineeringGateFailureCycleFingerprint,
  engineeringGateFailureFingerprint,
  engineeringReviewCycleFingerprint,
  engineeringStructuralFingerprint,
  evaluateEngineeringApproval,
  evaluateEngineeringProgress,
  evaluateEngineeringGateCorrectionBudget,
  evaluateStableGateDiagnosticPersistence,
  evaluateCompilerDiagnosticProgress,
  planEngineeringWorkflow,
  SupervisorRuntime,
  type EngineeringRecoveredStage,
  type EngineeringRuntimePort,
  type EngineeringRuntimeSession,
  type EngineeringStageBinding,
  type EngineeringStageCallResult,
  type RuntimePersistence,
  type RuntimeSnapshot,
  type RuntimeUnit,
} from "../src/index.js";

it("evaluates compiler diagnostic progress deterministically", () => {
  expect(evaluateCompilerDiagnosticProgress([])).toBe("CONTINUE");
  expect(evaluateCompilerDiagnosticProgress([["a"]])).toBe("CONTINUE");
  expect(evaluateCompilerDiagnosticProgress([["a"], ["a"]])).toBe("NO_PROGRESS");
  expect(evaluateCompilerDiagnosticProgress([["a"], []])).toBe("CONTINUE");
  expect(evaluateCompilerDiagnosticProgress([["a", "b"], ["a"]])).toBe("CONTINUE");
  expect(evaluateCompilerDiagnosticProgress([["a"], ["b"]])).toBe("CONTINUE");
});

const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
const risk = (patch: Record<string, boolean> = {}) => ({
  authority: "SERVER_OWNED" as const,
  security_or_policy: false,
  migration: false,
  irreversible_side_effect: false,
  broad_public_contract_change: false,
  multi_module: false,
  new_architecture: false,
  deterministic_oracle: true,
  user_data: false,
  concurrency: false,
  external_side_effect: false,
  ...patch,
});

const completion = (
  status: "COMPLETED" | "BLOCKED" | "CANCELLED" | "WAITING_FOR_USER",
  summary: string,
): AgentCompletion =>
  agentCompletion.parse({
    schema_version: 1,
    run_id: "run-1",
    case_id: "case-1",
    status,
    summary,
    completed_steps: [],
    evidence: [],
    checkpoint_patch: {},
    next_actions: [],
    ...(status === "BLOCKED" ? { blocker_reason: summary } : {}),
    ...(status === "CANCELLED" ? { cancellation_reason: summary } : {}),
    ...(status === "WAITING_FOR_USER"
      ? {
          decision_request: {
            schema_version: 1,
            decision_id: "decision-1",
            case_id: "case-1",
            question: "Choose a direction",
            why_now: "Implementation cannot continue safely",
            options: [
              { id: "a", label: "A", consequences: "A consequence" },
              { id: "b", label: "B", consequences: "B consequence" },
            ],
            recommendation: "a",
            blocked_scope: "current run",
            checkpoint_revision: 1,
          },
        }
      : {}),
  });

const writerUnit = (status: WorkUnit["status"] = "DISPATCHED"): WorkUnit => ({
  schema_version: 1,
  work_unit_id: "unit-1",
  case_id: "case-1",
  role: "IMPLEMENTER",
  status,
  objective: "implement one bounded slice",
  authoritative_scope: {
    connection_ids: [],
    repo_allowlist: ["repo-1"],
    can_write_workspace: true,
  },
  run_id: "run-1",
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
});

class MemoryRuntimeStore implements RuntimePersistence {
  public state: RuntimeSnapshot["units"][number];
  public ambiguous = 0;

  public constructor(status: WorkUnit["status"] = "DISPATCHED") {
    this.state = {
      workUnit: writerUnit(status),
      run: { runId: "run-1", checkpointRevision: 1 },
      completion: null,
    };
  }

  public async listCaseIds(): Promise<readonly string[]> {
    return ["case-1"];
  }
  public async recover(): Promise<RuntimeSnapshot> {
    return { caseId: "case-1", checkpointRevision: 1, writerBlocked: true, units: [this.state] };
  }
  public async claim(): Promise<null> {
    return null;
  }
  public async start(): Promise<RuntimeUnit> {
    this.state = { ...this.state, workUnit: writerUnit("RUNNING") };
    return { workUnit: this.state.workUnit };
  }
  public async persistCompletion(input: {
    completion: AgentCompletion;
  }): Promise<{ replayed: boolean }> {
    this.state = { ...this.state, completion: input.completion };
    return { replayed: false };
  }
  public async finalize(input: {
    status: "COMPLETED" | "FAILED" | "CANCELLED";
  }): Promise<{ replayed: boolean }> {
    this.state = {
      ...this.state,
      workUnit: { ...this.state.workUnit, status: input.status } as WorkUnit,
    };
    return { replayed: false };
  }
  public async markAmbiguous(): Promise<void> {
    this.ambiguous += 1;
  }
}

class MemoryStagePort implements EngineeringRuntimePort {
  public readonly calls: string[] = [];
  public readonly bindings: EngineeringStageBinding[] = [];
  public readonly started: string[] = [];
  public readonly recovered = new Map<string, EngineeringRecoveredStage>();
  public terminalStage: string | null = null;
  public terminalStatus: "WAITING_FOR_USER" | "TERMINAL" = "WAITING_FOR_USER";
  public modelCallCost = 1;
  public cancelled = false;
  public controlReads = 0;
  public readonly session: EngineeringRuntimeSession;

  public constructor(processClass: "SMALL" | "MEDIUM" | "LARGE_OR_HIGH_RISK") {
    const facts =
      processClass === "LARGE_OR_HIGH_RISK"
        ? risk({ migration: true })
        : processClass === "MEDIUM"
          ? risk({ multi_module: true })
          : risk();
    this.session = {
      plan: planEngineeringWorkflow({ riskFacts: facts, checkpointRevision: 1 }),
      fingerprints: [],
      stageCalls: 0,
      maxStageCalls: 64,
      modelCalls: 0,
      maxModelCalls: 64,
      consecutiveRepeatLimit: 4,
      oscillationLimit: 4,
      deadlineMs: 2_000,
      cancelled: false,
    };
  }

  public async open(): Promise<EngineeringRuntimeSession> {
    return this.session;
  }
  public async readControlState(): Promise<{ readonly cancelled: boolean }> {
    this.controlReads += 1;
    return { cancelled: this.cancelled };
  }
  public async recoverStage(binding: EngineeringStageBinding): Promise<EngineeringRecoveredStage> {
    return this.recovered.get(binding.stage) ?? { status: "NOT_STARTED" };
  }
  public async prepareContext(binding: EngineeringStageBinding): Promise<unknown> {
    return { stage: binding.stage, fresh: true };
  }
  public async commitStarted(binding: EngineeringStageBinding): Promise<void> {
    this.started.push(binding.stage);
  }
  public async invokeAndRecord(input: {
    binding: EngineeringStageBinding;
  }): Promise<EngineeringStageCallResult> {
    this.calls.push(input.binding.stage);
    this.bindings.push(input.binding);
    if (this.terminalStage === input.binding.stage) {
      return this.terminalStatus === "WAITING_FOR_USER"
        ? {
            status: "WAITING_FOR_USER",
            completion: completion("WAITING_FOR_USER", "question"),
            modelCalls: this.modelCallCost,
          }
        : {
            status: "TERMINAL",
            completion: completion("BLOCKED", "blocked"),
            modelCalls: this.modelCallCost,
          };
    }
    return {
      status: "COMPLETED",
      evidence: stageEvidence(input.binding.stage),
      modelCalls: this.modelCallCost,
    };
  }
  public async completion(input: { code: string; detail: string }): Promise<AgentCompletion> {
    if (input.code === "COMPLETED") return completion("COMPLETED", input.detail);
    if (input.code === "CANCELLED") return completion("CANCELLED", input.detail);
    return completion("BLOCKED", `${input.code}:${input.detail}`);
  }
}

class GateCorrectionStagePort extends MemoryStagePort {
  public gateFailures = 0;
  public constructor(private readonly mode: "ORDINARY" | "COMPILER" = "ORDINARY") {
    super("SMALL");
  }
  public override async invokeAndRecord(input: {
    binding: EngineeringStageBinding;
  }): Promise<EngineeringStageCallResult> {
    if (input.binding.stage !== EngineeringStage.GATE_EXECUTION)
      return super.invokeAndRecord(input);
    this.calls.push(input.binding.stage);
    this.bindings.push(input.binding);
    this.gateFailures += 1;
    const evidence = stageEvidence(EngineeringStage.GATE_EXECUTION);
    return {
      status: "COMPLETED",
      modelCalls: 0,
      evidence: {
        ...evidence,
        gateFailureMode: this.mode,
        structuralState: {
          ...evidence.structuralState,
          treeDigest: sha(String(this.gateFailures % 10)),
          failedGateIds: ["qualification"],
          failedGateEvidenceDigests: [sha(String(this.gateFailures))],
        },
        slice: { ...evidence.slice, directive: "CORRECT_SLICE" as const },
      },
    };
  }
}

function stageEvidence(stage: string) {
  const index = Object.values(EngineeringStage).indexOf(stage as never) + 1;
  return {
    structuralState: {
      treeDigest: sha((index % 10).toString()),
      designRevisions: { [stage]: index },
      sliceRevision: index,
      failedGateIds: [],
      unresolvedFindingIds: [],
    },
    slice: {
      activeSliceId:
        Object.values(EngineeringStage).indexOf(stage as never) >=
        Object.values(EngineeringStage).indexOf(EngineeringStage.SLICE_PLANNING)
          ? "slice-1"
          : null,
      expectedSliceId: "slice-1",
      completedSliceIds:
        stage === EngineeringStage.SLICE_REVIEW ||
        stage === EngineeringStage.MEMORY_PROJECTION ||
        stage === EngineeringStage.FINAL_VERIFICATION ||
        stage === EngineeringStage.LOCAL_COMMIT
          ? ["slice-1"]
          : [],
      directive:
        stage === EngineeringStage.SLICE_REVIEW ||
        stage === EngineeringStage.MEMORY_PROJECTION ||
        stage === EngineeringStage.FINAL_VERIFICATION ||
        stage === EngineeringStage.LOCAL_COMMIT
          ? ("COMPLETE" as const)
          : ("CONTINUE" as const),
    },
    ...(stage === EngineeringStage.DESIGN_APPROVAL
      ? {
          approval: {
            checkpointRevision: 1,
            requiredArtifactNames: [
              "EngineeringOutcomeContract" as const,
              "EngineeringSystemDesign" as const,
              "EngineeringProgramDesign" as const,
            ],
            artifacts: [
              { name: "EngineeringOutcomeContract" as const, revision: 1, digest: sha("a") },
              { name: "EngineeringSystemDesign" as const, revision: 1, digest: sha("b") },
              { name: "EngineeringProgramDesign" as const, revision: 1, digest: sha("c") },
            ],
            unresolvedFindingIds: [],
            gatesPassed: true,
            evidenceVerified: true,
            modelDisposition: "APPROVE" as const,
            authorization: {
              authority: "OWNER_DECISION" as const,
              authorizationId: "decision-1",
              checkpointRevision: 1,
            },
          },
        }
      : {}),
  };
}

function scheduler() {
  let queued: { workUnitId: string; caseId: string; provider?: string } | null = null;
  return {
    enqueue(input: { workUnitId: string; caseId: string; provider?: string }): void {
      queued = input;
    },
    acquire() {
      const selected = queued;
      queued = null;
      if (!selected) return null;
      return { ...selected, provider: selected.provider ?? null, release: () => true };
    },
  };
}

function runtime(store: MemoryRuntimeStore, port: MemoryStagePort, now = 1_000) {
  return new SupervisorRuntime({
    persistence: store,
    roles: {},
    scheduler: scheduler(),
    makeRunId: () => "must-not-be-called",
    engineering: port,
    clock: () => now,
    executionTarget: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
    writerAuthority: {
      acquire: async () => ({ assertCurrent: async () => undefined }),
    },
    maxSteps: 1,
  });
}

describe("SupervisorRuntime engineering stage driver", () => {
  it("keeps gate correction budgets independent, recovery-safe, and slice-local", () => {
    const recovered = evaluateEngineeringGateCorrectionBudget({
      counts: { ordinary: 8, compiler: 0 },
      mode: "ORDINARY",
      alreadyCounted: true,
    });
    expect(recovered).toEqual({ disposition: "EXHAUSTED", counts: { ordinary: 8, compiler: 0 } });
    const recoveredBelowCap = evaluateEngineeringGateCorrectionBudget({
      counts: { ordinary: 7, compiler: 0 },
      mode: "ORDINARY",
      alreadyCounted: true,
    });
    expect(recoveredBelowCap).toEqual({
      disposition: "CONTINUE",
      counts: { ordinary: 7, compiler: 0 },
    });
    expect(
      evaluateEngineeringGateCorrectionBudget({
        counts: { ordinary: 8, compiler: 0 },
        mode: "COMPILER",
        alreadyCounted: false,
      }).disposition,
    ).toBe("CONTINUE");
    expect(
      evaluateEngineeringGateCorrectionBudget({
        counts: { ordinary: 0, compiler: 8 },
        mode: "ORDINARY",
        alreadyCounted: false,
      }).disposition,
    ).toBe("CONTINUE");
    expect(
      evaluateEngineeringGateCorrectionBudget({
        counts: { ordinary: 7, compiler: 0 },
        mode: "ORDINARY",
        alreadyCounted: false,
      }).disposition,
    ).toBe("EXHAUSTED");
    expect(
      evaluateEngineeringGateCorrectionBudget({
        counts: { ordinary: 0, compiler: 7 },
        mode: "COMPILER",
        alreadyCounted: false,
      }).disposition,
    ).toBe("EXHAUSTED");
    const freshSlice = evaluateEngineeringGateCorrectionBudget({
      counts: { ordinary: 0, compiler: 0 },
      mode: "ORDINARY",
      alreadyCounted: false,
    });
    expect(freshSlice).toEqual({ disposition: "CONTINUE", counts: { ordinary: 1, compiler: 0 } });
  });
  it("stops after eight same-slice gate corrections even when tree evidence changes", async () => {
    const store = new MemoryRuntimeStore();
    const port = new GateCorrectionStagePort();
    const result = await runtime(store, port).pumpOnce();
    expect(port.gateFailures).toBe(8);
    expect(
      port.calls.filter((stage) => stage === EngineeringStage.SLICE_IMPLEMENTATION),
    ).toHaveLength(8);
    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      blocker_reason: expect.stringContaining("GATE_CORRECTION_LIMIT_EXHAUSTED"),
    });
    expect(result.terminalReasonCode).toBe("GATE_CORRECTION_LIMIT_EXHAUSTED");
  });

  it("does not duplicate recovered gate progress before the next fresh boundary", async () => {
    const store = new MemoryRuntimeStore();
    const port = new GateCorrectionStagePort();
    const recoveredBase = stageEvidence(EngineeringStage.GATE_EXECUTION);
    const recoveredEvidence = {
      ...recoveredBase,
      gateFailureMode: "ORDINARY" as const,
      structuralState: {
        ...recoveredBase.structuralState,
        failedGateIds: ["qualification"],
        failedGateEvidenceDigests: [canonicalDigest("recovered")],
      },
      slice: { ...recoveredBase.slice, directive: "CORRECT_SLICE" as const },
    };
    Object.assign(port.session, {
      gateCorrectionCounts: [{ sliceId: "slice-1", ordinary: 7, compiler: 0 }],
    });
    const cycleFingerprint = engineeringGateFailureCycleFingerprint(
      recoveredEvidence.structuralState,
    );
    port.session.gateFailureCycleFingerprints = [
      cycleFingerprint,
      cycleFingerprint,
      cycleFingerprint,
      cycleFingerprint,
    ];
    port.recoverStage = async (binding) =>
      binding.stage === EngineeringStage.GATE_EXECUTION && binding.attempt === 1
        ? { status: "RECOVERED", evidence: recoveredEvidence }
        : { status: "NOT_STARTED" };
    const result = await runtime(store, port).pumpOnce();
    expect(
      port.calls.filter((stage) => stage === EngineeringStage.SLICE_IMPLEMENTATION),
    ).toHaveLength(2);
    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      blocker_reason: expect.stringContaining("GATE_CORRECTION_LIMIT_EXHAUSTED"),
    });
    expect(result.terminalReasonCode).toBe("GATE_CORRECTION_LIMIT_EXHAUSTED");
  });
  it("reconstructs three persistent diagnostics and stops a recovered boundary", async () => {
    const store = new MemoryRuntimeStore();
    const port = new GateCorrectionStagePort();
    const base = stageEvidence(EngineeringStage.GATE_EXECUTION);
    const evidence = {
      ...base,
      gateFailureMode: "COMPILER" as const,
      structuralState: {
        ...base.structuralState,
        failedGateIds: ["qualification"],
        stableGateDiagnosticFingerprints: ["slice-1:diagnostic"],
      },
      slice: { ...base.slice, directive: "CORRECT_SLICE" as const },
    };
    port.session.gateFailureDiagnosticHistory = [
      ["slice-1:diagnostic"],
      ["slice-1:diagnostic"],
      ["slice-1:diagnostic"],
    ];
    port.recoverStage = async (binding) =>
      binding.stage === EngineeringStage.GATE_EXECUTION && binding.attempt === 1
        ? { status: "RECOVERED", evidence }
        : { status: "NOT_STARTED" };
    const result = await runtime(store, port).pumpOnce();
    expect(result.terminalReasonCode).toBe("NO_PROGRESS");
    expect(port.gateFailures).toBe(0);
    expect(port.calls.filter((stage) => stage === EngineeringStage.GATE_EXECUTION)).toHaveLength(0);
  });

  it.each(["SMALL", "MEDIUM", "LARGE_OR_HIGH_RISK"] as const)(
    "executes exactly the registry graph for %s",
    async (processClass) => {
      const store = new MemoryRuntimeStore();
      const port = new MemoryStagePort(processClass);
      const result = await runtime(store, port).pumpOnce();
      expect(result).toMatchObject({ progressed: 1, ambiguous: [], blocked: [], waiting: [] });
      expect(port.calls).toEqual(port.session.plan.stages);
      expect(port.started).toEqual(port.session.plan.stages);
      expect(store.state.completion?.status).toBe("COMPLETED");
    },
  );

  it("blocks high-risk implementation when deterministic approval evidence is absent", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("LARGE_OR_HIGH_RISK");
    const original = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await original(input);
      if (input.binding.stage !== EngineeringStage.DESIGN_APPROVAL || result.status !== "COMPLETED")
        return result;
      return {
        status: "COMPLETED",
        evidence: { structuralState: result.evidence.structuralState },
        modelCalls: result.modelCalls,
      };
    };
    await runtime(store, port).pumpOnce();
    expect(port.calls).not.toContain(EngineeringStage.SLICE_IMPLEMENTATION);
    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      blocker_reason: expect.stringContaining("APPROVAL_BLOCKED"),
    });
  });

  it("recovers confirmed stages without a model call and stops STARTED/no-receipt as ambiguous", async () => {
    const store = new MemoryRuntimeStore("RUNNING");
    const port = new MemoryStagePort("SMALL");
    port.recovered.set(EngineeringStage.DISCOVERY, {
      status: "RECOVERED",
      evidence: stageEvidence(EngineeringStage.DISCOVERY),
    });
    port.recovered.set(EngineeringStage.SLICE_PLANNING, {
      status: "AMBIGUOUS",
      detail: "STARTED without receipt",
    });
    const result = await runtime(store, port).pumpOnce();
    expect(port.calls).toEqual([]);
    expect(result.ambiguous).toEqual(["unit-1"]);
    expect(store.ambiguous).toBe(1);
  });

  it("refreshes durable cancellation between stages and stops before the next STARTED", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (input.binding.stage === EngineeringStage.DISCOVERY) port.cancelled = true;
      return result;
    };

    await runtime(store, port).pumpOnce();

    expect(port.calls).toEqual([EngineeringStage.DISCOVERY]);
    expect(port.started).toEqual([EngineeringStage.DISCOVERY]);
    expect(port.controlReads).toBeGreaterThanOrEqual(2);
    expect(store.state.completion).toMatchObject({
      status: "CANCELLED",
      summary: expect.stringContaining("CANCELLED"),
    });
  });

  it("recovers an unknown started effect before cancellation can terminate the run", async () => {
    const store = new MemoryRuntimeStore("RUNNING");
    const port = new MemoryStagePort("SMALL");
    port.cancelled = true;
    port.recovered.set(EngineeringStage.DISCOVERY, {
      status: "AMBIGUOUS",
      detail: "STARTED without receipt",
    });

    const result = await runtime(store, port).pumpOnce();

    expect(result.ambiguous).toEqual(["unit-1"]);
    expect(store.ambiguous).toBe(1);
    expect(store.state.completion).toBeNull();
    expect(port.calls).toEqual([]);
  });

  it("persists a question as a terminal old run and never advances later stages", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    port.terminalStage = EngineeringStage.DISCOVERY;
    const result = await runtime(store, port).pumpOnce();
    expect(result.waiting).toEqual(["unit-1"]);
    expect(port.calls).toEqual([EngineeringStage.DISCOVERY]);
    expect(store.state.completion?.status).toBe("WAITING_FOR_USER");

    const replayPort = new MemoryStagePort("SMALL");
    await runtime(store, replayPort).pumpOnce();
    expect(replayPort.calls).toEqual([]);
  });

  it("maps cancellation, deadline, call limit, no-progress and oscillation to distinct terminals", async () => {
    const variants = [
      ["CANCELLED", { cancelled: true }],
      ["DEADLINE_EXCEEDED", { deadlineMs: 1_000 }],
      ["STAGE_LIMIT_EXHAUSTED", { stageCalls: 64 }],
      ["CALL_LIMIT_EXHAUSTED", { modelCalls: 64 }],
      ["NO_PROGRESS", { fingerprints: ["x", "x", "x", "x", "x"] }],
      ["OSCILLATION", { fingerprints: ["x", "y", "x", "y", "x", "y"] }],
    ] as const;
    for (const [code, patch] of variants) {
      const store = new MemoryRuntimeStore();
      const port = new MemoryStagePort("SMALL");
      Object.assign(port, { session: { ...port.session, ...patch } });
      await runtime(store, port).pumpOnce();
      expect(store.state.completion).toMatchObject({
        status: code === "CANCELLED" ? "CANCELLED" : "BLOCKED",
        summary: expect.stringContaining(code),
      });
      expect(port.calls).toEqual([]);
    }
  });

  it("counts stage executions separately from actual model calls", async () => {
    const stageStore = new MemoryRuntimeStore();
    const stagePort = new MemoryStagePort("SMALL");
    Object.assign(stagePort, {
      session: { ...stagePort.session, maxStageCalls: 1 },
    });
    await runtime(stageStore, stagePort).pumpOnce();
    expect(stagePort.calls).toEqual([EngineeringStage.DISCOVERY]);
    expect(stageStore.state.completion?.summary).toContain("STAGE_LIMIT_EXHAUSTED");

    const modelStore = new MemoryRuntimeStore();
    const modelPort = new MemoryStagePort("SMALL");
    modelPort.modelCallCost = 2;
    Object.assign(modelPort, {
      session: { ...modelPort.session, maxModelCalls: 2 },
    });
    await runtime(modelStore, modelPort).pumpOnce();
    expect(modelPort.calls).toEqual([EngineeringStage.DISCOVERY]);
    expect(modelStore.state.completion?.summary).toContain("CALL_LIMIT_EXHAUSTED");
  });

  it("samples structural progress at review boundaries so A/B corrections oscillate", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (result.status !== "COMPLETED") return result;
      const tree = input.binding.attempt % 2 === 1 ? sha("a") : sha("b");
      return {
        ...result,
        evidence: {
          structuralState: {
            treeDigest: tree,
            designRevisions: {},
            sliceRevision: 1,
            failedGateIds: [],
            unresolvedFindingIds: ["finding-stable"],
          },
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: [],
            directive:
              input.binding.stage === EngineeringStage.SLICE_REVIEW
                ? ("CORRECT_SLICE" as const)
                : ("CONTINUE" as const),
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();

    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      summary: expect.stringContaining("OSCILLATION"),
    });
    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.SLICE_REVIEW),
    ).toHaveLength(6);
  });

  it("stops a review A/B tree cycle even when fresh finding identities change", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (result.status !== "COMPLETED") return result;
      return {
        ...result,
        evidence: {
          structuralState: {
            treeDigest: input.binding.attempt % 2 === 1 ? sha("a") : sha("b"),
            designRevisions: {},
            sliceRevision: 1,
            failedGateIds: [],
            unresolvedFindingIds: [`finding-${String(input.binding.attempt)}`],
          },
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: [],
            directive:
              input.binding.stage === EngineeringStage.SLICE_REVIEW
                ? ("CORRECT_SLICE" as const)
                : ("CONTINUE" as const),
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();

    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      summary: expect.stringContaining("OSCILLATION"),
    });
    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.SLICE_REVIEW),
    ).toHaveLength(6);
  });

  it("stops an A/B required-gate tree cycle even when every compiler log digest changes", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (
        result.status !== "COMPLETED" ||
        input.binding.stage !== EngineeringStage.GATE_EXECUTION
      ) {
        return result;
      }
      return {
        ...result,
        evidence: {
          structuralState: {
            treeDigest: input.binding.attempt % 2 === 1 ? sha("a") : sha("b"),
            designRevisions: {},
            sliceRevision: 1,
            failedGateIds: ["swift-compile"],
            failedGateEvidenceDigests: [sha(String(input.binding.attempt))],
            unresolvedFindingIds: [],
          },
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: [],
            directive: "CORRECT_SLICE" as const,
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();

    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      summary: expect.stringContaining("OSCILLATION"),
    });
    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.GATE_EXECUTION),
    ).toHaveLength(6);
  });

  it("gives an unchanged required-gate receipt the configured correction budget before no-progress", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (
        result.status !== "COMPLETED" ||
        input.binding.stage !== EngineeringStage.GATE_EXECUTION
      ) {
        return result;
      }
      return {
        ...result,
        evidence: {
          structuralState: {
            treeDigest: sha(String(input.binding.attempt % 10)),
            designRevisions: {},
            sliceRevision: 1,
            failedGateIds: ["flow-integration"],
            failedGateEvidenceDigests: [sha("f")],
            stableGateDiagnosticFingerprints: ["stable-flow-diagnostic"],
            unresolvedFindingIds: [],
          },
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: [],
            directive: "CORRECT_SLICE" as const,
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();

    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      summary: expect.stringContaining("NO_PROGRESS"),
    });
    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.GATE_EXECUTION),
    ).toHaveLength(3);
  });

  it("stops fresh compiler correction on the second identical diagnostic boundary", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (result.status !== "COMPLETED" || input.binding.stage !== EngineeringStage.GATE_EXECUTION)
        return result;
      return {
        ...result,
        evidence: {
          ...result.evidence,
          gateFailureMode: "COMPILER" as const,
          structuralState: {
            ...result.evidence.structuralState,
            failedGateIds: ["swift-compile"],
            stableGateDiagnosticFingerprints: ["stable-compiler-diagnostic"],
          },
          slice: { ...result.evidence.slice, directive: "CORRECT_SLICE" as const },
        },
      };
    };

    const result = await runtime(store, port).pumpOnce();

    expect(result.terminalReasonCode).toBe("NO_PROGRESS");
    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.GATE_EXECUTION),
    ).toHaveLength(2);
    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.SLICE_IMPLEMENTATION),
    ).toHaveLength(2);
  });

  it("continues compiler correction when the diagnostic set is reduced", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const invoke = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await invoke(input);
      if (result.status !== "COMPLETED" || input.binding.stage !== EngineeringStage.GATE_EXECUTION)
        return result;
      const fingerprints = input.binding.attempt === 1 ? ["a", "b"] : ["a"];
      return {
        ...result,
        evidence: {
          ...result.evidence,
          gateFailureMode: "COMPILER" as const,
          structuralState: {
            ...result.evidence.structuralState,
            failedGateIds: ["swift-compile"],
            stableGateDiagnosticFingerprints: fingerprints,
          },
          slice: { ...result.evidence.slice, directive: "CORRECT_SLICE" as const },
        },
      };
    };

    const result = await runtime(store, port).pumpOnce();

    expect(
      port.bindings.filter((binding) => binding.stage === EngineeringStage.GATE_EXECUTION),
    ).toHaveLength(3);
    expect(result.terminalReasonCode).toBe("NO_PROGRESS");
  });

  it("executes two slices in ProgramDesign order before verification and local commit", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("MEDIUM");
    const original = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await original(input);
      if (result.status !== "COMPLETED") return result;
      const second = input.binding.attempt === 2;
      const activeSliceId = second ? "slice-2" : "slice-1";
      const afterReview =
        input.binding.stage === EngineeringStage.SLICE_REVIEW ||
        input.binding.stage === EngineeringStage.MEMORY_PROJECTION ||
        input.binding.stage === EngineeringStage.FINAL_VERIFICATION ||
        input.binding.stage === EngineeringStage.LOCAL_COMMIT;
      return {
        ...result,
        evidence: {
          ...result.evidence,
          slice: {
            activeSliceId,
            expectedSliceId: afterReview && !second ? "slice-2" : activeSliceId,
            completedSliceIds: afterReview
              ? second
                ? ["slice-1", "slice-2"]
                : ["slice-1"]
              : second
                ? ["slice-1"]
                : [],
            directive: afterReview ? (second ? "COMPLETE" : "NEXT_SLICE") : "CONTINUE",
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();
    expect(
      port.bindings
        .filter((binding) => binding.stage === EngineeringStage.SLICE_PLANNING)
        .map((binding) => binding.attempt),
    ).toEqual([1, 2]);
    expect(port.calls.slice(-2)).toEqual([
      EngineeringStage.FINAL_VERIFICATION,
      EngineeringStage.LOCAL_COMMIT,
    ]);
    expect(store.state.completion?.status).toBe("COMPLETED");
  });

  it("corrects the same slice at attempt >1 without replaying slice planning", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const original = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await original(input);
      if (result.status !== "COMPLETED") return result;
      const reviewBoundary =
        input.binding.stage === EngineeringStage.SLICE_REVIEW ||
        input.binding.stage === EngineeringStage.MEMORY_PROJECTION ||
        input.binding.stage === EngineeringStage.FINAL_VERIFICATION ||
        input.binding.stage === EngineeringStage.LOCAL_COMMIT;
      const correction =
        input.binding.stage === EngineeringStage.SLICE_REVIEW && input.binding.attempt === 1;
      return {
        ...result,
        evidence: {
          ...result.evidence,
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: reviewBoundary && !correction ? ["slice-1"] : [],
            directive: correction ? "CORRECT_SLICE" : reviewBoundary ? "COMPLETE" : "CONTINUE",
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();
    expect(
      port.bindings
        .filter((binding) => binding.stage === EngineeringStage.SLICE_PLANNING)
        .map((binding) => binding.attempt),
    ).toEqual([1]);
    expect(
      port.bindings
        .filter((binding) => binding.stage === EngineeringStage.SLICE_IMPLEMENTATION)
        .map((binding) => binding.attempt),
    ).toEqual([1, 2]);
    expect(store.state.completion?.status).toBe("COMPLETED");
  });

  it("corrects a failed required gate before review without replaying slice planning", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const original = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await original(input);
      if (result.status !== "COMPLETED") return result;
      const failedGate =
        input.binding.stage === EngineeringStage.GATE_EXECUTION && input.binding.attempt === 1;
      const afterReview =
        input.binding.stage === EngineeringStage.SLICE_REVIEW ||
        input.binding.stage === EngineeringStage.MEMORY_PROJECTION ||
        input.binding.stage === EngineeringStage.FINAL_VERIFICATION ||
        input.binding.stage === EngineeringStage.LOCAL_COMMIT;
      return {
        ...result,
        evidence: {
          ...result.evidence,
          structuralState: {
            ...result.evidence.structuralState,
            failedGateIds: failedGate ? ["compile"] : [],
          },
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: afterReview ? ["slice-1"] : [],
            directive: failedGate ? "CORRECT_SLICE" : afterReview ? "COMPLETE" : "CONTINUE",
          },
        },
      };
    };

    await runtime(store, port).pumpOnce();

    expect(
      port.bindings
        .filter((binding) => binding.stage === EngineeringStage.SLICE_PLANNING)
        .map((binding) => binding.attempt),
    ).toEqual([1]);
    expect(
      port.bindings
        .filter((binding) => binding.stage === EngineeringStage.SLICE_IMPLEMENTATION)
        .map((binding) => binding.attempt),
    ).toEqual([1, 2]);
    expect(
      port.bindings
        .filter((binding) => binding.stage === EngineeringStage.SLICE_REVIEW)
        .map((binding) => binding.attempt),
    ).toEqual([2]);
    expect(store.state.completion?.status).toBe("COMPLETED");
  });

  it("stops a correction before another write stage can change slice identity", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const original = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await original(input);
      if (result.status !== "COMPLETED") return result;
      if (input.binding.stage === EngineeringStage.SLICE_REVIEW && input.binding.attempt === 1) {
        return {
          ...result,
          evidence: {
            ...result.evidence,
            slice: {
              activeSliceId: "slice-1",
              expectedSliceId: "slice-1",
              completedSliceIds: [],
              directive: "CORRECT_SLICE",
            },
          },
        };
      }
      if (
        input.binding.stage === EngineeringStage.SLICE_IMPLEMENTATION &&
        input.binding.attempt === 2
      ) {
        return {
          ...result,
          evidence: {
            ...result.evidence,
            slice: {
              activeSliceId: "slice-2",
              expectedSliceId: "slice-2",
              completedSliceIds: [],
              directive: "CONTINUE",
            },
          },
        };
      }
      return result;
    };

    await runtime(store, port).pumpOnce();
    expect(store.state.completion).toMatchObject({
      status: "BLOCKED",
      summary: expect.stringContaining("SLICE_BLOCKED"),
    });
    expect(
      port.bindings.some(
        (binding) => binding.stage === EngineeringStage.GATE_EXECUTION && binding.attempt === 2,
      ),
    ).toBe(false);
    expect(port.calls).not.toContain(EngineeringStage.LOCAL_COMMIT);
  });

  it("stops a server-derived BLOCKED review before memory, verification or commit", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    const original = port.invokeAndRecord.bind(port);
    port.invokeAndRecord = async (input) => {
      const result = await original(input);
      if (result.status !== "COMPLETED" || input.binding.stage !== EngineeringStage.SLICE_REVIEW)
        return result;
      return {
        ...result,
        evidence: {
          ...result.evidence,
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            completedSliceIds: [],
            directive: "STOP",
          },
        },
      };
    };
    await runtime(store, port).pumpOnce();
    expect(store.state.completion).toMatchObject({ status: "BLOCKED" });
    expect(port.calls).not.toContain(EngineeringStage.MEMORY_PROJECTION);
    expect(port.calls).not.toContain(EngineeringStage.LOCAL_COMMIT);
  });

  it("never reaches local commit when final verification is terminal", async () => {
    const store = new MemoryRuntimeStore();
    const port = new MemoryStagePort("SMALL");
    port.terminalStage = EngineeringStage.FINAL_VERIFICATION;
    port.terminalStatus = "TERMINAL";
    await runtime(store, port).pumpOnce();
    expect(port.calls).toContain(EngineeringStage.FINAL_VERIFICATION);
    expect(port.calls).not.toContain(EngineeringStage.LOCAL_COMMIT);
    expect(store.state.completion?.status).toBe("BLOCKED");
  });
});

describe("engineering workflow policy", () => {
  it("selects all three risk graphs and never accepts a downgrade", () => {
    const small = planEngineeringWorkflow({ riskFacts: risk(), checkpointRevision: 4 });
    expect(small).toMatchObject({
      minimumProcessClass: "SMALL",
      processClass: "SMALL",
    });
    expect(small.stages[0]).toBe(EngineeringStage.DISCOVERY);
    expect(small.stages).toContain(EngineeringStage.FINAL_VERIFICATION);
    expect(
      planEngineeringWorkflow({ riskFacts: risk({ multi_module: true }), checkpointRevision: 4 }),
    ).toMatchObject({ minimumProcessClass: "MEDIUM", processClass: "MEDIUM" });
    expect(
      planEngineeringWorkflow({ riskFacts: risk({ migration: true }), checkpointRevision: 4 }),
    ).toMatchObject({
      minimumProcessClass: "LARGE_OR_HIGH_RISK",
      processClass: "LARGE_OR_HIGH_RISK",
    });
    expect(() =>
      planEngineeringWorkflow({
        riskFacts: risk({ migration: true }),
        proposedProcessClass: "SMALL",
        checkpointRevision: 4,
      }),
    ).toThrow(/below deterministic minimum/);
  });

  it("accepts only an exact durable owner escalation and never a downgrade", () => {
    const escalation = {
      authority: "OWNER_DECISION",
      decisionId: "decision-4",
      checkpointRevision: 4,
      processClass: "LARGE_OR_HIGH_RISK",
    } as const;
    expect(
      planEngineeringWorkflow({
        riskFacts: risk(),
        checkpointRevision: 4,
        ownerEscalation: escalation,
      }),
    ).toMatchObject({ processClass: "LARGE_OR_HIGH_RISK", ownerDecisionId: "decision-4" });
    expect(() =>
      planEngineeringWorkflow({
        riskFacts: risk(),
        checkpointRevision: 5,
        ownerEscalation: escalation,
      }),
    ).toThrow(/revision mismatch/);
    expect(() =>
      planEngineeringWorkflow({
        riskFacts: risk({ multi_module: true }),
        checkpointRevision: 4,
        ownerEscalation: { ...escalation, processClass: "SMALL" },
      }),
    ).toThrow(/cannot downgrade/);
    expect(() =>
      planEngineeringWorkflow({
        riskFacts: risk(),
        checkpointRevision: 4,
        ownerEscalation: { ...escalation, modelApproved: true },
      }),
    ).toThrow(/unknown or missing fields/);
  });

  it("does not turn model approval into deterministic authority", () => {
    const artifacts = [
      { name: "EngineeringSystemDesign" as const, revision: 7, digest: sha("a") },
      { name: "EngineeringProgramDesign" as const, revision: 7, digest: sha("b") },
    ];
    const base = {
      checkpointRevision: 7,
      requiredArtifactNames: [
        "EngineeringSystemDesign" as const,
        "EngineeringProgramDesign" as const,
      ],
      artifacts,
      unresolvedFindingIds: [],
      gatesPassed: true,
      evidenceVerified: true,
      modelDisposition: "APPROVE" as const,
    };
    expect(evaluateEngineeringApproval(base)).toEqual({
      disposition: "BLOCKED",
      reasons: ["AUTHORIZATION_MISSING"],
    });
    expect(
      evaluateEngineeringApproval({
        ...base,
        gatesPassed: false,
        evidenceVerified: false,
      }),
    ).toEqual({
      disposition: "BLOCKED",
      reasons: ["AUTHORIZATION_MISSING", "EVIDENCE_NOT_VERIFIED", "GATES_NOT_PASSED"].sort(),
    });
    expect(
      evaluateEngineeringApproval({
        ...base,
        authorization: {
          authority: "OWNER_DECISION",
          authorizationId: "decision-7",
          checkpointRevision: 7,
        },
      }),
    ).toEqual({ disposition: "APPROVED", authorizationId: "decision-7" });
    expect(
      evaluateEngineeringApproval({
        ...base,
        artifacts: [{ ...artifacts[0]!, revision: 6 }, artifacts[1]!],
        unresolvedFindingIds: ["finding-1"],
        authorization: {
          authority: "POLICY_GRANT",
          authorizationId: "policy-7",
          checkpointRevision: 6,
        },
      }),
    ).toEqual({
      disposition: "BLOCKED",
      reasons: [
        "ARTIFACT_REVISION_MISMATCH",
        "AUTHORIZATION_REVISION_MISMATCH",
        "UNRESOLVED_FINDINGS",
      ],
    });
  });

  it("fingerprints structural state and ignores prose/order noise", () => {
    const base = {
      treeDigest: sha("1"),
      designRevisions: { system: 2, program: 3 },
      sliceRevision: 4,
      failedGateIds: ["gate-b", "gate-a"],
      unresolvedFindingIds: ["finding-b", "finding-a"],
      narrative: "first explanation",
    };
    expect(engineeringStructuralFingerprint(base)).toBe(
      engineeringStructuralFingerprint({
        ...base,
        designRevisions: { program: 3, system: 2 },
        failedGateIds: ["gate-a", "gate-b", "gate-a"],
        unresolvedFindingIds: ["finding-a", "finding-b"],
        narrative: "completely different prose",
      }),
    );
    expect(engineeringStructuralFingerprint(base)).not.toBe(
      engineeringStructuralFingerprint({ ...base, sliceRevision: 5 }),
    );
  });

  it("fingerprints review cycles without volatile finding identities", () => {
    const base = {
      treeDigest: sha("1"),
      designRevisions: { system: 2, program: 3 },
      sliceRevision: 4,
      failedGateIds: [],
      unresolvedFindingIds: ["finding-a"],
    };
    expect(engineeringReviewCycleFingerprint(base)).toBe(
      engineeringReviewCycleFingerprint({
        ...base,
        unresolvedFindingIds: ["finding-b", "finding-c"],
      }),
    );
    expect(engineeringReviewCycleFingerprint(base)).not.toBe(
      engineeringReviewCycleFingerprint({ ...base, treeDigest: sha("2") }),
    );
  });

  it("treats an unchanged exact gate failure as no progress even when the tree changes", () => {
    const base = {
      treeDigest: sha("1"),
      designRevisions: { system: 2, program: 3 },
      sliceRevision: 4,
      failedGateIds: ["gate-b", "gate-a"],
      failedGateEvidenceDigests: [sha("8"), sha("7")],
      unresolvedFindingIds: [],
    };
    expect(engineeringGateFailureFingerprint(base)).toBe(
      engineeringGateFailureFingerprint({
        ...base,
        treeDigest: sha("2"),
        failedGateIds: ["gate-a", "gate-b"],
        failedGateEvidenceDigests: [sha("7"), sha("8"), sha("7")],
      }),
    );
    expect(engineeringGateFailureFingerprint(base)).not.toBe(
      engineeringGateFailureFingerprint({
        ...base,
        treeDigest: sha("2"),
        failedGateEvidenceDigests: [sha("9")],
      }),
    );
    expect(() =>
      engineeringGateFailureFingerprint({
        ...base,
        failedGateEvidenceDigests: ["not-a-digest"],
      }),
    ).toThrow("gate evidence digest must be sha256");
    expect(engineeringGateFailureCycleFingerprint(base)).toBe(
      engineeringGateFailureCycleFingerprint({
        ...base,
        failedGateEvidenceDigests: [sha("9")],
      }),
    );
    expect(engineeringGateFailureCycleFingerprint(base)).not.toBe(
      engineeringGateFailureCycleFingerprint({ ...base, treeDigest: sha("2") }),
    );
  });

  it("stops after three consecutive shared stable gate diagnostics", () => {
    expect(evaluateStableGateDiagnosticPersistence([["a"]])).toBe("CONTINUE");
    expect(evaluateStableGateDiagnosticPersistence([["a"], ["a"]])).toBe("CONTINUE");
    expect(evaluateStableGateDiagnosticPersistence([["a"], ["a"], ["a"]])).toBe("NO_PROGRESS");
    expect(evaluateStableGateDiagnosticPersistence([["a"], ["a"], ["b"]])).toBe("CONTINUE");
    expect(evaluateStableGateDiagnosticPersistence([["a"], ["a"], []])).toBe("CONTINUE");
  });

  it("distinguishes cancellation, deadline, exhaustion, no-progress, and oscillation", () => {
    const base = {
      fingerprints: ["a", "b"],
      stageCalls: 2,
      maxStageCalls: 10,
      modelCalls: 2,
      maxModelCalls: 10,
      consecutiveRepeatLimit: 2,
      oscillationLimit: 2,
      nowMs: 100,
      deadlineMs: 200,
      cancelled: false,
    };
    expect(evaluateEngineeringProgress(base)).toBe("CONTINUE");
    expect(evaluateEngineeringProgress({ ...base, cancelled: true })).toBe("CANCELLED");
    expect(evaluateEngineeringProgress({ ...base, nowMs: 200 })).toBe("DEADLINE_EXCEEDED");
    expect(evaluateEngineeringProgress({ ...base, stageCalls: 10 })).toBe("STAGE_LIMIT_EXHAUSTED");
    expect(evaluateEngineeringProgress({ ...base, modelCalls: 10 })).toBe("CALL_LIMIT_EXHAUSTED");
    expect(evaluateEngineeringProgress({ ...base, fingerprints: ["a", "a", "a"] })).toBe(
      "NO_PROGRESS",
    );
    expect(evaluateEngineeringProgress({ ...base, fingerprints: ["a", "b", "a", "b"] })).toBe(
      "OSCILLATION",
    );
  });
});
