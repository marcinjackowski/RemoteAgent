import {
  agentCompletion,
  idString,
  type AgentCompletion,
  type DecisionAnswer,
  type DecisionRequest,
} from "@remoteagent/contracts";

import { prepareDecisionAnswer, prepareDecisionRequest } from "../decisions/prepare.js";
import { DecisionPreparationError } from "../decisions/errors.js";
import { BudgetLedger, type BudgetKind, type BudgetLimits, type BudgetCounts } from "./budget.js";

export interface ControlBinding {
  readonly caseId: string;
  readonly runId: string;
  readonly checkpointRevision: number;
}

export interface CheckpointAndStop {
  readonly kind: "CHECKPOINT_AND_STOP";
  readonly reason: "ITERATION_BUDGET_EXHAUSTED" | "FIX_BUDGET_EXHAUSTED";
  readonly caseId: string;
  readonly runId: string;
  readonly checkpointRevision: number;
  readonly counts: BudgetCounts;
}

export interface WaitingMaterialization {
  readonly source: ControlBinding;
  readonly request: DecisionRequest;
}

export interface NewRunDispatch {
  readonly kind: "DISPATCH_NEW_RUN";
  readonly caseId: string;
  readonly sourceRunId: string;
  readonly runId: string;
  readonly answerId: string;
  readonly decisionId: string;
  readonly checkpointRevision: number;
  readonly answer: DecisionAnswer;
}

export type ControlAction =
  | { readonly kind: "CONTINUE"; readonly binding: ControlBinding; readonly counts: BudgetCounts }
  | { readonly kind: "COMPLETED"; readonly binding: ControlBinding; readonly counts: BudgetCounts }
  | { readonly kind: "FAILED"; readonly binding: ControlBinding; readonly counts: BudgetCounts }
  | {
      readonly kind: "WAITING_FOR_USER";
      readonly source: ControlBinding;
      readonly request: DecisionRequest;
    }
  | CheckpointAndStop
  | NewRunDispatch
  | { readonly kind: "PAUSED"; readonly binding: ControlBinding }
  | { readonly kind: "CANCELLED"; readonly binding: ControlBinding };

export interface ControlPersistence {
  readonly persistCheckpointAndStop: (stop: CheckpointAndStop) => Promise<void>;
  readonly materializeWaiting: (input: WaitingMaterialization) => Promise<void>;
  readonly allocateRunId: (input: {
    readonly caseId: string;
    readonly sourceRunId: string;
    readonly answerId: string;
  }) => string;
}

export interface CompletionEvent {
  readonly completion: unknown;
  readonly successKind?: BudgetKind;
  readonly currentCheckpoint: unknown;
}

export interface AnswerEvent {
  readonly answerId: string;
  readonly selection: unknown;
  readonly system: unknown;
}

export class ControlBindingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlBindingError";
  }
}

export class ControlConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlConflictError";
  }
}

export class ControlStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlStateError";
  }
}

export class ControlPersistenceError extends Error {
  public constructor(cause: unknown) {
    super("control persistence failed", { cause: cause instanceof Error ? cause : undefined });
    this.name = "ControlPersistenceError";
  }
}

/** Deterministic server-owned controller for budgets, pause/cancel and waiting. */
export class SupervisorControl {
  readonly #binding: ControlBinding;
  readonly #ledger: BudgetLedger;
  readonly #persistence: ControlPersistence;
  #paused = false;
  #cancelled = false;
  #waiting: { request: DecisionRequest; action: ControlAction; completionKey: string } | null =
    null;
  #waitingInFlight: Promise<ControlAction> | null = null;
  #waitingInFlightKey: string | null = null;
  #stop: CheckpointAndStop | null = null;
  #stopInFlight: Promise<CheckpointAndStop> | null = null;
  #stopInFlightKey: string | null = null;
  #answered: { answerId: string; key: string; action: NewRunDispatch } | null = null;

  public constructor(
    binding: ControlBinding,
    limits: BudgetLimits,
    persistence: ControlPersistence,
  ) {
    this.#binding = Object.freeze(normalizeBinding(binding));
    this.#ledger = new BudgetLedger(limits);
    this.#persistence = persistence;
  }

  public get binding(): ControlBinding {
    return this.#binding;
  }

  public get counts(): BudgetCounts {
    return this.#ledger.counts;
  }

  public get paused(): boolean {
    return this.#paused;
  }

  public get cancelled(): boolean {
    return this.#cancelled;
  }

  public pause(): void {
    if (!this.#cancelled) this.#paused = true;
  }

  public cancel(): void {
    this.#cancelled = true;
    this.#paused = true;
  }

  public resume(): void {
    if (!this.#cancelled) this.#paused = false;
  }

  public canDispatch(): boolean {
    return (
      !this.#paused &&
      !this.#cancelled &&
      this.#waiting === null &&
      this.#waitingInFlight === null &&
      this.#stop === null &&
      this.#stopInFlight === null
    );
  }

  public async complete(event: CompletionEvent): Promise<ControlAction> {
    const gate = this.#terminalGateAction();
    if (gate) return gate;
    const parsed = agentCompletion.safeParse(event.completion);
    if (!parsed.success) throw new ControlStateError("completion is invalid");
    assertCompletionBinding(parsed.data, this.#binding);

    if (this.#waiting !== null || this.#waitingInFlight !== null) {
      if (parsed.data.status !== "WAITING_FOR_USER") {
        throw new ControlConflictError("completion conflicts with the active decision");
      }
      return this.#materializeWaiting(parsed.data, event.currentCheckpoint);
    }
    if (parsed.data.status === "WAITING_FOR_USER")
      return this.#materializeWaiting(parsed.data, event.currentCheckpoint);
    if (
      parsed.data.status === "FAILED" ||
      parsed.data.status === "BLOCKED" ||
      parsed.data.status === "CANCELLED"
    ) {
      return { kind: "FAILED", binding: this.#binding, counts: this.#ledger.counts };
    }

    const consumed = this.#ledger.consume(event.successKind ?? "ITERATION");
    if (parsed.data.status === "COMPLETED") {
      return { kind: "COMPLETED", binding: this.#binding, counts: consumed.counts };
    }
    if (consumed.exhausted) {
      return this.#persistStop(consumed.kind, consumed.counts, canonicalJson(parsed.data));
    }
    if (this.#cancelled) return { kind: "CANCELLED", binding: this.#binding };
    if (this.#paused) return { kind: "PAUSED", binding: this.#binding };
    return {
      kind: "CONTINUE",
      binding: this.#binding,
      counts: consumed.counts,
    };
  }

  public async answer(event: AnswerEvent): Promise<NewRunDispatch | ControlAction> {
    if (this.#cancelled) return { kind: "CANCELLED", binding: this.#binding };
    if (this.#stop) return this.#stop;
    if (this.#paused) return { kind: "PAUSED", binding: this.#binding };
    if (!this.#waiting) throw new ControlStateError("no waiting decision is active");
    if (!idString.safeParse(event.answerId).success)
      throw new ControlBindingError("answer id is invalid");
    const key = canonicalJson({ selection: event.selection, system: event.system });
    if (this.#answered) {
      if (this.#answered.answerId === event.answerId && this.#answered.key === key)
        return this.#answered.action;
      throw new ControlConflictError("answer conflicts with the already accepted answer");
    }
    let answer: DecisionAnswer;
    try {
      answer = prepareDecisionAnswer({
        request: this.#waiting.request,
        selection: event.selection,
        system: event.system,
      });
    } catch (error) {
      if (error instanceof DecisionPreparationError) throw error;
      throw new ControlBindingError("answer is invalid");
    }
    const runId = this.#persistence.allocateRunId({
      caseId: this.#binding.caseId,
      sourceRunId: this.#binding.runId,
      answerId: event.answerId,
    });
    if (!idString.safeParse(runId).success || runId === this.#binding.runId) {
      throw new ControlBindingError("allocated run id is invalid");
    }
    const action = deepFreeze<NewRunDispatch>({
      kind: "DISPATCH_NEW_RUN",
      caseId: this.#binding.caseId,
      sourceRunId: this.#binding.runId,
      runId,
      answerId: event.answerId,
      decisionId: this.#waiting.request.decision_id,
      checkpointRevision: this.#waiting.request.checkpoint_revision,
      answer,
    });
    this.#answered = { answerId: event.answerId, key, action };
    return action;
  }

  async #materializeWaiting(
    completion: AgentCompletion,
    currentCheckpoint: unknown,
  ): Promise<ControlAction> {
    const completionKey = canonicalJson({ completion, currentCheckpoint });
    if (this.#waiting) {
      if (this.#waiting.completionKey === completionKey) return this.#waiting.action;
      throw new ControlConflictError("waiting completion conflicts with the active decision");
    }
    if (this.#waitingInFlight) {
      if (this.#waitingInFlightKey !== completionKey) {
        throw new ControlConflictError(
          "waiting completion conflicts with in-flight materialization",
        );
      }
      const action = await this.#waitingInFlight;
      return this.#terminalGateAction() ?? action;
    }
    const request = deepFreeze(prepareDecisionRequest({ completion, currentCheckpoint }));
    if (request.checkpoint_revision !== this.#binding.checkpointRevision) {
      throw new ControlBindingError("waiting decision revision does not match the active run");
    }
    const action = deepFreeze<ControlAction>({
      kind: "WAITING_FOR_USER",
      source: this.#binding,
      request,
    });
    this.#waitingInFlightKey = completionKey;
    const persist = (async (): Promise<ControlAction> => {
      try {
        await this.#persistence.materializeWaiting({ source: this.#binding, request });
      } catch (error) {
        if (this.#cancelled) return { kind: "CANCELLED", binding: this.#binding };
        throw new ControlPersistenceError(error);
      }
      this.#waiting = { request, action, completionKey };
      return this.#terminalGateAction() ?? action;
    })();
    this.#waitingInFlight = persist.finally(() => {
      this.#waitingInFlight = null;
      this.#waitingInFlightKey = null;
    });
    return this.#waitingInFlight;
  }

  async #persistStop(
    kind: BudgetKind,
    counts: BudgetCounts,
    completionKey: string,
  ): Promise<ControlAction> {
    if (this.#stop) return this.#stop;
    if (this.#stopInFlight) {
      if (this.#stopInFlightKey !== completionKey) {
        throw new ControlConflictError("completion conflicts with in-flight checkpoint stop");
      }
      const stop = await this.#stopInFlight;
      return this.#terminalGateAction() ?? stop;
    }
    const stop = deepFreeze<CheckpointAndStop>({
      kind: "CHECKPOINT_AND_STOP",
      reason: kind === "ITERATION" ? "ITERATION_BUDGET_EXHAUSTED" : "FIX_BUDGET_EXHAUSTED",
      caseId: this.#binding.caseId,
      runId: this.#binding.runId,
      checkpointRevision: this.#binding.checkpointRevision,
      counts,
    });
    this.#stopInFlightKey = completionKey;
    const persist = (async (): Promise<CheckpointAndStop> => {
      try {
        await this.#persistence.persistCheckpointAndStop(stop);
      } catch (error) {
        this.#ledger.rollback(kind);
        throw new ControlPersistenceError(error);
      }
      this.#stop = stop;
      return stop;
    })();
    this.#stopInFlight = persist.finally(() => {
      this.#stopInFlight = null;
      this.#stopInFlightKey = null;
    });
    let persisted: CheckpointAndStop;
    try {
      persisted = await this.#stopInFlight;
    } catch (error) {
      if (this.#cancelled) return { kind: "CANCELLED", binding: this.#binding };
      throw error;
    }
    return this.#terminalGateAction() ?? persisted;
  }

  #terminalGateAction(): ControlAction | null {
    if (this.#cancelled) return { kind: "CANCELLED", binding: this.#binding };
    if (this.#stop) return this.#stop;
    if (this.#paused) return { kind: "PAUSED", binding: this.#binding };
    return null;
  }
}

function normalizeBinding(binding: ControlBinding): ControlBinding {
  const caseId = idString.safeParse(binding.caseId);
  const runId = idString.safeParse(binding.runId);
  if (!caseId.success || !runId.success)
    throw new ControlBindingError("case/run binding is invalid");
  if (!Number.isSafeInteger(binding.checkpointRevision) || binding.checkpointRevision < 0) {
    throw new ControlBindingError("checkpoint revision is invalid");
  }
  return { caseId: caseId.data, runId: runId.data, checkpointRevision: binding.checkpointRevision };
}

function assertCompletionBinding(completion: AgentCompletion, binding: ControlBinding): void {
  if (completion.case_id !== binding.caseId || completion.run_id !== binding.runId) {
    throw new ControlBindingError("completion case/run binding mismatch");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
