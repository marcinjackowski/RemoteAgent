export interface SemaphoreOptions {
  readonly limit: number;
  readonly name?: string;
}

export class SemaphoreLease {
  readonly #semaphore: BoundedSemaphore;
  readonly #token = Symbol("semaphore-lease");
  readonly #key: string | null;

  public constructor(semaphore: BoundedSemaphore, key: string | null) {
    this.#semaphore = semaphore;
    this.#key = key;
    Object.freeze(this);
  }

  public release(): boolean {
    return this.#semaphore.release(this);
  }

  public isOwnedBy(semaphore: BoundedSemaphore): boolean {
    return this.#semaphore === semaphore && this.#token.description === "semaphore-lease";
  }

  public get key(): string | null {
    return this.#key;
  }
}

/** A synchronous bounded counter with identity-fenced, idempotent leases. */
export class BoundedSemaphore {
  public readonly limit: number;
  public readonly name: string;
  private active = new Set<SemaphoreLease>();

  public constructor(options: SemaphoreOptions | number) {
    const limit = typeof options === "number" ? options : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("semaphore limit must be a positive safe integer");
    this.limit = limit;
    this.name = typeof options === "number" ? "semaphore" : (options.name ?? "semaphore");
  }

  public acquire(key: string | null = null): SemaphoreLease | null {
    if (this.active.size >= this.limit) return null;
    const lease = new SemaphoreLease(this, key);
    this.active.add(lease);
    return lease;
  }

  public release(lease: unknown): boolean {
    if (!(lease instanceof SemaphoreLease) || !lease.isOwnedBy(this)) return false;
    return this.active.delete(lease);
  }

  public get used(): number {
    return this.active.size;
  }

  public get available(): number {
    return this.limit - this.active.size;
  }
}
