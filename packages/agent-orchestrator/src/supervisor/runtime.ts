import {
  agentCompletion,
  ROLE_CAN_WRITE_WORKSPACE,
  type AgentCompletion,
  type AgentRole,
  type WorkUnit,
} from "@remoteagent/contracts";

import { mergeReadOnlyResults, type ReadOnlyMerge } from "./merge.js";

/** The durable identity of a run. Timestamps are deliberately absent. */
export interface RuntimeRun {
  readonly runId: string;
  readonly checkpointRevision: number;
  readonly triggerEventId?: string | null;
  readonly model?: { readonly provider: string; readonly model_id: string } | null;
}

export interface RuntimeUnit {
  readonly workUnit: WorkUnit;
  readonly provider?: string;
}

export interface RuntimeUnitState extends RuntimeUnit {
  readonly run: RuntimeRun | null;
  /** A confirmed completion is the only safe evidence that a RUNNING unit ran. */
  readonly completion: AgentCompletion | null;
}

export interface RuntimeSnapshot {
  readonly caseId: string;
  /** Current durable checkpoint revision used for a fresh claim. */
  readonly checkpointRevision?: number;
  /** A durable unresolved writer blocks every later writer in this case. */
  readonly writerBlocked?: boolean;
  readonly units: readonly RuntimeUnitState[];
}

export interface RuntimeClaim {
  readonly unit: RuntimeUnit;
  readonly run: RuntimeRun;
}

export interface RuntimeCompletionResult {
  /** True means the durable completion already existed with the same identity. */
  readonly replayed: boolean;
}

export interface RuntimePersistence {
  readonly listCaseIds: () => Promise<readonly string[]>;
  readonly recover: (caseId: string) => Promise<RuntimeSnapshot>;
  readonly claim: (input: {
    readonly workUnitId: string;
    readonly runId: string;
    readonly checkpointRevision: number;
    readonly triggerEventId?: string | null;
    readonly model?: { readonly provider: string; readonly model_id: string };
  }) => Promise<RuntimeClaim | null>;
  readonly start: (input: {
    readonly workUnitId: string;
    readonly runId: string;
  }) => Promise<RuntimeUnit>;
  readonly persistCompletion: (input: {
    readonly unit: RuntimeUnit;
    readonly run: RuntimeRun;
    readonly completion: AgentCompletion;
  }) => Promise<RuntimeCompletionResult>;
  readonly finalize: (input: {
    readonly workUnitId: string;
    readonly runId: string;
    readonly status: "COMPLETED" | "FAILED" | "CANCELLED";
  }) => Promise<{ readonly replayed: boolean }>;
  /** Record an unresolved model/tool outcome; recovery must never replay it. */
  readonly markAmbiguous?: (input: {
    readonly workUnitId: string;
    readonly runId: string;
    readonly reason: string;
  }) => Promise<void>;
  /** RA-008 answer materialization; the returned pending unit is enqueued. */
  readonly resumeAnswer?: (input: unknown) => Promise<RuntimeUnitState | null>;
}

export interface RuntimeRoleInput {
  readonly unit: RuntimeUnit;
  readonly run: RuntimeRun;
  readonly writerFence?: RuntimeWriterFence;
}

export interface RuntimeRole {
  readonly invoke: (input: RuntimeRoleInput) => Promise<unknown>;
}

export type RuntimeRoles = Readonly<Partial<Record<AgentRole, RuntimeRole>>>;

export interface RuntimeWriterFence {
  readonly assertCurrent: () => Promise<void>;
  /** Release the durable writer lease after the bounded attempt, including faults. */
  readonly release?: () => Promise<void>;
}

export interface RuntimeWriterAuthority {
  readonly acquire: (input: {
    readonly unit: WorkUnit;
    readonly run: RuntimeRun;
  }) => Promise<RuntimeWriterFence>;
}

export interface RuntimeOptions {
  readonly persistence: RuntimePersistence;
  readonly roles: RuntimeRoles;
  readonly scheduler: {
    readonly enqueue: (unit: {
      readonly workUnitId: string;
      readonly caseId: string;
      readonly provider?: string;
    }) => void;
    readonly acquire: () => RuntimeSchedulerLease | null;
  };
  readonly makeRunId: (unit: RuntimeUnit) => string;
  readonly writerAuthority?: RuntimeWriterAuthority;
  readonly maxSteps?: number;
}

interface RuntimeSchedulerLease {
  readonly workUnitId: string;
  readonly caseId: string;
  readonly provider: string | null;
  readonly release: () => boolean;
}

export interface RuntimePumpResult {
  readonly progressed: number;
  readonly ambiguous: readonly string[];
  readonly blocked: readonly string[];
  readonly waiting: readonly string[];
  readonly merges: readonly ReadOnlyMerge[];
}

export class RuntimeInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RuntimeInvariantError";
  }
}

/**
 * A bounded supervisor driver. It never invents state: every claim, start,
 * completion and finalization is delegated to the durable persistence port.
 * The scheduler is only a rebuildable capacity cache.
 */
export class SupervisorRuntime {
  readonly #persistence: RuntimePersistence;
  readonly #roles: RuntimeRoles;
  readonly #scheduler: RuntimeOptions["scheduler"];
  readonly #makeRunId: RuntimeOptions["makeRunId"];
  readonly #writerAuthority: RuntimeWriterAuthority | undefined;
  readonly #maxSteps: number;
  readonly #units = new Map<string, RuntimeUnitState>();
  readonly #checkpointRevisions = new Map<string, number>();
  readonly #queued = new Set<string>();
  readonly #ambiguous = new Set<string>();
  readonly #blockedCases = new Set<string>();
  readonly #blockedUnits = new Set<string>();
  readonly #deferredLeases = new Map<string, RuntimeSchedulerLease>();
  #recovery: Promise<void> | null = null;
  #pump: Promise<RuntimePumpResult> | null = null;

  public constructor(options: RuntimeOptions) {
    if (!Number.isSafeInteger(options.maxSteps ?? 1) || (options.maxSteps ?? 1) < 1) {
      throw new RuntimeInvariantError("maxSteps must be a positive safe integer");
    }
    this.#persistence = options.persistence;
    this.#roles = options.roles;
    this.#scheduler = options.scheduler;
    this.#makeRunId = options.makeRunId;
    this.#writerAuthority = options.writerAuthority;
    this.#maxSteps = options.maxSteps ?? 1;
  }

  /** Rebuilds the in-memory queue from durable state, once per runtime instance. */
  public async recover(): Promise<void> {
    if (this.#recovery) return this.#recovery;
    this.#recovery = this.recoverImpl();
    try {
      await this.#recovery;
    } catch (error) {
      this.#recovery = null;
      throw error;
    }
  }

  public async pumpOnce(): Promise<RuntimePumpResult> {
    if (this.#pump) return this.#pump;
    this.#pump = this.pumpImpl();
    try {
      return await this.#pump;
    } finally {
      this.#pump = null;
    }
  }

  /** Materialize an answer as a fresh durable run; the old WAITING run is never resumed. */
  public async answer(input: unknown): Promise<RuntimeUnitState> {
    await this.recover();
    if (!this.#persistence.resumeAnswer)
      throw new RuntimeInvariantError("answer materialization is not configured");
    const state = await this.#persistence.resumeAnswer(input);
    if (!state) throw new RuntimeInvariantError("answer did not create a pending run");
    if (state.workUnit.status !== "PENDING" || state.workUnit.run_id !== null)
      throw new RuntimeInvariantError("resume answer must create an unbound PENDING unit");
    this.#remember(state);
    this.#enqueue(state);
    return state;
  }

  private async recoverImpl(): Promise<void> {
    const caseIds = [...(await this.#persistence.listCaseIds())].sort(compareText);
    for (const caseId of caseIds) {
      const snapshot = await this.#persistence.recover(caseId);
      if (snapshot.caseId !== caseId)
        throw new RuntimeInvariantError("recovery case binding mismatch");
      if (snapshot.checkpointRevision !== undefined)
        this.#checkpointRevisions.set(caseId, snapshot.checkpointRevision);
      if (snapshot.writerBlocked === true) this.#blockedCases.add(caseId);
      for (const state of snapshot.units) {
        if (state.workUnit.case_id !== caseId)
          throw new RuntimeInvariantError("recovery work unit case binding mismatch");
        this.#remember(state);
        const unit = state.workUnit;
        if (
          (unit.status === "PENDING" || unit.status === "DISPATCHED") &&
          !(snapshot.writerBlocked === true && unit.role === "IMPLEMENTER")
        )
          this.#enqueue(state);
        if (
          snapshot.writerBlocked === true &&
          unit.role === "IMPLEMENTER" &&
          (unit.status === "PENDING" || unit.status === "DISPATCHED")
        ) {
          this.#blockedUnits.add(unit.work_unit_id);
        }
        if (unit.status === "RUNNING" && state.completion !== null) {
          await this.finalizeConfirmed(state);
        } else if (unit.status === "RUNNING" && state.run !== null) {
          this.#ambiguous.add(unit.work_unit_id);
          if (this.#persistence.markAmbiguous) {
            try {
              await this.#persistence.markAmbiguous({
                workUnitId: unit.work_unit_id,
                runId: state.run.runId,
                reason: "RUNNING recovery has no confirmed completion",
              });
            } catch {
              // The durable RUNNING row remains an explicit recovery blocker.
            }
          }
        }
      }
    }
  }

  private async pumpImpl(): Promise<RuntimePumpResult> {
    await this.recover();
    const leases: RuntimeSchedulerLease[] = [];
    const writerByCase = new Map<string, string>();
    for (const state of this.#units.values()) {
      if (
        state.workUnit.role === "IMPLEMENTER" &&
        (state.workUnit.status === "DISPATCHED" || state.workUnit.status === "RUNNING")
      ) {
        writerByCase.set(state.workUnit.case_id, state.workUnit.work_unit_id);
      }
    }
    const selectedWriterCases = new Set<string>();
    for (const lease of this.#deferredLeases.values()) {
      const state = this.#units.get(lease.workUnitId);
      if (state?.workUnit.role === "IMPLEMENTER") {
        const caseId = state.workUnit.case_id;
        const activeUnitId = writerByCase.get(caseId);
        if (
          this.#blockedCases.has(caseId) ||
          (activeUnitId !== undefined && activeUnitId !== state.workUnit.work_unit_id)
        ) {
          lease.release();
          this.#blockedUnits.add(state.workUnit.work_unit_id);
          this.#blockedCases.add(caseId);
          continue;
        }
        selectedWriterCases.add(caseId);
      }
      leases.push(lease);
    }
    this.#deferredLeases.clear();
    for (let step = leases.length; step < this.#maxSteps; step += 1) {
      const lease = this.#scheduler.acquire();
      if (!lease) break;
      this.#queued.delete(lease.workUnitId);
      const state = this.#units.get(lease.workUnitId);
      if (!state) {
        lease.release();
        throw new RuntimeInvariantError(`scheduler selected unknown unit ${lease.workUnitId}`);
      }
      if (
        lease.caseId !== state.workUnit.case_id ||
        (state.provider !== undefined && lease.provider !== state.provider)
      ) {
        lease.release();
        throw new RuntimeInvariantError("scheduler work unit binding mismatch");
      }
      if (state.workUnit.role === "IMPLEMENTER") {
        const caseId = state.workUnit.case_id;
        const activeUnitId = writerByCase.get(caseId);
        if (
          this.#blockedCases.has(caseId) ||
          selectedWriterCases.has(caseId) ||
          (activeUnitId !== undefined && activeUnitId !== state.workUnit.work_unit_id)
        ) {
          if (this.#blockedCases.has(caseId)) {
            lease.release();
            this.#blockedUnits.add(state.workUnit.work_unit_id);
          } else {
            this.#deferredLeases.set(lease.workUnitId, lease);
          }
          continue;
        }
        selectedWriterCases.add(caseId);
      }
      leases.push(lease);
    }
    let results: Array<ProcessResult | null>;
    try {
      results = await Promise.all(leases.map((lease) => this.process(lease.workUnitId)));
    } finally {
      for (const lease of leases) lease.release();
    }

    const readOnly = results.filter(
      (result): result is ProcessResult =>
        result !== null &&
        result.completion !== null &&
        result.unit.workUnit.role !== "IMPLEMENTER",
    );
    const byCase = new Map<
      string,
      Array<{
        binding: {
          workUnitId: string;
          caseId: string;
          runId: string;
          role: Exclude<AgentRole, "IMPLEMENTER">;
        };
        completion: AgentCompletion;
      }>
    >();
    for (const result of readOnly) {
      const runId = result.unit.workUnit.run_id;
      if (runId === null) continue;
      const list = byCase.get(result.unit.workUnit.case_id) ?? [];
      list.push({
        binding: {
          workUnitId: result.unit.workUnit.work_unit_id,
          caseId: result.unit.workUnit.case_id,
          runId,
          role: result.unit.workUnit.role as Exclude<AgentRole, "IMPLEMENTER">,
        },
        completion: result.completion!,
      });
      byCase.set(result.unit.workUnit.case_id, list);
    }
    const merges: ReadOnlyMerge[] = [];
    for (const values of byCase.values()) merges.push(mergeReadOnlyResults(values));
    return {
      progressed: results.filter((result) => result?.progressed === true).length,
      ambiguous: [
        ...new Set([
          ...this.#ambiguous,
          ...results.flatMap((result) => (result?.ambiguous ? [result.unitId] : [])),
        ]),
      ],
      blocked: [
        ...this.#blockedUnits,
        ...results.flatMap((result) => (result?.blocked ? [result.unitId] : [])),
      ].filter((unitId, index, all) => all.indexOf(unitId) === index),
      waiting: results.flatMap((result) => (result?.waiting ? [result.unitId] : [])),
      merges,
    };
  }

  private async process(unitId: string): Promise<ProcessResult | null> {
    const known = this.#units.get(unitId);
    if (!known) throw new RuntimeInvariantError(`scheduler selected unknown unit ${unitId}`);
    let state = known;
    let claimed = false;
    let started = false;
    let completionPersistAttempted = false;
    let writerFence: RuntimeWriterFence | undefined;
    try {
      if (state.workUnit.status === "PENDING") {
        const runId = this.#makeRunId(state);
        const claim = await this.#persistence.claim({
          workUnitId: state.workUnit.work_unit_id,
          runId,
          checkpointRevision: this.#checkpointRevisions.get(state.workUnit.case_id) ?? 0,
          ...(state.run?.triggerEventId === undefined
            ? {}
            : { triggerEventId: state.run.triggerEventId }),
          ...(state.run?.model ? { model: state.run.model } : {}),
        });
        if (!claim) {
          return {
            unitId,
            progressed: false,
            ambiguous: false,
            blocked: true,
            waiting: false,
            unit: state,
            completion: null,
          };
        }
        claimed = true;
        state = this.#stateFromClaim(state, claim);
      }
      if (state.workUnit.status === "DISPATCHED") {
        if (!state.run) throw new RuntimeInvariantError("DISPATCHED unit has no run binding");
        const startedUnit = await this.#persistence.start({
          workUnitId: state.workUnit.work_unit_id,
          runId: state.run.runId,
        });
        started = true;
        if (
          startedUnit.workUnit.work_unit_id !== state.workUnit.work_unit_id ||
          startedUnit.workUnit.case_id !== state.workUnit.case_id ||
          startedUnit.workUnit.role !== state.workUnit.role ||
          startedUnit.workUnit.run_id !== state.run.runId ||
          startedUnit.workUnit.status !== "RUNNING"
        )
          throw new RuntimeInvariantError("start work unit binding mismatch");
        state = {
          ...state,
          workUnit: startedUnit.workUnit,
          ...(startedUnit.provider === undefined ? {} : { provider: startedUnit.provider }),
        };
        this.#remember(state);
      }
      if (state.workUnit.status !== "RUNNING" || state.run === null) {
        return {
          unitId,
          progressed: claimed || started,
          ambiguous: false,
          blocked: true,
          waiting: false,
          unit: state,
          completion: null,
        };
      }
      if (state.completion !== null) {
        state = await this.finalizeConfirmed(state);
        return {
          unitId,
          progressed: true,
          ambiguous: false,
          blocked: false,
          waiting: false,
          unit: state,
          completion: state.completion,
        };
      }
      const role = this.#roles[state.workUnit.role];
      if (!role)
        throw new RuntimeInvariantError(`no role implementation for ${state.workUnit.role}`);
      if (state.workUnit.role === "IMPLEMENTER") {
        if (state.workUnit.authoritative_scope.can_write_workspace !== true)
          throw new RuntimeInvariantError("IMPLEMENTER scope is not write-enabled");
        if (!this.#writerAuthority)
          throw new RuntimeInvariantError("IMPLEMENTER requires writer authority");
        writerFence = await this.#writerAuthority.acquire({ unit: state.workUnit, run: state.run });
        await writerFence.assertCurrent();
      } else if (ROLE_CAN_WRITE_WORKSPACE[state.workUnit.role]) {
        throw new RuntimeInvariantError("non-Implementer role is write-enabled");
      }
      const parsed = agentCompletion.safeParse(
        await role.invoke({ unit: state, run: state.run, ...(writerFence ? { writerFence } : {}) }),
      );
      if (!parsed.success) throw new RuntimeInvariantError("role returned an invalid completion");
      const completion = parsed.data;
      if (completion.case_id !== state.workUnit.case_id || completion.run_id !== state.run.runId)
        throw new RuntimeInvariantError("role completion binding mismatch");
      if (writerFence) await writerFence.assertCurrent();
      completionPersistAttempted = true;
      await this.#persistence.persistCompletion({ unit: state, run: state.run, completion });
      state = { ...state, completion };
      this.#remember(state);
      state = await this.finalizeConfirmed(state);
      return {
        unitId,
        progressed: true,
        ambiguous: false,
        blocked: false,
        waiting: completion.status === "WAITING_FOR_USER",
        unit: state,
        completion,
      };
    } catch (error) {
      if (completionPersistAttempted) {
        return {
          unitId,
          progressed: true,
          ambiguous: false,
          blocked: true,
          waiting: false,
          unit: state,
          completion: state.completion,
        };
      }
      if (started && state.run && this.#persistence.markAmbiguous) {
        try {
          await this.#persistence.markAmbiguous({
            workUnitId: state.workUnit.work_unit_id,
            runId: state.run.runId,
            reason: error instanceof Error ? error.message : "role invocation failed",
          });
        } catch {
          // The local result is still reported ambiguous; no automatic replay follows.
        }
      }
      if (started) {
        this.#ambiguous.add(unitId);
        if (state.workUnit.role === "IMPLEMENTER") this.#blockedCases.add(state.workUnit.case_id);
      }
      return {
        unitId,
        progressed: claimed || started,
        ambiguous: started,
        blocked: !started,
        waiting: false,
        unit: state,
        completion: null,
      };
    } finally {
      if (writerFence?.release) {
        try {
          await writerFence.release();
        } catch {
          // Lease expiry remains the durable backstop when release itself fails.
        }
      }
    }
  }

  private async finalizeConfirmed(state: RuntimeUnitState): Promise<RuntimeUnitState> {
    if (!state.run || !state.completion)
      throw new RuntimeInvariantError("confirmed completion lacks run");
    await this.#persistence.finalize({
      workUnitId: state.workUnit.work_unit_id,
      runId: state.run.runId,
      status:
        state.completion.status === "FAILED"
          ? "FAILED"
          : state.completion.status === "CANCELLED"
            ? "CANCELLED"
            : "COMPLETED",
    });
    const terminalState: RuntimeUnitState = {
      ...state,
      workUnit: {
        ...state.workUnit,
        status:
          state.completion.status === "FAILED"
            ? "FAILED"
            : state.completion.status === "CANCELLED"
              ? "CANCELLED"
              : "COMPLETED",
      } as WorkUnit,
    };
    this.#remember(terminalState);
    return terminalState;
  }

  #remember(state: RuntimeUnitState): void {
    if (state.run !== null && state.workUnit.run_id !== state.run.runId)
      throw new RuntimeInvariantError("run binding mismatch");
    if (
      state.completion !== null &&
      (state.run === null ||
        state.completion.case_id !== state.workUnit.case_id ||
        state.completion.run_id !== state.run.runId)
    )
      throw new RuntimeInvariantError("completion binding mismatch");
    this.#units.set(state.workUnit.work_unit_id, state);
  }

  #enqueue(state: RuntimeUnitState): void {
    if (this.#queued.has(state.workUnit.work_unit_id)) return;
    this.#scheduler.enqueue({
      workUnitId: state.workUnit.work_unit_id,
      caseId: state.workUnit.case_id,
      ...(state.provider ? { provider: state.provider } : {}),
    });
    this.#queued.add(state.workUnit.work_unit_id);
  }

  #stateFromClaim(previous: RuntimeUnitState, claim: RuntimeClaim): RuntimeUnitState {
    if (
      claim.unit.workUnit.work_unit_id !== previous.workUnit.work_unit_id ||
      claim.unit.workUnit.case_id !== previous.workUnit.case_id ||
      claim.unit.workUnit.role !== previous.workUnit.role ||
      claim.run.runId !== claim.unit.workUnit.run_id
    )
      throw new RuntimeInvariantError("claim binding mismatch");
    const state: RuntimeUnitState = {
      ...previous,
      workUnit: claim.unit.workUnit,
      ...(claim.unit.provider === undefined ? {} : { provider: claim.unit.provider }),
      run: claim.run,
      completion: null,
    };
    this.#remember(state);
    return state;
  }
}

interface ProcessResult {
  readonly unitId: string;
  readonly progressed: boolean;
  readonly ambiguous: boolean;
  readonly blocked: boolean;
  readonly waiting: boolean;
  readonly unit: RuntimeUnitState;
  readonly completion: AgentCompletion | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
