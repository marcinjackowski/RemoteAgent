export interface ScheduledWorkUnit {
  readonly workUnitId: string;
  readonly caseId: string;
  readonly provider?: string | null;
  readonly readOnly?: boolean;
}

/** FIFO queues keyed by case. It contains no scheduling or capacity policy. */
export class CaseMailbox {
  private readonly queues = new Map<string, ScheduledWorkUnit[]>();
  private readonly identities = new Map<string, ScheduledWorkUnit>();

  public enqueue(unit: ScheduledWorkUnit): boolean {
    validateUnit(unit);
    const normalized = Object.freeze({
      ...unit,
      provider: unit.provider ?? null,
      readOnly: unit.readOnly ?? false,
    });
    const existing = this.identities.get(normalized.workUnitId);
    if (existing) {
      if (!sameIdentity(existing, normalized)) throw new Error("work unit identity conflict");
      return false;
    }
    const queue = this.queues.get(unit.caseId) ?? [];
    queue.push(normalized);
    this.queues.set(unit.caseId, queue);
    this.identities.set(normalized.workUnitId, normalized);
    return true;
  }

  public peek(caseId: string): ScheduledWorkUnit | null {
    return this.queues.get(caseId)?.[0] ?? null;
  }

  public dequeue(caseId: string): ScheduledWorkUnit | null {
    const queue = this.queues.get(caseId);
    if (!queue || queue.length === 0) return null;
    const unit = queue.shift()!;
    if (queue.length === 0) this.queues.delete(caseId);
    return unit;
  }

  public caseIds(): readonly string[] {
    return [...this.queues.keys()];
  }

  public pendingCount(caseId?: string): number {
    if (caseId !== undefined) return this.queues.get(caseId)?.length ?? 0;
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }
}

function validateUnit(unit: ScheduledWorkUnit): void {
  for (const [name, value] of [
    ["work unit", unit.workUnitId],
    ["case", unit.caseId],
  ] as const) {
    if (value.length === 0 || value.includes("\0")) throw new Error(`${name} id is invalid`);
  }
  if (unit.provider !== undefined && unit.provider !== null) {
    if (unit.provider.length === 0 || unit.provider.includes("\0"))
      throw new Error("provider id is invalid");
  }
}

function sameIdentity(a: ScheduledWorkUnit, b: ScheduledWorkUnit): boolean {
  return (
    a.workUnitId === b.workUnitId &&
    a.caseId === b.caseId &&
    (a.provider ?? null) === (b.provider ?? null) &&
    (a.readOnly ?? false) === (b.readOnly ?? false)
  );
}
