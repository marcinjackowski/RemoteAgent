/**
 * `ingress.js` — the only unauthenticated inbound path (RA-027-WU-05).
 *
 * THIS IS THE MOST EXPOSED PROCESS IN THE SYSTEM. Jira, GitLab and Google POST to it, and
 * so can anyone. That single fact governs every decision in this file, and it is why the
 * process is separate from the workers at all: putting this endpoint on the worker tasks
 * would make the component that runs repository code also the component reachable from the
 * internet.
 *
 * WHAT IT IS ALLOWED TO DO — and the list is deliberately almost nothing:
 *
 *   1. verify the signature (`verifyJiraWebhookAuthorization`, inside `ingestJiraWebhook`);
 *   2. append the raw payload to `raw_events` (append-only);
 *   3. enqueue a wake-up through the outbox.
 *
 * It reads only webhook signing secrets, performs no provider write, invokes no model, and
 * — enforced by `infra/cdk` — may SEND to the queue but never receive from it. A full
 * compromise of this process yields the ability to insert rows into an append-only table,
 * not to act.
 *
 * 202 BEFORE PROCESSING IS A CORRECTNESS PROPERTY, not a latency optimisation. Providers
 * retry on a non-2xx, so a slow synchronous handler turns one webhook into several
 * deliveries. Deduplication makes a retry a no-op (`events_dedupe_unique`), but only if we
 * accept fast enough not to provoke one. Here the whole ingest is already fast — verify,
 * store, insert — so it completes before responding; what matters is that a FAILURE
 * classification never returns 5xx for something a retry cannot fix.
 *
 * READINESS DRIVES THE LOAD BALANCER, unlike the workers where liveness drives ECS. A task
 * that cannot reach the database would fail its insert, so it should stop receiving traffic
 * — but it must NOT be restarted, because a restart fixes nothing. Two different questions,
 * two different probes; conflating them is the RA-024 finding.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Database } from "@remoteagent/database";
import {
  ProcessRuntime,
  StructuredLogger,
  type ProcessDefinition,
} from "@remoteagent/observability";

/** Env var names, documented so a deployment knows exactly what to set. */
export const INGRESS_ENV = {
  /** Health port, probed by ECS. Separate from the webhook port. */
  healthPort: "RA_HEALTH_PORT",
  /** Webhook port, behind the load balancer. `infra/cdk` maps container port 8080. */
  webhookPort: "RA_WEBHOOK_PORT",
  drainMs: "RA_DRAIN_MS",
  maxBodyBytes: "RA_MAX_BODY_BYTES",
} as const;

export interface IngressConfig {
  readonly healthPort: number;
  readonly webhookPort: number;
  readonly drainMs: number;
  readonly maxBodyBytes: number;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export function ingressConfigFromEnv(env: Env = process.env): IngressConfig {
  return {
    // Health on 8081, webhooks on 8080: `infra/cdk` maps 8080 to the target group, so the
    // health port must NOT be the same or the load balancer would route webhooks at it.
    healthPort: positiveInt(env, INGRESS_ENV.healthPort, 8081),
    webhookPort: positiveInt(env, INGRESS_ENV.webhookPort, 8080),
    drainMs: positiveInt(env, INGRESS_ENV.drainMs, 10_000),
    // 1 MiB, matching `ingestJiraWebhook`'s own default. Enforced HERE as well, before the
    // body is fully buffered — a limit checked only after reading is not a limit.
    maxBodyBytes: positiveInt(env, INGRESS_ENV.maxBodyBytes, 1_048_576),
  };
}

/** One webhook route: a path and the ingest it delegates to. */
export interface WebhookRoute {
  readonly path: string;
  ingest(request: { authorization: string | null; body: Uint8Array }): Promise<void>;
}

/** How a request was classified. Distinct outcomes so a metric can tell them apart. */
export type IngressOutcome = "ACCEPTED" | "REJECTED" | "TOO_LARGE" | "NOT_FOUND" | "FAILED";

/**
 * Read a body with a hard cap, stopping the read once it is exceeded.
 *
 * Enforced DURING the read, not after: buffering an unbounded body and then rejecting it is
 * the memory-exhaustion path, and this endpoint is reachable by anyone.
 *
 * `pause()`, NOT `destroy()`. Destroying was the first version, and a test caught the
 * consequence: the client sees a closed connection instead of a status, so a provider learns
 * nothing and retries the same oversized body forever. Pausing stops consuming while leaving
 * the response writable, so the handler can answer 413 — which tells the provider the request
 * itself is the problem. The memory bound still holds: nothing further is buffered.
 */
async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array | "TOO_LARGE"> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) {
      request.pause();
      return "TOO_LARGE";
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The webhook server's own handle, separate from the health server `ProcessRuntime` owns. */
export interface IngressProcess extends ProcessDefinition {
  /**
   * The bound webhook port, once started.
   *
   * Exposed because `webhookPort: 0` is how a test avoids port collisions, and without this
   * there is no way to discover what it bound. Also useful in a log line: an operator
   * debugging a webhook that never arrives wants to see the port the process actually took.
   */
  readonly webhookPort: number | null;
}

export function createIngressProcess(input: {
  readonly db: Database;
  readonly config: IngressConfig;
  readonly routes: readonly WebhookRoute[];
  readonly logger?: StructuredLogger;
  readonly onOutcome?: (outcome: IngressOutcome, path: string) => void;
}): IngressProcess {
  let server: Server | null = null;
  const inFlight = new Set<Promise<unknown>>();
  const responsive = true;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const route = input.routes.find((candidate) => candidate.path === path);
    if (route === undefined || request.method !== "POST") {
      input.onOutcome?.("NOT_FOUND", path);
      response.writeHead(404).end();
      return;
    }

    const body = await readBody(request, input.config.maxBodyBytes);
    if (body === "TOO_LARGE") {
      // 413, not 500. A provider retrying a body that is too large would retry forever;
      // 413 tells it the request itself is the problem.
      input.onOutcome?.("TOO_LARGE", path);
      // `connection: close` so the unread remainder of the body is not treated as the start
      // of a pipelined next request.
      response.writeHead(413, { connection: "close" }).end();
      return;
    }

    try {
      await route.ingest({
        authorization: request.headers.authorization ?? null,
        body,
      });
      input.onOutcome?.("ACCEPTED", path);
      // 202, not 200: the payload is durably stored and a wake-up is enqueued, but the work
      // has not happened. 200 would claim more than we know.
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
    } catch (error) {
      // A verification failure is 401 and must NOT be retried — the signature will not
      // become valid. Anything else is 500, which a provider will retry, and dedupe makes
      // that safe. Classified on the error, never on a status the caller supplied.
      const kind = (error as { kind?: string; message?: string }).kind ?? "";
      const unauthorized = /signature|token|authorization|unauthorized/i.test(
        `${kind} ${String((error as Error).message)}`,
      );
      input.onOutcome?.(unauthorized ? "REJECTED" : "FAILED", path);
      // The error is logged through the REDACTING logger, never written to the response: a
      // webhook error message embeds the token it failed to verify.
      input.logger?.warn("webhook rejected", { path, error });
      response.writeHead(unauthorized ? 401 : 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: false }));
    }
  };

  return {
    name: "ingress",
    get webhookPort(): number | null {
      const address = server?.address();
      return address !== null && typeof address === "object" ? address.port : null;
    },
    start: async () => {
      server = createServer((request, response) => {
        const work = handle(request, response).catch((error: unknown) => {
          // Last-resort guard: an unhandled rejection here would take down the process and
          // drop every in-flight webhook.
          input.logger?.error("webhook handler threw outside its own guard", { error });
          if (!response.headersSent) response.writeHead(500).end();
        });
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(input.config.webhookPort, () => resolve());
      });
    },
    stopAcceptingWork: async () => {
      // Stop accepting NEW connections; in-flight requests keep their sockets. `close`
      // resolves only once existing connections end, so it is awaited in `drain`, not here.
      await new Promise<void>((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server = null;
      });
    },
    drain: async () => {
      // A webhook in flight has been verified and may be mid-insert. Dropping it means the
      // provider gets no response and retries — safe, thanks to dedupe, but a needless
      // duplicate delivery.
      await Promise.allSettled([...inFlight]);
    },
    close: async () => {
      await input.db.close();
    },
    isResponsive: () => responsive,
    isDatabaseReachable: async () => {
      try {
        await input.db.query("SELECT 1");
        return true;
      } catch {
        // Reported as unreachable ONLY. `responsive` is deliberately NOT touched here: the
        // process is answering requests fine, and marking it unresponsive would make ECS
        // restart it for a fault a restart cannot fix (RA-024).
        return false;
      }
    },
  };
}

export function bootstrapIngress(input: {
  readonly db: Database;
  readonly config: IngressConfig;
  readonly routes: readonly WebhookRoute[];
  readonly logger?: StructuredLogger;
  readonly onOutcome?: (outcome: IngressOutcome, path: string) => void;
}): { runtime: ProcessRuntime; process: IngressProcess } {
  const process_ = createIngressProcess(input);
  return {
    runtime: new ProcessRuntime(process_, {
      port: input.config.healthPort,
      drainMs: input.config.drainMs,
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    }),
    // Returned alongside, so a caller can read `webhookPort` after start. Returning only the
    // runtime would hide the port the webhook server actually bound.
    process: process_,
  };
}

/**
 * The deployment entry point.
 *
 * `routes` is EMPTY by default, so every path 404s. Deliberate: `ingestJiraWebhook` needs a
 * `RawPayloadStore`, a connection id and the signing secret, none of which RA-027 wires —
 * this task composes processes and does not add domain wiring or fetch secrets. An empty
 * route table means webhooks are refused visibly rather than accepted and dropped.
 *
 * Recorded as a limitation in RA-027's handoff.
 */
export async function main(): Promise<void> {
  const config = ingressConfigFromEnv();
  const logger = new StructuredLogger({
    sink: { log: (record) => console.log(JSON.stringify(record)) },
  });
  const db = Database.fromEnv();
  const { runtime, process: ingress } = bootstrapIngress({ db, config, routes: [], logger });
  await runtime.start();
  logger.info("ingress ready", {
    webhook_port: ingress.webhookPort,
    health_port: config.healthPort,
    routes: 0,
  });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
