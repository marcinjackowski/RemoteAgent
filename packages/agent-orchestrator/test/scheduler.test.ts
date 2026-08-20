import { describe, expect, it } from "vitest";

import { FairScheduler, type ScheduledWorkUnit } from "../src/index.js";

const unit = (workUnitId: string, caseId: string, provider: string): ScheduledWorkUnit => ({
  workUnitId,
  caseId,
  provider,
  readOnly: true,
});

describe("deterministic scheduler", () => {
  it("keeps FIFO within each case and round-robins three cases", () => {
    const scheduler = new FairScheduler({ globalLimit: 1 });
    scheduler.enqueue(unit("a-1", "case-a", "provider-a"));
    scheduler.enqueue(unit("a-2", "case-a", "provider-a"));
    scheduler.enqueue(unit("b-1", "case-b", "provider-b"));
    scheduler.enqueue(unit("c-1", "case-c", "provider-a"));

    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const lease = scheduler.acquire();
      expect(lease).not.toBeNull();
      order.push(lease!.workUnitId);
      expect(lease!.release()).toBe(true);
    }
    expect(order).toEqual(["a-1", "b-1", "c-1", "a-2"]);
  });

  it("enforces global and provider capacity without mutating a blocked queue", () => {
    const scheduler = new FairScheduler({
      globalLimit: 2,
      providerLimits: { "provider-a": 1, "provider-b": 1 },
    });
    scheduler.enqueue(unit("a-1", "case-a", "provider-a"));
    scheduler.enqueue(unit("a-2", "case-a", "provider-a"));
    scheduler.enqueue(unit("b-1", "case-b", "provider-b"));

    const a = scheduler.acquire();
    const b = scheduler.acquire();
    expect(a?.provider).toBe("provider-a");
    expect(b?.provider).toBe("provider-b");
    expect(scheduler.activeCount).toBe(2);
    expect(scheduler.providerUsed("provider-a")).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.acquire()).toBeNull();
    expect(scheduler.pendingCount).toBe(1);

    expect(a!.release()).toBe(true);
    const next = scheduler.acquire();
    expect(next?.workUnitId).toBe("a-2");
    expect(next!.release()).toBe(true);
    expect(b!.release()).toBe(true);
    expect(scheduler.activeCount).toBe(0);
  });

  it("fences foreign, stale, and double releases", () => {
    const first = new FairScheduler({ globalLimit: 1 });
    const second = new FairScheduler({ globalLimit: 1 });
    first.enqueue(unit("a-1", "case-a", "provider-a"));
    const lease = first.acquire();
    expect(lease).not.toBeNull();
    expect(second.release(lease)).toBe(false);
    expect(first.activeCount).toBe(1);
    expect(lease!.release()).toBe(true);
    expect(lease!.release()).toBe(false);
    expect(first.activeCount).toBe(0);
    expect(first.globalUsed).toBe(0);
  });

  it("keeps resources opaque and deduplicates immutable work-unit identities", () => {
    const scheduler = new FairScheduler({ globalLimit: 1, providerLimits: { "provider-a": 1 } });
    const item = unit("a-1", "case-a", "provider-a");
    scheduler.enqueue(item);
    scheduler.enqueue({ ...item });
    expect(scheduler.pendingCount).toBe(1);
    expect(() => scheduler.enqueue({ ...item, caseId: "case-b" })).toThrow();
    expect(() => scheduler.enqueue({ ...item, provider: "provider-b" })).toThrow();
    expect(() => scheduler.enqueue({ ...item, workUnitId: "bad\0id" })).toThrow();
    const lease = scheduler.acquire()!;
    expect((scheduler as unknown as { global?: unknown }).global).toBeUndefined();
    expect((scheduler as unknown as { mailbox?: unknown }).mailbox).toBeUndefined();
    expect((lease as unknown as { releaseResources?: unknown }).releaseResources).toBeUndefined();
    expect(scheduler.globalUsed).toBe(1);
    expect(lease.release()).toBe(true);
    expect(scheduler.globalUsed).toBe(0);
  });

  it("rejects unknown providers when provider limits are configured", () => {
    const scheduler = new FairScheduler({ providerLimits: { "provider-a": 1 }, globalLimit: 2 });
    expect(() => scheduler.enqueue(unit("x", "case-x", "provider-b"))).toThrow(/unknown provider/);
    expect(
      () => new FairScheduler({ providerLimits: { "bad\0provider": 1 }, globalLimit: 1 }),
    ).toThrow();
    expect(() => scheduler.enqueue(unit("", "case-x", "provider-a"))).toThrow();
  });

  it("never exceeds limits under concurrent Promise calls", async () => {
    const scheduler = new FairScheduler({
      globalLimit: 3,
      providerLimits: { "provider-a": 1, "provider-b": 2 },
    });
    for (let i = 0; i < 12; i += 1) {
      const caseId = `case-${i % 3}`;
      scheduler.enqueue(unit(`unit-${i}`, caseId, i % 2 === 0 ? "provider-a" : "provider-b"));
    }
    const leases = await Promise.all(
      Array.from({ length: 12 }, () => Promise.resolve(scheduler.acquire())),
    );
    const acquired = leases.filter((lease) => lease !== null);
    expect(acquired).toHaveLength(3);
    expect(scheduler.activeCount).toBe(3);
    expect(scheduler.globalUsed).toBeLessThanOrEqual(3);
    expect(scheduler.providerUsed("provider-a")).toBeLessThanOrEqual(1);
    expect(scheduler.providerUsed("provider-b")).toBeLessThanOrEqual(2);
    for (const lease of acquired) expect(lease.release()).toBe(true);
  });
});
