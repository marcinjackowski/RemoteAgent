/**
 * Discord gateway (WebSocket) session lifecycle (RA-006, AUDIT-01 HIGH-03,
 * AUDIT-02 MEDIUM-10).
 *
 * The dispatcher covers OUTBOUND publishing; this module is the INBOUND + lifecycle
 * half of a runnable bot. It owns the gateway connection state machine —
 * Hello → Identify/Resume → Heartbeat → Dispatch — and RECONNECTS with bounded
 * backoff, resuming the session when possible (Master Plan §11 resilience). The
 * underlying socket and the timer scheduler are INJECTED, so the whole lifecycle
 * is exercised in tests with a fake socket and no network.
 *
 * Correctness properties enforced here (AUDIT-02 MEDIUM-10):
 *
 *   - ORDER + DEDUPE: DISPATCH events are applied strictly in gateway sequence
 *     order through a serialized async queue (never fire-and-forget), and a
 *     sequence already applied (e.g. replayed after a RESUME) is skipped, so an
 *     owner message, decision or `/stop` is never applied out of order or twice.
 *   - LIVENESS: every heartbeat expects a HEARTBEAT_ACK; a missing ACK by the next
 *     tick means a zombie connection, which is torn down so a fresh (resumed)
 *     connection is established rather than silently going dead.
 *   - CLOSE CODES: close codes are classified — FATAL codes (bad auth/intents)
 *     stop the session, non-resumable codes drop the session so the next Hello
 *     re-identifies, and the rest resume.
 *
 * The Identify frame carries the MINIMAL intents (see `intents.ts`); the model can
 * never widen them. The bot token is sent only inside Identify/Resume payloads and
 * is NEVER passed to the logger.
 */
import { MINIMAL_GATEWAY_INTENTS } from "./intents.js";

/** Discord gateway opcodes we handle. */
export const GATEWAY_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/**
 * How a gateway close code is handled (AUDIT-02 MEDIUM-10):
 *   - `fatal`: unrecoverable (bad auth/intents/version); stop, do not reconnect;
 *   - `reidentify`: the session cannot be resumed; drop it and re-identify;
 *   - `resume`: reconnect and resume the existing session if we have one.
 */
export type CloseDisposition = "fatal" | "reidentify" | "resume";

/** Discord gateway close codes that are unrecoverable — never reconnect. */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4004, // Authentication failed
  4010, // Invalid shard
  4011, // Sharding required
  4012, // Invalid API version
  4013, // Invalid intent(s)
  4014, // Disallowed intent(s)
]);

/** Close codes that invalidate the session so the next connect must re-identify. */
const NON_RESUMABLE_CLOSE_CODES: ReadonlySet<number> = new Set([
  4007, // Invalid seq
  4009, // Session timed out
]);

export function classifyClose(code: number): CloseDisposition {
  if (FATAL_CLOSE_CODES.has(code)) return "fatal";
  if (NON_RESUMABLE_CLOSE_CODES.has(code)) return "reidentify";
  return "resume";
}

/** A minimal WebSocket-like socket the session drives. */
export interface GatewaySocket {
  send(data: string): void;
  close(): void;
}

export interface GatewaySocketHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number) => void;
}

/** Opens a socket to `url`, wiring the session's handlers. */
export type GatewaySocketFactory = (url: string, handlers: GatewaySocketHandlers) => GatewaySocket;

/** A single queued DISPATCH awaiting strictly-ordered, durable application. */
interface QueuedDispatch {
  seq: number | null;
  t: string;
  d: unknown;
}

/**
 * Per-generation dispatch state (AUDIT-05 HIGH-23). The queue, its single-drainer
 * flag and the halt flag are OWNED by exactly one socket generation. `#connect`
 * mints a fresh {@link DispatchEpoch}; a drainer captures its epoch and, after any
 * `await`, refuses to touch the queue, the applied watermark, the halt flag or the
 * socket unless that epoch is still the current one. A stale handler that completes
 * (success OR failure) after a reconnect / INVALID_SESSION / new READY therefore
 * mutates only its OWN dead epoch — never the fresh session's queue/watermark/socket.
 */
interface DispatchEpoch {
  /** The socket generation that owns this epoch. */
  readonly generation: number;
  /** Pending DISPATCH events for THIS generation, applied strictly in order. */
  queue: QueuedDispatch[];
  /** Whether this epoch's queue is currently draining (single drainer per epoch). */
  draining: boolean;
  /**
   * Set when a durable handler FAILED (AUDIT-03 HIGH-13). The applied watermark is
   * NOT advanced, the queue is stopped, and a reconnect+resume replays the failed
   * (and any later) event so nothing is swallowed or applied out of order.
   */
  halted: boolean;
}

/** Injectable timers so heartbeat/reconnect are deterministic under test. */
export interface Scheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface GatewaySessionDeps {
  factory: GatewaySocketFactory;
  token: string;
  gatewayUrl: string;
  /** Dispatched gateway events (t, d). Kept generic; mapping lives in lifecycle. */
  onDispatch: (t: string, d: unknown) => void | Promise<void>;
  intents?: number;
  scheduler?: Scheduler;
  /** Structured log sink. The session guarantees the token is never passed here. */
  logger?: (event: string, detail?: Record<string, unknown>) => void;
  reconnect?: { baseMs?: number; capMs?: number };
}

export class DiscordGatewaySession {
  readonly #deps: GatewaySessionDeps;
  readonly #scheduler: Scheduler;
  readonly #intents: number;
  #socket: GatewaySocket | null = null;
  #heartbeat: unknown = null;
  #reconnectTimer: unknown = null;
  #lastSeq: number | null = null;
  /** Highest DISPATCH sequence durably APPLIED (dedupe + the resume watermark). */
  #lastProcessedSeq: number | null = null;
  #sessionId: string | null = null;
  #resumeUrl: string | null = null;
  #reconnectAttempt = 0;
  #stopped = false;
  /** Whether `start()` has begun a lifecycle (so a double `start()` is a no-op). */
  #started = false;
  /**
   * Monotonic socket generation (AUDIT-03 MEDIUM-18). Every connect mints a new
   * generation; a socket's callbacks are IGNORED unless they carry the current
   * generation, so a stale socket (error+close firing together, or an old socket
   * closing after a reconnect) can neither close the new socket nor schedule a
   * second reconnect.
   */
  #generation = 0;
  /** Whether a heartbeat is outstanding without its ACK (zombie detection). */
  #awaitingAck = false;
  /**
   * The CURRENT dispatch epoch (AUDIT-05 HIGH-23): the queue + drainer + halt flag
   * owned by the live socket generation. `#connect` replaces it wholesale, so a
   * stale in-flight drainer keeps operating on its OWN (now detached) epoch and can
   * neither mutate the fresh queue/watermark nor close the fresh socket.
   */
  #epoch: DispatchEpoch = { generation: 0, queue: [], draining: false, halted: false };

  public constructor(deps: GatewaySessionDeps) {
    this.#deps = deps;
    this.#scheduler = deps.scheduler ?? realScheduler;
    this.#intents = deps.intents ?? MINIMAL_GATEWAY_INTENTS;
  }

  /** Open the gateway connection and begin the lifecycle. Idempotent per run. */
  public start(): void {
    // A second start() while already running is a no-op, so a caller cannot spawn
    // two parallel sockets/lifecycles (AUDIT-03 MEDIUM-18).
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#connect(this.#deps.gatewayUrl);
  }

  /** Permanently stop the session (no further reconnects). */
  public stop(): void {
    this.#stopped = true;
    this.#started = false;
    // Invalidate the current socket's callbacks so its close() cannot reconnect.
    this.#generation += 1;
    this.#clearHeartbeat();
    if (this.#reconnectTimer !== null) {
      this.#scheduler.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  #connect(url: string): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#awaitingAck = false;
    // Mint a FRESH dispatch epoch for this generation (AUDIT-05 HIGH-23). Any drainer
    // still awaiting under the previous epoch keeps its OWN queue/halt flag and, being
    // no longer current, cannot touch this generation's queue, watermark or socket.
    this.#epoch = { generation, queue: [], draining: false, halted: false };
    this.#log("gateway.connect", { url });
    this.#socket = this.#deps.factory(url, {
      onOpen: () => {
        if (generation === this.#generation) this.#log("gateway.open");
      },
      onMessage: (data) => {
        if (generation === this.#generation) this.#onMessage(data);
      },
      onClose: (code) => this.#onClose(code, generation),
    });
  }

  #onMessage(raw: string): void {
    let frame: { op: number; d?: unknown; s?: number | null; t?: string | null };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      this.#log("gateway.bad_frame");
      return;
    }
    if (typeof frame.s === "number") {
      this.#lastSeq = frame.s;
    }
    switch (frame.op) {
      case GATEWAY_OP.HELLO: {
        const interval = (frame.d as { heartbeat_interval?: number } | undefined)
          ?.heartbeat_interval;
        this.#startHeartbeat(typeof interval === "number" ? interval : 41_250);
        if (this.#sessionId !== null) {
          this.#resume();
        } else {
          this.#identify();
        }
        return;
      }
      case GATEWAY_OP.HEARTBEAT: {
        this.#sendHeartbeat();
        return;
      }
      case GATEWAY_OP.HEARTBEAT_ACK: {
        this.#awaitingAck = false;
        return;
      }
      case GATEWAY_OP.RECONNECT: {
        this.#log("gateway.server_reconnect");
        this.#socket?.close();
        return;
      }
      case GATEWAY_OP.INVALID_SESSION: {
        // Non-resumable: drop the session so the next Hello re-identifies.
        if (frame.d !== true) {
          this.#sessionId = null;
          this.#resumeUrl = null;
          this.#lastProcessedSeq = null;
          this.#epoch.queue = [];
        }
        this.#log("gateway.invalid_session", { resumable: frame.d === true });
        this.#socket?.close();
        return;
      }
      case GATEWAY_OP.DISPATCH: {
        const t = frame.t ?? "";
        if (t === "READY" || t === "RESUMED") {
          if (t === "READY") {
            const d = frame.d as { session_id?: string; resume_gateway_url?: string } | undefined;
            this.#sessionId = d?.session_id ?? null;
            this.#resumeUrl = d?.resume_gateway_url ?? null;
            // AUDIT-04 HIGH-19: the applied/resume watermark MUST always be a valid
            // gateway sequence once a session exists. READY establishes a FRESH
            // session, so its own sequence is the baseline. Without this, the very
            // first application event that FAILS would resume with `seq: null` —
            // which Discord rejects, invalidating the session and dropping the exact
            // event the resume was meant to replay. Seeding the watermark to READY's
            // seq makes the resume replay from a real number (Discord replays events
            // AFTER it), so the failed event is redelivered rather than lost.
            this.#lastProcessedSeq = typeof frame.s === "number" ? frame.s : this.#lastProcessedSeq;
          }
          // A RESUMED's replayed events already advanced the watermark at apply time;
          // treat RESUMED itself as a control frame (never a domain dispatch).
          this.#reconnectAttempt = 0;
          this.#log(t === "READY" ? "gateway.ready" : "gateway.resumed");
          return;
        }
        // Enqueue for strictly-ordered, durable application. Dedupe of a replayed
        // sequence (after a resume) and the applied-watermark advance both happen
        // at APPLY time — never before the handler succeeds (AUDIT-03 HIGH-13).
        const seq = typeof frame.s === "number" ? frame.s : null;
        const epoch = this.#epoch;
        epoch.queue.push({ seq, t, d: frame.d });
        void this.#drainDispatch(epoch);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Drain a SPECIFIC epoch's queued DISPATCH events strictly in order, applying
   * each through the durable handler and only THEN advancing the applied/dedupe
   * watermark (AUDIT-03 HIGH-13). A single drainer runs per epoch. If a handler
   * throws, the watermark is NOT advanced and the event is NOT dropped: the epoch
   * halts and a reconnect+resume replays the failed (and any later) event so
   * ordering and at-least-once delivery are preserved rather than swallowed.
   *
   * AUDIT-05 HIGH-23: every step is fenced on `#isCurrent(epoch)`. Because an
   * `await` yields the event loop, a reconnect / INVALID_SESSION / new READY can
   * mint a NEW epoch while this handler is in flight. After the await this drainer
   * must not mutate the fresh session: it neither advances the fresh watermark, nor
   * halts/clears the fresh queue, nor closes the fresh socket. It only ever touches
   * its OWN (now detached) epoch, whose queue no live code reads.
   */
  async #drainDispatch(epoch: DispatchEpoch): Promise<void> {
    // A stale epoch (superseded before draining even began) never runs.
    if (!this.#isCurrent(epoch)) return;
    if (epoch.draining || epoch.halted) return;
    epoch.draining = true;
    try {
      while (epoch.queue.length > 0 && !epoch.halted) {
        // Bail if a newer generation took over before this iteration.
        if (!this.#isCurrent(epoch)) return;
        const item = epoch.queue[0]!;
        // Dedupe a replayed sequence (RESUME replays missed events): skip anything
        // at or below the highest sequence already durably applied.
        if (
          item.seq !== null &&
          this.#lastProcessedSeq !== null &&
          item.seq <= this.#lastProcessedSeq
        ) {
          epoch.queue.shift();
          this.#log("gateway.dispatch_duplicate", { t: item.t, seq: item.seq });
          continue;
        }
        try {
          await this.#deps.onDispatch(item.t, item.d);
        } catch (error) {
          // HIGH-13: do not advance the watermark and do not drop the event. Halt
          // and force a resume so the SAME event is redelivered and retried in
          // order rather than lost with the next event slipping through.
          //
          // HIGH-23: if a newer generation took over during the await, this STALE
          // failure must not halt the fresh queue nor tear down the fresh socket.
          if (!this.#isCurrent(epoch)) return;
          epoch.halted = true;
          epoch.queue = [];
          this.#log("gateway.dispatch_failed", {
            t: item.t,
            seq: item.seq,
            error: errText(error),
          });
          this.#forceResume();
          return;
        }
        // HIGH-23: if a newer generation took over during the await, this STALE
        // success must not advance the fresh session's watermark or shift its queue.
        if (!this.#isCurrent(epoch)) return;
        // Success: advance the applied/dedupe watermark, THEN drop the event.
        if (item.seq !== null) this.#lastProcessedSeq = item.seq;
        epoch.queue.shift();
      }
    } finally {
      epoch.draining = false;
    }
  }

  /**
   * Whether `epoch` is still the live dispatch epoch (AUDIT-05 HIGH-23). Both the
   * object identity and the generation are checked: `#connect` replaces `#epoch`
   * and bumps `#generation`, while `#onClose`/`stop()` bump `#generation` on their
   * own, so this returns false in the whole window between a disconnect and the
   * next connect — precisely when a stale in-flight handler must not act.
   */
  #isCurrent(epoch: DispatchEpoch): boolean {
    return epoch === this.#epoch && epoch.generation === this.#generation;
  }

  /**
   * Tear down the socket after a durable handler failure so the close handler
   * reconnects and RESUMES from the last APPLIED sequence, replaying the failed
   * (and later) events in order (AUDIT-03 HIGH-13).
   */
  #forceResume(): void {
    this.#socket?.close();
  }

  #onClose(code: number, generation: number): void {
    // Ignore a stale socket's callback: an error+close pair on one socket, or an
    // old socket closing after a reconnect, must not act (AUDIT-03 MEDIUM-18).
    if (generation !== this.#generation) return;
    // Invalidate any further callbacks from THIS socket, so a duplicate close
    // (error then close) cannot schedule a second reconnect.
    this.#generation += 1;
    this.#clearHeartbeat();
    this.#socket = null;
    if (this.#stopped) return;
    const disposition = classifyClose(code);
    if (disposition === "fatal") {
      // Unrecoverable (bad auth/intents/version): stop rather than hammer Discord.
      this.#stopped = true;
      this.#started = false;
      this.#log("gateway.close_fatal", { code });
      return;
    }
    if (disposition === "reidentify") {
      this.#sessionId = null;
      this.#resumeUrl = null;
      this.#lastProcessedSeq = null;
      this.#epoch.queue = [];
    }
    // Exactly one reconnect timer per disconnect (AUDIT-03 MEDIUM-18).
    if (this.#reconnectTimer !== null) return;
    const base = this.#deps.reconnect?.baseMs ?? 1000;
    const cap = this.#deps.reconnect?.capMs ?? 30_000;
    const delay = Math.min(cap, base * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#log("gateway.close", { code, disposition, reconnectInMs: delay });
    this.#reconnectTimer = this.#scheduler.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect(
        this.#sessionId !== null
          ? (this.#resumeUrl ?? this.#deps.gatewayUrl)
          : this.#deps.gatewayUrl,
      );
    }, delay);
  }

  #identify(): void {
    this.#send({
      op: GATEWAY_OP.IDENTIFY,
      d: {
        token: this.#deps.token,
        intents: this.#intents,
        properties: { os: "linux", browser: "remoteagent", device: "remoteagent" },
      },
    });
    this.#log("gateway.identify", { intents: this.#intents });
  }

  #resume(): void {
    // Resume from the last APPLIED sequence (not merely the last received one),
    // so an event that was received but whose durable handler failed is replayed
    // and reprocessed rather than skipped (AUDIT-03 HIGH-13). Already-applied
    // replays are deduped at apply time.
    //
    // AUDIT-04 HIGH-19: NEVER send a Resume without a numeric sequence. Discord
    // requires an integer `seq`; a `null` would invalidate the session and drop the
    // event we meant to replay. The watermark is seeded from READY (see #onMessage),
    // so this is normally a real number; if it is somehow absent we fail closed by
    // dropping the session and re-identifying fresh instead of sending a bad Resume.
    if (this.#sessionId === null || this.#lastProcessedSeq === null) {
      this.#sessionId = null;
      this.#resumeUrl = null;
      this.#lastProcessedSeq = null;
      this.#epoch.queue = [];
      this.#identify();
      return;
    }
    this.#send({
      op: GATEWAY_OP.RESUME,
      d: { token: this.#deps.token, session_id: this.#sessionId, seq: this.#lastProcessedSeq },
    });
    this.#log("gateway.resume");
  }

  #startHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat();
    this.#awaitingAck = false;
    this.#heartbeat = this.#scheduler.setInterval(() => this.#onHeartbeatTick(), intervalMs);
  }

  #onHeartbeatTick(): void {
    if (this.#awaitingAck) {
      // The previous heartbeat was never ACKed: the connection is a zombie. Tear
      // it down so the close handler establishes a fresh (resumed) connection.
      this.#log("gateway.zombie_no_ack");
      this.#socket?.close();
      return;
    }
    this.#sendHeartbeat();
  }

  #sendHeartbeat(): void {
    this.#awaitingAck = true;
    this.#send({ op: GATEWAY_OP.HEARTBEAT, d: this.#lastSeq });
  }

  #clearHeartbeat(): void {
    if (this.#heartbeat !== null) {
      this.#scheduler.clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  #send(frame: unknown): void {
    this.#socket?.send(JSON.stringify(frame));
  }

  #log(event: string, detail?: Record<string, unknown>): void {
    // The logger NEVER receives the token; only structured, redacted metadata.
    this.#deps.logger?.(event, detail);
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
