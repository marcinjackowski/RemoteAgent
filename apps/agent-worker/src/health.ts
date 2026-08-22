/**
 * `health.js` — the health CLI every container's health check invokes (RA-027-WU-02).
 *
 * `infra/cdk` sets the ECS health check to `node dist/health.js --liveness`, so this is not
 * a server: it is a one-shot probe that runs INSIDE the container, queries the process's own
 * health endpoint over localhost and exits 0 or 1. Docker and ECS read the exit code.
 *
 * WHY A CLI AND NOT A DIRECT `curl`. `curl` is not guaranteed to be in a slim Node image,
 * and adding it to the image to run a health check enlarges the attack surface of every
 * container for one HTTP request. Node is already there.
 *
 * WHY IT PROBES OVER HTTP rather than importing `liveness()` directly: importing would build
 * a SECOND health view inside a separate process, and it would report on that process — a
 * fresh one with no work in flight — rather than on the running server. It would answer
 * "can Node start?", which is never the question.
 *
 * `--liveness` IS THE DEFAULT, deliberately. A health check that silently probed readiness
 * would make ECS restart every task during a database outage, which is the RA-024 finding
 * this repository has now applied in four places. Getting the flag wrong must fail toward
 * "do not restart".
 */
const LIVENESS_PATH = "/livez";
const READINESS_PATH = "/readyz";

export interface ProbeOptions {
  readonly port: number;
  readonly path: string;
  readonly timeoutMs: number;
}

/** Which endpoint to probe, from argv. Anything unrecognised means liveness. */
export function probePathFromArgv(argv: readonly string[]): string {
  // `--readiness` must be asked for explicitly. See the note above: defaulting the other way
  // turns a database outage into a restart loop.
  return argv.includes("--readiness") ? READINESS_PATH : LIVENESS_PATH;
}

export function probeOptionsFromEnv(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): ProbeOptions {
  const raw = env.RA_HEALTH_PORT?.trim();
  const port = raw === undefined || raw === "" ? 8080 : Number(raw);
  if (!Number.isSafeInteger(port) || port < 1) {
    throw new Error(`RA_HEALTH_PORT must be a positive integer, got ${String(raw)}`);
  }
  return {
    port,
    path: probePathFromArgv(argv),
    // Under the 5s timeout `infra/cdk` gives the health check, so the probe's own failure is
    // reported rather than the orchestrator's timeout — which would be indistinguishable
    // from a hung process.
    timeoutMs: 3_000,
  };
}

/** Probe once. Resolves to the exit code: 0 healthy, 1 not. */
export async function probe(options: ProbeOptions): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${String(options.port)}${options.path}`, {
      signal: controller.signal,
    });
    // The status code is the whole answer. `ProcessRuntime` returns 200 only for UP, and 503
    // for DEGRADED as well as DOWN — deliberately, because a load balancer reads the code.
    return response.status === 200 ? 0 : 1;
  } catch {
    // Unreachable, refused or timed out. All mean not healthy; none is distinguishable from
    // the others by an orchestrator anyway, and a probe that tried to distinguish them would
    // be guessing.
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  probe(probeOptionsFromEnv())
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // A throw here (a bad `RA_HEALTH_PORT`) is itself unhealthy: the container is
      // misconfigured, and reporting healthy would hide that behind a working process.
      process.exitCode = 1;
    });
}
