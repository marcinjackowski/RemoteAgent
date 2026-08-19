/**
 * RA-006 gateway session lifecycle tests (AUDIT-01 HIGH-03, AUDIT-02 MEDIUM-10).
 *
 * Drives {@link DiscordGatewaySession} with a FAKE socket and a controllable
 * scheduler — no network. Verifies Identify carries the MINIMAL intents + token,
 * heartbeats fire, dispatches are routed, and reconnect resumes. Then verifies the
 * AUDIT-02 hardening: dispatches apply strictly in sequence order through a
 * serialized queue, replayed sequences are deduped, a missing HEARTBEAT_ACK tears
 * down a zombie connection, and close codes are classified (fatal stops;
 * non-resumable re-identifies).
 */
import { describe, expect, it } from "vitest";

import {
  DiscordGatewaySession,
  GATEWAY_OP,
  classifyClose,
  type GatewaySocket,
  type GatewaySocketHandlers,
  type Scheduler,
} from "../src/gateway-session.js";
import { MINIMAL_GATEWAY_INTENTS } from "../src/intents.js";

const TOKEN = "REDACTED-TEST-TOKEN";
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket implements GatewaySocket {
  public readonly sent: string[] = [];
  public closed = false;
  public constructor(public readonly handlers: GatewaySocketHandlers) {}
  public send(data: string): void {
    this.sent.push(data);
  }
  public close(): void {
    this.closed = true;
    this.handlers.onClose(1006);
  }
  public frames(): { op: number; d?: unknown }[] {
    return this.sent.map((s) => JSON.parse(s) as { op: number; d?: unknown });
  }
}

class ManualScheduler implements Scheduler {
  public intervals: (() => void)[] = [];
  public timeouts: (() => void)[] = [];
  public setInterval(fn: () => void): unknown {
    this.intervals.push(fn);
    return this.intervals.length - 1;
  }
  public clearInterval(): void {}
  public setTimeout(fn: () => void): unknown {
    this.timeouts.push(fn);
    return this.timeouts.length - 1;
  }
  public clearTimeout(): void {}
  public fireIntervals(): void {
    for (const fn of this.intervals) fn();
  }
  public fireTimeouts(): void {
    const pending = this.timeouts;
    this.timeouts = [];
    for (const fn of pending) fn();
  }
}

function hello(): string {
  return JSON.stringify({ op: GATEWAY_OP.HELLO, d: { heartbeat_interval: 41250 } });
}

function ready(sessionId = "sess-1"): string {
  return JSON.stringify({
    op: GATEWAY_OP.DISPATCH,
    s: 1,
    t: "READY",
    d: { session_id: sessionId, resume_gateway_url: "wss://resume.discord/" },
  });
}

interface Harness {
  session: DiscordGatewaySession;
  sockets: FakeSocket[];
  urls: string[];
  scheduler: ManualScheduler;
  dispatched: { t: string; d: unknown }[];
  logs: { event: string; detail?: Record<string, unknown> }[];
}

function harness(onDispatch?: (t: string, d: unknown) => void | Promise<void>): Harness {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const scheduler = new ManualScheduler();
  const dispatched: { t: string; d: unknown }[] = [];
  const logs: { event: string; detail?: Record<string, unknown> }[] = [];
  const session = new DiscordGatewaySession({
    factory: (url, handlers) => {
      urls.push(url);
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    },
    token: TOKEN,
    gatewayUrl: "wss://gateway.discord/",
    scheduler,
    logger: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
    onDispatch:
      onDispatch ??
      ((t, d) => {
        dispatched.push({ t, d });
      }),
  });
  return { session, sockets, urls, scheduler, dispatched, logs };
}

describe("DiscordGatewaySession (RA-006 lifecycle)", () => {
  it("identifies with minimal intents, heartbeats, routes dispatch and reconnects", async () => {
    const h = harness();
    h.session.start();
    const first = h.sockets[0]!;
    first.handlers.onOpen();
    first.handlers.onMessage(hello());

    const identify = first.frames().find((f) => f.op === GATEWAY_OP.IDENTIFY)!;
    expect((identify.d as { intents: number }).intents).toBe(MINIMAL_GATEWAY_INTENTS);
    expect((identify.d as { token: string }).token).toBe(TOKEN);

    h.scheduler.fireIntervals();
    expect(first.frames().some((f) => f.op === GATEWAY_OP.HEARTBEAT)).toBe(true);

    first.handlers.onMessage(ready());
    first.handlers.onMessage(
      JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "MESSAGE_CREATE", d: { hello: "world" } }),
    );
    await flush();
    expect(h.dispatched).toEqual([{ t: "MESSAGE_CREATE", d: { hello: "world" } }]);
    expect(h.dispatched.some((x) => x.t === "READY")).toBe(false);

    first.close();
    h.scheduler.fireTimeouts();
    expect(h.urls).toEqual(["wss://gateway.discord/", "wss://resume.discord/"]);

    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
    h.session.stop();
  });

  it("applies dispatches strictly in sequence order via a serialized queue", async () => {
    const applied: string[] = [];
    const gates = new Map<string, () => void>();
    const h = harness(
      (_t, d) =>
        new Promise<void>((resolve) => {
          const n = (d as { n: string }).n;
          applied.push(n); // recorded when the handler STARTS
          gates.set(n, resolve);
        }),
    );
    h.session.start();
    const s = h.sockets[0]!;
    s.handlers.onMessage(hello());
    s.handlers.onMessage(ready());

    s.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: "a" } }));
    s.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 3, t: "X", d: { n: "b" } }));
    await flush();
    // Only the first handler has STARTED; the second waits behind it in the queue.
    expect(applied).toEqual(["a"]);
    gates.get("a")!();
    await flush();
    expect(applied).toEqual(["a", "b"]);
    gates.get("b")!();
    h.session.stop();
  });

  it("dedupes a replayed sequence after a resume", async () => {
    const h = harness();
    h.session.start();
    const s = h.sockets[0]!;
    s.handlers.onMessage(hello());
    s.handlers.onMessage(ready());
    s.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 5, t: "X", d: { n: 1 } }));
    await flush();
    // A resume replays s=5 (already applied) and delivers a new s=6.
    s.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 5, t: "X", d: { n: 1 } }));
    s.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 6, t: "X", d: { n: 2 } }));
    await flush();
    expect(h.dispatched.map((x) => (x.d as { n: number }).n)).toEqual([1, 2]);
  });

  it("tears down a zombie connection when a heartbeat is not ACKed", () => {
    const h = harness();
    h.session.start();
    const s = h.sockets[0]!;
    s.handlers.onMessage(hello());
    // First tick sends a heartbeat (awaiting ACK).
    h.scheduler.fireIntervals();
    expect(s.frames().some((f) => f.op === GATEWAY_OP.HEARTBEAT)).toBe(true);
    // No HEARTBEAT_ACK arrives; the next tick detects the zombie and closes.
    h.scheduler.fireIntervals();
    expect(s.closed).toBe(true);
    expect(h.logs.some((l) => l.event === "gateway.zombie_no_ack")).toBe(true);
  });

  it("does not tear down when the heartbeat IS ACKed", () => {
    const h = harness();
    h.session.start();
    const s = h.sockets[0]!;
    s.handlers.onMessage(hello());
    h.scheduler.fireIntervals();
    s.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.HEARTBEAT_ACK }));
    h.scheduler.fireIntervals();
    expect(s.closed).toBe(false);
  });

  it("classifies close codes and stops on a fatal one", () => {
    expect(classifyClose(4013)).toBe("fatal");
    expect(classifyClose(4009)).toBe("reidentify");
    expect(classifyClose(1006)).toBe("resume");

    const h = harness();
    h.session.start();
    const s = h.sockets[0]!;
    s.handlers.onMessage(hello());
    s.handlers.onMessage(ready());
    // A fatal close (disallowed intents) must NOT schedule a reconnect.
    s.handlers.onClose(4013);
    expect(h.scheduler.timeouts.length).toBe(0);
    expect(h.logs.some((l) => l.event === "gateway.close_fatal")).toBe(true);
  });

  it("re-identifies (does not resume) after a non-resumable close", () => {
    const h = harness();
    h.session.start();
    const first = h.sockets[0]!;
    first.handlers.onMessage(hello());
    first.handlers.onMessage(ready());
    // Session timed out: drop the session, reconnect, and IDENTIFY afresh.
    first.handlers.onClose(4009);
    h.scheduler.fireTimeouts();
    const second = h.sockets[1]!;
    second.handlers.onMessage(hello());
    expect(second.frames().some((f) => f.op === GATEWAY_OP.IDENTIFY)).toBe(true);
    expect(second.frames().some((f) => f.op === GATEWAY_OP.RESUME)).toBe(false);
    // A non-resumable reconnect starts from the base gateway url, not the resume url.
    expect(h.urls[1]).toBe("wss://gateway.discord/");
    h.session.stop();
  });

  it("HIGH-13: a failed handler halts the queue; the SAME event is retried before the next", async () => {
    const applied: number[] = [];
    let failFirst = true;
    const h = harness(async (_t, d) => {
      const n = (d as { n: number }).n;
      if (n === 1 && failFirst) {
        failFirst = false;
        throw new Error("transient durable failure");
      }
      applied.push(n);
    });
    h.session.start();
    const s1 = h.sockets[0]!;
    s1.handlers.onMessage(hello());
    s1.handlers.onMessage(ready());
    s1.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: 1 } }));
    s1.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 3, t: "X", d: { n: 2 } }));
    await flush();
    // seq 1 FAILED: it is NOT applied, and seq 2 must NOT slip through ahead of it.
    expect(applied).toEqual([]);
    // The failure forced a resume (socket torn down) so Discord replays the events.
    expect(s1.closed).toBe(true);
    expect(h.logs.some((l) => l.event === "gateway.dispatch_failed")).toBe(true);

    h.scheduler.fireTimeouts();
    const s2 = h.sockets[1]!;
    s2.handlers.onMessage(hello());
    // Resume replays from the last APPLIED sequence, so the failed event returns.
    expect(s2.frames().some((f) => f.op === GATEWAY_OP.RESUME)).toBe(true);
    s2.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: 1 } }));
    s2.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 3, t: "X", d: { n: 2 } }));
    await flush();
    // Now seq 1 succeeds on retry, THEN seq 2 — strict order preserved (AC4).
    expect(applied).toEqual([1, 2]);
    h.session.stop();
  });

  it("HIGH-19: the first failed dispatch after READY resumes with a NUMERIC seq, then recovers via INVALID_SESSION", async () => {
    let failFirst = true;
    const applied: number[] = [];
    const h = harness(async (_t, d) => {
      const n = (d as { n: number }).n;
      // The VERY FIRST application event after READY fails its durable handler.
      if (n === 1 && failFirst) {
        failFirst = false;
        throw new Error("first handler failure immediately after READY");
      }
      applied.push(n);
    });
    h.session.start();
    const s1 = h.sockets[0]!;
    s1.handlers.onMessage(hello());
    s1.handlers.onMessage(ready()); // READY carries s=1; no app event applied yet.
    // First application event (s=2) fails: the queue halts and a resume is forced.
    s1.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: 1 } }));
    await flush();
    expect(applied).toEqual([]);
    expect(s1.closed).toBe(true);

    // Reconnect → Hello → RESUME. Its d.seq MUST be the numeric READY baseline (1),
    // never null: Discord replays events AFTER seq 1, i.e. the failed s=2.
    h.scheduler.fireTimeouts();
    const s2 = h.sockets[1]!;
    s2.handlers.onMessage(hello());
    const resume = s2.frames().find((f) => f.op === GATEWAY_OP.RESUME);
    expect(resume).toBeDefined();
    const resumeSeq = (resume!.d as { seq: unknown }).seq;
    expect(typeof resumeSeq).toBe("number");
    expect(resumeSeq).toBe(1);

    // Discord deems the session non-resumable and INVALIDATES it. The session is
    // dropped so the next Hello re-identifies fresh (recovery, not a wedged resume).
    s2.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.INVALID_SESSION, d: false }));
    h.scheduler.fireTimeouts();
    const s3 = h.sockets[2]!;
    s3.handlers.onMessage(hello());
    expect(s3.frames().some((f) => f.op === GATEWAY_OP.IDENTIFY)).toBe(true);
    expect(s3.frames().some((f) => f.op === GATEWAY_OP.RESUME)).toBe(false);
    // A fresh (re-identified) session comes back on a fresh READY and delivers the
    // event: nothing is permanently lost even through the INVALID_SESSION path.
    s3.handlers.onMessage(ready("sess-2"));
    s3.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: 1 } }));
    await flush();
    expect(applied).toEqual([1]);
    h.session.stop();
  });

  it("HIGH-23: a stale handler SUCCESS after reconnect→INVALID_SESSION→new READY neither poisons the fresh watermark nor drops the new event", async () => {
    // Only the very first event (n=100) is gated; every other handler resolves at
    // once. We hold n=100 in flight across a full reconnect + re-identify so its
    // late completion collides with a brand-new session.
    let releaseOld: (() => void) | null = null;
    const applied: number[] = [];
    const h = harness((_t, d) => {
      const n = (d as { n: number }).n;
      if (n === 100) {
        return new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      }
      applied.push(n);
      return undefined;
    });

    h.session.start();
    const s1 = h.sockets[0]!;
    s1.handlers.onMessage(hello());
    // Old session READY at s=99; the app event s=100 starts and BLOCKS in flight.
    s1.handlers.onMessage(
      JSON.stringify({
        op: GATEWAY_OP.DISPATCH,
        s: 99,
        t: "READY",
        d: { session_id: "sess-old", resume_gateway_url: "wss://resume.discord/" },
      }),
    );
    s1.handlers.onMessage(
      JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 100, t: "X", d: { n: 100 } }),
    );
    await flush();
    expect(applied).toEqual([]);
    expect(releaseOld).not.toBeNull();

    // Reconnect (resume attempt) then Discord INVALIDATES the session → re-identify.
    s1.handlers.onClose(1006);
    h.scheduler.fireTimeouts();
    const s2 = h.sockets[1]!;
    s2.handlers.onMessage(hello());
    s2.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.INVALID_SESSION, d: false }));
    h.scheduler.fireTimeouts();
    const s3 = h.sockets[2]!;
    s3.handlers.onMessage(hello());
    // Brand-new session: READY s=1 seeds a fresh watermark, then s=2 is applied once.
    s3.handlers.onMessage(ready("sess-new"));
    s3.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: 2 } }));
    await flush();
    expect(applied).toEqual([2]);

    // The STALE handler for s=100 finally completes with SUCCESS. It must NOT write
    // lastProcessedSeq=100 (which would dedupe the fresh s=2) nor touch the new epoch.
    releaseOld!();
    await flush();
    // Deliver another fresh event to prove the watermark is still the new session's
    // (=2): s=3 applies; it would have been swallowed if the stale success set 100.
    s3.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 3, t: "X", d: { n: 3 } }));
    await flush();
    expect(applied).toEqual([2, 3]);
    // The stale success never re-applied s=100 and never closed the fresh socket.
    expect(applied).not.toContain(100);
    expect(s3.closed).toBe(false);
    expect(h.logs.some((l) => l.event === "gateway.dispatch_duplicate")).toBe(false);
    h.session.stop();
  });

  it("HIGH-23: a stale handler FAILURE after reconnect→INVALID_SESSION→new READY neither halts the fresh queue nor closes the fresh socket", async () => {
    let failOld: ((reason: Error) => void) | null = null;
    const applied: number[] = [];
    const h = harness((_t, d) => {
      const n = (d as { n: number }).n;
      if (n === 100) {
        return new Promise<void>((_resolve, reject) => {
          failOld = reject;
        });
      }
      applied.push(n);
      return undefined;
    });

    h.session.start();
    const s1 = h.sockets[0]!;
    s1.handlers.onMessage(hello());
    s1.handlers.onMessage(
      JSON.stringify({
        op: GATEWAY_OP.DISPATCH,
        s: 99,
        t: "READY",
        d: { session_id: "sess-old", resume_gateway_url: "wss://resume.discord/" },
      }),
    );
    s1.handlers.onMessage(
      JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 100, t: "X", d: { n: 100 } }),
    );
    await flush();
    expect(applied).toEqual([]);
    expect(failOld).not.toBeNull();

    s1.handlers.onClose(1006);
    h.scheduler.fireTimeouts();
    const s2 = h.sockets[1]!;
    s2.handlers.onMessage(hello());
    s2.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.INVALID_SESSION, d: false }));
    h.scheduler.fireTimeouts();
    const s3 = h.sockets[2]!;
    s3.handlers.onMessage(hello());
    s3.handlers.onMessage(ready("sess-new"));
    s3.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 2, t: "X", d: { n: 2 } }));
    await flush();
    expect(applied).toEqual([2]);

    // The STALE handler for s=100 finally REJECTS. A stale failure must NOT halt the
    // fresh queue nor tear down the fresh socket (that would drop the live session).
    failOld!(new Error("stale durable failure after new session"));
    await flush();
    // The fresh session is still live: s=3 applies exactly once, socket stays open.
    s3.handlers.onMessage(JSON.stringify({ op: GATEWAY_OP.DISPATCH, s: 3, t: "X", d: { n: 3 } }));
    await flush();
    expect(applied).toEqual([2, 3]);
    expect(s3.closed).toBe(false);
    expect(h.logs.some((l) => l.event === "gateway.dispatch_failed")).toBe(false);
    h.session.stop();
  });

  it("MEDIUM-18: one disconnect (error+close) schedules exactly one reconnect", () => {
    const h = harness();
    h.session.start();
    const s = h.sockets[0]!;
    s.handlers.onMessage(hello());
    s.handlers.onMessage(ready());
    // The ws-factory may forward BOTH error and close for a single disconnect.
    s.handlers.onClose(1006);
    s.handlers.onClose(1006);
    expect(h.scheduler.timeouts.length).toBe(1);
    h.session.stop();
  });

  it("MEDIUM-18: a stale socket closing after reconnect does not affect the new socket", () => {
    const h = harness();
    h.session.start();
    const first = h.sockets[0]!;
    first.handlers.onMessage(hello());
    first.handlers.onMessage(ready());
    first.handlers.onClose(1006);
    h.scheduler.fireTimeouts();
    const second = h.sockets[1]!;
    const timersAfterReconnect = h.scheduler.timeouts.length;
    // The OLD socket emits a late close; it must be ignored (generation-fenced).
    first.handlers.onClose(1006);
    expect(h.scheduler.timeouts.length).toBe(timersAfterReconnect);
    expect(second.closed).toBe(false);
    h.session.stop();
  });

  it("MEDIUM-18: a second start() does not spawn a parallel socket", () => {
    const h = harness();
    h.session.start();
    h.session.start();
    expect(h.sockets.length).toBe(1);
    h.session.stop();
  });
});
