import { workUnit, type WorkUnit } from "@remoteagent/contracts";

export interface WriterJobLease {
  readonly jobId: string;
  readonly caseId: string | null;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  readonly jobType: string;
  readonly payload: Record<string, unknown>;
}

export const WRITER_JOB_TYPE = "agent.implementer" as const;

/** Deliberately narrow adapter: the guard never owns a DB transaction. */
export interface CurrentLeaseStore<TQuery> {
  assertCurrentLease(query: TQuery, lease: WriterJobLease): Promise<void>;
}

export type WriterLeaseResult<TQuery> =
  | { readonly kind: "WRITE"; readonly fence: WorkspaceFence<TQuery> }
  | {
      readonly kind: "READ_ONLY";
      readonly canWrite: false;
      readonly caseId: string;
      readonly workUnitId: string;
    };

/** Opaque capability that must be checked immediately before each mutation. */
export interface WorkspaceFence<TQuery> {
  readonly jobId: string;
  readonly caseId: string | null;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  readonly jobType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  assertCurrent(query: TQuery): Promise<void>;
}

class WorkspaceFenceImpl<TQuery> implements WorkspaceFence<TQuery> {
  readonly #store: CurrentLeaseStore<TQuery>;
  readonly #lease: WriterJobLease;

  public constructor(store: CurrentLeaseStore<TQuery>, lease: WriterJobLease) {
    this.#store = store;
    this.#lease = Object.freeze({ ...lease, payload: Object.freeze({ ...lease.payload }) });
    Object.freeze(this);
  }

  public async assertCurrent(query: TQuery): Promise<void> {
    await this.#store.assertCurrentLease(query, this.#lease);
  }

  public get jobId(): string {
    return this.#lease.jobId;
  }

  public get caseId(): string | null {
    return this.#lease.caseId;
  }

  public get leaseOwner(): string {
    return this.#lease.leaseOwner;
  }

  public get fencingToken(): number {
    return this.#lease.fencingToken;
  }

  public get jobType(): string {
    return this.#lease.jobType;
  }

  public get payload(): Readonly<Record<string, unknown>> {
    return this.#lease.payload;
  }
}

/** Role and case gate over the durable RA-004 JobLease fencing predicate. */
export class WriterLeaseGuard<TQuery> {
  public constructor(private readonly store: CurrentLeaseStore<TQuery>) {}

  public async acquire(
    query: TQuery,
    input: { readonly workUnit: unknown; readonly lease?: WriterJobLease },
  ): Promise<WriterLeaseResult<TQuery>> {
    const parsed = workUnit.safeParse(input.workUnit);
    if (!parsed.success) throw new Error("invalid work unit for writer lease");
    const unit: WorkUnit = parsed.data;
    if (unit.role !== "IMPLEMENTER") {
      return {
        kind: "READ_ONLY",
        canWrite: false,
        caseId: unit.case_id,
        workUnitId: unit.work_unit_id,
      };
    }
    if (unit.status !== "RUNNING" || unit.run_id === null) {
      throw new Error("implementer work unit must be RUNNING with a run binding");
    }
    if (!input.lease) throw new Error("implementer writer lease is required");
    if (
      unit.authoritative_scope.can_write_workspace !== true ||
      input.lease.caseId !== unit.case_id ||
      input.lease.jobType !== WRITER_JOB_TYPE ||
      !hasWriterBinding(input.lease.payload, unit.work_unit_id, unit.run_id)
    ) {
      throw new Error("implementer writer scope does not match the lease case");
    }
    await this.store.assertCurrentLease(query, input.lease);
    return {
      kind: "WRITE",
      fence: new WorkspaceFenceImpl(this.store, input.lease),
    };
  }
}

function hasWriterBinding(
  payload: Record<string, unknown>,
  workUnitId: string,
  runId: string,
): boolean {
  return payload.workUnitId === workUnitId && payload.runId === runId;
}
