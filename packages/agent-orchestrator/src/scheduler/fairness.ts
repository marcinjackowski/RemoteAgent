import { CaseMailbox, type ScheduledWorkUnit } from "./mailbox.js";
import { BoundedSemaphore, SemaphoreLease } from "./semaphore.js";

export interface SchedulerOptions {
  readonly globalLimit: number;
  readonly providerLimits?: Readonly<Record<string, number>>;
}

export class SchedulerLease {
  readonly #scheduler: FairScheduler;
  readonly #unit: ScheduledWorkUnit;

  public constructor(scheduler: FairScheduler, unit: ScheduledWorkUnit) {
    this.#scheduler = scheduler;
    this.#unit = Object.freeze({ ...unit });
    Object.freeze(this);
  }

  public get workUnit(): ScheduledWorkUnit {
    return this.#unit;
  }

  public get workUnitId(): string {
    return this.#unit.workUnitId;
  }

  public get caseId(): string {
    return this.#unit.caseId;
  }

  public get provider(): string | null {
    return this.#unit.provider ?? null;
  }

  public release(): boolean {
    return this.#scheduler.release(this);
  }
}

/** Deterministic case-FIFO, round-robin scheduler with capacity fencing. */
export class FairScheduler {
  readonly #mailbox = new CaseMailbox();
  readonly #global: BoundedSemaphore;
  readonly #providers = new Map<string, BoundedSemaphore>();
  readonly #active = new Map<
    SchedulerLease,
    { global: SemaphoreLease; provider: SemaphoreLease | null }
  >();
  private nextCaseId: string | null = null;

  public constructor(options: SchedulerOptions) {
    this.#global = new BoundedSemaphore({ limit: options.globalLimit, name: "global" });
    for (const [provider, limit] of Object.entries(options.providerLimits ?? {})) {
      validateProvider(provider);
      this.#providers.set(provider, new BoundedSemaphore({ limit, name: `provider:${provider}` }));
    }
  }

  public enqueue(unit: ScheduledWorkUnit): void {
    if (unit.provider && this.#providers.size > 0 && !this.#providers.has(unit.provider))
      throw new Error(`unknown provider '${unit.provider}'`);
    this.#mailbox.enqueue(unit);
  }

  /** Acquire removes exactly one eligible FIFO head; no capacity means no mutation. */
  public acquire(): SchedulerLease | null {
    const cases = this.#mailbox.caseIds();
    if (cases.length === 0 || this.#global.available === 0) return null;
    const requestedStart = this.nextCaseId === null ? 0 : cases.indexOf(this.nextCaseId);
    const start = requestedStart < 0 ? 0 : requestedStart;
    for (let offset = 0; offset < cases.length; offset += 1) {
      const index = (start + offset) % cases.length;
      const caseId = cases[index]!;
      const unit = this.#mailbox.peek(caseId);
      if (!unit) continue;
      const provider = unit.provider ? this.#providers.get(unit.provider) : undefined;
      if (provider && provider.available === 0) continue;
      const globalLease = this.#global.acquire(caseId);
      if (!globalLease) return null;
      const providerLease = provider ? provider.acquire(caseId) : null;
      if (provider && !providerLease) {
        globalLease.release();
        continue;
      }
      const selected = this.#mailbox.dequeue(caseId);
      if (!selected) {
        providerLease?.release();
        globalLease.release();
        continue;
      }
      this.nextCaseId = cases[(index + 1) % cases.length] ?? null;
      const lease = new SchedulerLease(this, selected);
      this.#active.set(lease, { global: globalLease, provider: providerLease });
      return lease;
    }
    return null;
  }

  /** Foreign, stale, or repeated releases are no-ops and never alter counters. */
  public release(lease: unknown): boolean {
    if (!(lease instanceof SchedulerLease)) return false;
    const resources = this.#active.get(lease);
    if (!resources) return false;
    this.#active.delete(lease);
    resources.provider?.release();
    resources.global.release();
    return true;
  }

  public get activeCount(): number {
    return this.#active.size;
  }

  public get globalUsed(): number {
    return this.#global.used;
  }

  public get globalAvailable(): number {
    return this.#global.available;
  }

  public providerUsed(provider: string): number {
    return this.#providers.get(provider)?.used ?? 0;
  }

  public get pendingCount(): number {
    return this.#mailbox.pendingCount();
  }
}

function validateProvider(provider: string): void {
  if (provider.length === 0 || provider.includes("\0")) throw new Error("provider id is invalid");
}

export const DeterministicScheduler = FairScheduler;
