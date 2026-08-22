import { afterEach, describe, expect, it } from "vitest";

import { ProcessRuntime, type ProcessDefinition } from "../src/process-runtime.js";
import { StructuredLogger, type LogRecord } from "../src/tracing.js";

/**
 * The shared process bootstrap (RA-027-WU-01/WU-02, AC1, AC2, AC5).
 *
 * THE PROPERTY UNDER TEST IS THE ORDER, not that shutdown returns. A handler that stopped
 * the work loop, closed the database and then reported unready would pass every "did it
 * stop?" assertion while being wrong in the way that matters: a load balancer keeps routing
 * to a process that has already closed its database.
 *
 * So the definition below RECORDS the sequence of calls, and the assertions are about that
 * sequence. Everything is driven in-process — no child processes, no real signals — because
 * a test that spawns a process and sends it `SIGTERM` proves the same thing far less
 * reliably.
 */
const runtimes: ProcessRuntime[] = [];

afterEach(async () => {
  // Every runtime binds a port. A leaked one makes the NEXT test fail with EADDRINUSE,
  // which reads as a defect in that test rather than in this one.
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

interface Recorder {
  readonly calls: string[];
  readonly definition: ProcessDefinition;
  responsive: boolean;
  databaseReachable: boolean;
  killSwitchActive: boolean;
  drainDelayMs: number;
  drainThrows: boolean;
}

function recorder(overrides: Partial<Recorder> = {}): Recorder {
  const calls: string[] = [];
  const state: Recorder = {
    calls,
    responsive: true,
    databaseReachable: true,
    killSwitchActive: false,
    drainDelayMs: 0,
    drainThrows: false,
    ...overrides,
    definition: {
      name: "probe",
      start: () => {
        calls.push("start");
      },
      stopAcceptingWork: () => {
        calls.push("stopAcceptingWork");
      },
      drain: async () => {
        calls.push("drain");
        if (state.drainThrows) throw new Error("drain failed");
        if (state.drainDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.drainDelayMs));
        }
      },
      close: async () => {
        calls.push("close");
      },
      isResponsive: () => state.responsive,
      isDatabaseReachable: () => state.databaseReachable,
      isKillSwitchActive: () => state.killSwitchActive,
    },
  };
  return state;
}

async function hosted(state: Recorder, options = {}): Promise<ProcessRuntime> {
  // Port 0 so tests never collide, and `signals: []` so a test never installs a handler on
  // the vitest process itself — which would make a real Ctrl-C behave unpredictably.
  const runtime = new ProcessRuntime(state.definition, { port: 0, signals: [], ...options });
  runtimes.push(runtime);
  await runtime.start();
  return runtime;
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return { status: response.status, body: await response.json() };
}

describe("AC1: the process starts and shuts down in the documented order", () => {
  it("binds health BEFORE starting work", async () => {
    // A process that starts work first can be doing useful work while ECS considers it
    // unhealthy and kills it. Asserted by reaching the port immediately after `start`.
    const state = recorder();
    const runtime = await hosted(state);
    expect(runtime.port).toBeGreaterThan(0);
    expect(state.calls).toEqual(["start"]);
    expect((await get(runtime.port!, "/livez")).status).toBe(200);
  });

  it("shuts down in order: unready, stop claiming, drain, close", async () => {
    const state = recorder();
    const runtime = await hosted(state);
    const outcome = await runtime.shutdown("SIGTERM");
    // THE assertion of this suite. Reversing the first two would leave the process
    // reporting ready while doing nothing.
    expect(state.calls).toEqual(["start", "stopAcceptingWork", "drain", "close"]);
    expect(outcome).toEqual({ reason: "SIGTERM", drained: true, clean: true });
  });

  it("reports NOT READY as soon as shutdown begins, while still answering", async () => {
    // Not "connection refused": an orchestrator may read a refused connection as a crash.
    // A truthful 503 is strictly better, so the server stays bound until the end.
    const state = recorder({ drainDelayMs: 300 });
    const runtime = await hosted(state);
    const port = runtime.port!;
    const shutting = runtime.shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const ready = await get(port, "/readyz");
    expect(ready.status).toBe(503);
    expect(JSON.stringify(ready.body)).toContain("drain");
    await shutting;
  });

  it("is idempotent: a second shutdown starts no second sequence", async () => {
    // A signal arriving during shutdown must not close the database under a drain still in
    // progress.
    const state = recorder();
    const runtime = await hosted(state);
    const [first, second] = await Promise.all([
      runtime.shutdown("SIGTERM"),
      runtime.shutdown("SIGTERM"),
    ]);
    expect(state.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(first.clean).toBe(true);
    expect(second).toBeDefined();
  });

  it("bounds the drain and reports that work was abandoned", async () => {
    // An unbounded drain is a lie: ECS sends SIGKILL 30s after SIGTERM, so the process is
    // killed mid-work anyway — just without having recorded it. A bounded drain that
    // reports what it abandoned is strictly more useful.
    const records: LogRecord[] = [];
    const state = recorder({ drainDelayMs: 5_000 });
    const runtime = await hosted(state, {
      drainMs: 50,
      logger: new StructuredLogger({ sink: { log: (record) => records.push(record) } }),
    });
    const outcome = await runtime.shutdown("SIGTERM");
    expect(outcome.drained).toBe(false);
    // Still closed: an exceeded deadline must not skip cleanup.
    expect(state.calls).toContain("close");
    expect(records.map((record) => record.message)).toContain(
      "drain deadline exceeded; work in flight was abandoned",
    );
  });

  it("still closes when the drain throws, and reports it as unclean", async () => {
    const state = recorder({ drainThrows: true });
    const runtime = await hosted(state);
    const outcome = await runtime.shutdown("SIGTERM");
    expect(state.calls).toContain("close");
    expect(outcome.clean).toBe(false);
    expect(outcome.drained).toBe(false);
  });

  it("shuts down what it bound when start FAILS, so the port does not leak", async () => {
    // Otherwise the next task instance cannot bind, and the symptom (EADDRINUSE) points at
    // the wrong process.
    const state = recorder();
    const failing: ProcessDefinition = {
      ...state.definition,
      start: () => {
        throw new Error("start exploded");
      },
    };
    const runtime = new ProcessRuntime(failing, { port: 0, signals: [] });
    runtimes.push(runtime);
    await expect(runtime.start()).rejects.toThrow(/start exploded/);
    expect(runtime.outcome?.reason).toBe("START_FAILED");
    expect(runtime.port).toBeNull();
  });
});

describe("AC2: liveness and readiness are different questions", () => {
  it("both UP when everything is fine", async () => {
    const runtime = await hosted(recorder());
    expect((await get(runtime.port!, "/livez")).status).toBe(200);
    expect((await get(runtime.port!, "/readyz")).status).toBe(200);
  });

  it("a database outage makes the process UNREADY but still ALIVE", async () => {
    // The load-bearing case, and the RA-024 finding applied where it has teeth: ECS
    // restarts on a failed health check, so a liveness probe consulting PostgreSQL would
    // restart-loop every worker during an outage — exactly when their in-flight leases and
    // logs are the only evidence available.
    const state = recorder({ databaseReachable: false });
    const runtime = await hosted(state);
    expect((await get(runtime.port!, "/livez")).status).toBe(200);
    expect((await get(runtime.port!, "/readyz")).status).toBe(503);
  });

  it("NEVER calls the database for a liveness probe", async () => {
    // Structural, not behavioural: even a liveness check that happened to return UP would
    // be wrong if it consulted the database, because the next outage would change that.
    let databaseCalls = 0;
    const state = recorder();
    const counting: ProcessDefinition = {
      ...state.definition,
      isDatabaseReachable: () => {
        databaseCalls += 1;
        return true;
      },
    };
    const runtime = new ProcessRuntime(counting, { port: 0, signals: [] });
    runtimes.push(runtime);
    await runtime.start();
    await get(runtime.port!, "/livez");
    expect(databaseCalls).toBe(0);
    await get(runtime.port!, "/readyz");
    expect(databaseCalls).toBe(1);
  });

  it("an unresponsive process is DOWN on both", async () => {
    const state = recorder({ responsive: false });
    const runtime = await hosted(state);
    expect((await get(runtime.port!, "/livez")).status).toBe(503);
    expect((await get(runtime.port!, "/readyz")).status).toBe(503);
  });

  it("a kill switch changes NEITHER verdict, but is reported", async () => {
    // AC6 of RA-024: a kill switch stops external effects while preserving reads and
    // evidence. Reporting unready would stop the reconciliation and audit reads an operator
    // needs mid-incident.
    const state = recorder({ killSwitchActive: true });
    const runtime = await hosted(state);
    const live = await get(runtime.port!, "/livez");
    const ready = await get(runtime.port!, "/readyz");
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(JSON.stringify(ready.body)).toContain("kill_switch");
  });

  it("returns 503 for DEGRADED, not 200", async () => {
    // A load balancer reads the status code, not the body. A degraded process returning 200
    // keeps receiving traffic it cannot serve.
    const state = recorder({ databaseReachable: false });
    const runtime = await hosted(state);
    const ready = await get(runtime.port!, "/readyz");
    expect(ready.status).toBe(503);
    expect(JSON.stringify(ready.body)).toContain("DEGRADED");
  });

  it("exposes ONLY the two health paths", async () => {
    // This server is reachable from the load balancer, so every extra path is surface on
    // the one component an orchestrator must reach.
    const runtime = await hosted(recorder());
    for (const path of ["/", "/metrics", "/debug", "/livez/../secrets"]) {
      expect((await get(runtime.port!, path)).status, path).toBe(404);
    }
  });
});

describe("AC5: no secret reaches a health response or a log line", () => {
  it("masks a secret that a health detail would otherwise carry", async () => {
    // A `detail` string is written by `health.ts` and is normally safe, but it is the kind
    // of field a future change would interpolate an error into. Asserted through the real
    // response body.
    const state = recorder();
    const leaky: ProcessDefinition = {
      ...state.definition,
      name: "probe-glpat-ABCDEFGHIJKLMNOPQRST",
    };
    const runtime = new ProcessRuntime(leaky, { port: 0, signals: [] });
    runtimes.push(runtime);
    await runtime.start();
    const body = JSON.stringify((await get(runtime.port!, "/readyz")).body);
    // The process NAME is attacker-influenced only via deployment config, but it is also
    // the simplest way to prove the response is not a raw echo. A leaked token here would
    // be readable by anything that can reach the load balancer's health path.
    expect(body).not.toContain("ABCDEFGHIJKLMNOPQRST");
  });

  it("masks a secret in a shutdown log line", async () => {
    const records: LogRecord[] = [];
    const state = recorder({ drainThrows: true });
    const throwing: ProcessDefinition = {
      ...state.definition,
      drain: async () => {
        throw new Error("failed at /Users/marcinjackowski/Private/RemoteAgent/x.ts");
      },
    };
    const runtime = new ProcessRuntime(throwing, {
      port: 0,
      signals: [],
      logger: new StructuredLogger({ sink: { log: (record) => records.push(record) } }),
    });
    runtimes.push(runtime);
    await runtime.start();
    await runtime.shutdown("SIGTERM");
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("marcinjackowski/Private");
  });
});
