/** Race-safe, crash-safe publication of immutable credential versions. */
import { randomUUID } from "node:crypto";

import { ConnectionHealth } from "@remoteagent/contracts";
import type { Provider } from "@remoteagent/contracts";

import type { CredentialVault } from "./credential-vault.js";
import {
  CredentialVaultUnavailableError,
  CredentialWriteAmbiguousError,
} from "./credential-vault.js";

export class CredentialRefreshConflictError extends Error {
  public constructor() {
    super("credential refresh lost an optimistic-concurrency race");
    this.name = new.target.name;
  }
}

/**
 * A refresh request reused an `operationId` that already belongs to a DIFFERENT
 * immutable identity (connection, owner, provider or expected revision). The
 * intent's identity is fixed at creation; a colliding or replayed idempotency key
 * must fail closed BEFORE any vault probe or metadata publish, so a credential
 * reference can never be crossed between connections/owners/aliases
 * (AUDIT-02 HIGH-04).
 */
export class CredentialRefreshIdentityError extends Error {
  public constructor(field: string) {
    super(`refresh operation id is bound to a different ${field}`);
    this.name = new.target.name;
  }
}

/**
 * A fenced mutation observed that this executor no longer holds the lease for its
 * `operationId`: another executor took the operation over (the lease expired and
 * was re-claimed, so the fencing token was bumped). A stale executor MUST stop
 * immediately and must NOT mutate status, publish metadata or revoke the shared
 * vault ref, so the current lease holder remains the single writer (AUDIT-03
 * HIGH-05). This is not itself a failure of the operation: the taking-over
 * executor is responsible for completing or reconciling it.
 */
export class CredentialRefreshLeaseLostError extends Error {
  public constructor() {
    super("credential refresh lease was taken over by another executor");
    this.name = new.target.name;
  }
}

/**
 * A durable, cross-process claim on one credential-refresh `operationId`.
 *
 * `holder` is the opaque id of the executor that owns the operation; every
 * fenced mutation is guarded by (holder, fencingToken). `fencingToken` is bumped
 * monotonically on every (re)claim, so a stale executor whose token no longer
 * matches affects zero rows and is fenced out. See migration 018.
 */
export interface RefreshLease {
  holder: string;
  fencingToken: bigint;
}

/**
 * Outcome of trying to claim the single-executor lease for an operation:
 *
 *  - `ACQUIRED` — this caller now owns the lease (the operation was free or its
 *    prior lease had expired) and may run the side effect fenced by `lease`.
 *  - `OBSERVER` — the caller may NOT run the side effect. Either the operation is
 *    in a terminal state (its recorded outcome must be read, never re-run) or a
 *    live, non-expired lease is held by another executor (the caller must wait
 *    and reconcile the winner's outcome, never acquire/write/revoke).
 */
export type RefreshLeaseAcquisition =
  | { status: "ACQUIRED"; intent: RefreshIntent; lease: RefreshLease }
  | { status: "OBSERVER"; intent: RefreshIntent };

export interface RefreshedCredential {
  secret: Uint8Array;
  expiresAt: Date;
  refreshAfter: Date;
}

/**
 * The value-free outcome of reconciling a metadata CAS whose result is unknown
 * (the publish call threw) or whose retry now reports it did not commit. It is
 * resolved by reading the connection's CURRENT metadata, never by re-running the
 * CAS, so a commit-then-crash is never mistaken for a lost race (AUDIT-04 HIGH-07):
 *
 *  - `PUBLISHED_THIS`  — the connection already points at THIS intent's ref; the
 *    (possibly earlier) CAS committed. The credential MUST be kept, never revoked.
 *  - `PUBLISHED_OTHER` — the connection advanced past this intent's expected
 *    revision under a DIFFERENT ref; a foreign write won. This intent's ref is
 *    uniquely keyed and unpublished, so revoking it cannot delete the winner's.
 *  - `NOT_PUBLISHED`   — the metadata is unchanged (still at the expected
 *    revision); the CAS provably did not commit and may be safely re-published.
 *  - `UNKNOWN`         — the current metadata could not be read; the outcome
 *    stays ambiguous and MUST NOT be revoked or auto-replayed (AGENTS.md §8).
 */
export type CredentialPublishReconciliation =
  "PUBLISHED_THIS" | "PUBLISHED_OTHER" | "NOT_PUBLISHED" | "UNKNOWN";

export interface CredentialMetadataPublisher {
  publish(input: {
    connectionId: string;
    expectedRevision: bigint;
    credentialSecretRef: string;
    health: typeof ConnectionHealth.HEALTHY;
    oauthExpiresAt: Date;
    oauthRefreshAfter: Date;
    checkedAt: Date;
  }): Promise<boolean>;
  /**
   * Value-free reconciliation of an ambiguous or lost CAS. Reads the connection's
   * CURRENT durable metadata and compares it to this intent's `(expectedRevision,
   * credentialSecretRef)`. It is a MANDATORY part of the contract: run safety must
   * never depend on a voluntary adapter method. A publisher that cannot read back
   * its own metadata must still implement this and return `UNKNOWN`, so the
   * coordinator fails closed to AMBIGUOUS without revoking or replaying, rather
   * than falling back to a destructive guess (AUDIT-05 HIGH-10).
   */
  reconcile(input: {
    connectionId: string;
    expectedRevision: bigint;
    credentialSecretRef: string;
  }): Promise<CredentialPublishReconciliation>;
}

export type RefreshIntentStatus =
  "PENDING" | "ACQUIRING" | "VAULT_WRITTEN" | "PUBLISHED" | "ABORTED" | "AMBIGUOUS";

/** The durable record of one credential-refresh operation. */
export interface RefreshIntent {
  operationId: string;
  connectionId: string;
  ownerId: string;
  provider: Provider;
  expectedRevision: bigint;
  versionId: string;
  credentialSecretRef: string;
  status: RefreshIntentStatus;
  oauthExpiresAt: Date | null;
  oauthRefreshAfter: Date | null;
}

export interface BeginRefreshIntentInput {
  operationId: string;
  connectionId: string;
  ownerId: string;
  provider: Provider;
  expectedRevision: bigint;
  versionId: string;
  credentialSecretRef: string;
}

/**
 * Durable store of refresh intents. `begin` is idempotent on `operationId`: it
 * returns the EXISTING intent (with its already-chosen versionId/ref) if one is
 * present, so a retry re-addresses the same vault object instead of minting a new
 * one. All other methods advance the durable status of an existing intent.
 */
export interface CredentialRefreshIntentStore {
  begin(input: BeginRefreshIntentInput): Promise<RefreshIntent>;
  /**
   * Claim the single-executor lease for `operationId`. This is the durable,
   * cross-process gate that makes "exactly one active executor per operation"
   * hold across processes and survive a crash: it succeeds (ACQUIRED, bumping the
   * fencing token) only when the operation is free or its prior lease expired at
   * or before the STORE's authoritative clock; a terminal operation or a live
   * foreign lease yields OBSERVER (AUDIT-03 HIGH-05).
   *
   * The lease deadline is computed by the store from `leaseDurationMs` against its
   * OWN clock, never a worker-supplied timestamp, so an executor with a skewed
   * clock can neither hold a lease past the store deadline nor prematurely take
   * over a peer that is still alive (AUDIT-04 HIGH-08).
   */
  acquireLease(
    operationId: string,
    holder: string,
    leaseDurationMs: number,
  ): Promise<RefreshLeaseAcquisition>;
  /**
   * Extend a still-held lease by `leaseDurationMs` against the store's own clock,
   * fenced by `lease`. Returns true while THIS executor still holds the lease and
   * the operation is non-terminal; returns false once the lease was taken over or
   * the operation reached a terminal state. A live executor calls this on a
   * heartbeat so a long OAuth/vault/publish side effect keeps ownership and no
   * second executor can repeat the OAuth acquire (AUDIT-04 HIGH-08).
   */
  renewLease(operationId: string, lease: RefreshLease, leaseDurationMs: number): Promise<boolean>;
  /**
   * Release a still-held lease so a retry can re-acquire immediately instead of
   * waiting for the wall-clock deadline. Fenced by `lease`: a no-op when the
   * lease was already taken over or the operation reached a terminal state.
   */
  releaseLease(operationId: string, lease: RefreshLease): Promise<void>;
  recordLifecycle(
    operationId: string,
    lifecycle: { expiresAt: Date; refreshAfter: Date },
    lease: RefreshLease,
  ): Promise<void>;
  /**
   * Durably record that the non-idempotent OAuth acquire is about to start (or may
   * already have started), fenced by `lease`. Written BEFORE `input.acquire()` so
   * a crash/takeover finds ACQUIRING and never repeats the acquire (AUDIT-05
   * HIGH-11).
   */
  markAcquiring(operationId: string, lease: RefreshLease): Promise<void>;
  markVaultWritten(operationId: string, lease: RefreshLease): Promise<void>;
  markPublished(operationId: string, lease: RefreshLease): Promise<void>;
  markAborted(operationId: string, lease: RefreshLease): Promise<void>;
  markAmbiguous(operationId: string, lease: RefreshLease): Promise<void>;
}

/** Statuses whose recorded outcome is final; they are never re-claimed. */
export const TERMINAL_REFRESH_STATUSES: ReadonlySet<RefreshIntentStatus> = new Set([
  "PUBLISHED",
  "ABORTED",
  "AMBIGUOUS",
]);

/**
 * Fail closed when an existing intent's IMMUTABLE identity does not match a new
 * request that reused its `operationId`. version_id / credential_secret_ref are
 * intentionally NOT compared: they are the stable values a retry re-addresses,
 * so a fresh candidate versionId in the request is expected and ignored.
 */
export function assertSameIntentIdentity(
  existing: {
    connectionId: string;
    ownerId: string;
    provider: Provider;
    expectedRevision: bigint;
  },
  request: {
    connectionId: string;
    ownerId: string;
    provider: Provider;
    expectedRevision: bigint;
  },
): void {
  if (existing.connectionId !== request.connectionId) {
    throw new CredentialRefreshIdentityError("connection");
  }
  if (existing.ownerId !== request.ownerId) {
    throw new CredentialRefreshIdentityError("owner");
  }
  if (existing.provider !== request.provider) {
    throw new CredentialRefreshIdentityError("provider");
  }
  if (existing.expectedRevision !== request.expectedRevision) {
    throw new CredentialRefreshIdentityError("expected revision");
  }
}

/** In-memory reference store for unit tests and single-process development. */
export class InMemoryCredentialRefreshIntentStore implements CredentialRefreshIntentStore {
  readonly #intents = new Map<string, RefreshIntent>();
  readonly #leases = new Map<
    string,
    { holder: string; fencingToken: bigint; expiresAt: Date } | null
  >();
  /** The store's own authoritative clock (AUDIT-04 HIGH-08). */
  readonly #now: () => Date;

  public constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public async begin(input: BeginRefreshIntentInput): Promise<RefreshIntent> {
    const existing = this.#intents.get(input.operationId);
    if (existing !== undefined) {
      assertSameIntentIdentity(existing, input);
      return { ...existing };
    }
    const intent: RefreshIntent = {
      operationId: input.operationId,
      connectionId: input.connectionId,
      ownerId: input.ownerId,
      provider: input.provider,
      expectedRevision: input.expectedRevision,
      versionId: input.versionId,
      credentialSecretRef: input.credentialSecretRef,
      status: "PENDING",
      oauthExpiresAt: null,
      oauthRefreshAfter: null,
    };
    this.#intents.set(input.operationId, intent);
    this.#leases.set(input.operationId, null);
    return { ...intent };
  }

  public async acquireLease(
    operationId: string,
    holder: string,
    leaseDurationMs: number,
  ): Promise<RefreshLeaseAcquisition> {
    const intent = this.#require(operationId);
    // Terminal outcomes are final and are never re-claimed: an observer reads the
    // recorded result instead of re-running the side effect (AGENTS.md §8).
    if (TERMINAL_REFRESH_STATUSES.has(intent.status)) {
      return { status: "OBSERVER", intent: { ...intent } };
    }
    const now = this.#now();
    const current = this.#leases.get(operationId) ?? null;
    const free = current === null || current.expiresAt.getTime() <= now.getTime();
    if (!free) {
      return { status: "OBSERVER", intent: { ...intent } };
    }
    const fencingToken = (current?.fencingToken ?? 0n) + 1n;
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    this.#leases.set(operationId, { holder, fencingToken, expiresAt });
    return {
      status: "ACQUIRED",
      intent: { ...intent },
      lease: { holder, fencingToken },
    };
  }

  public async renewLease(
    operationId: string,
    lease: RefreshLease,
    leaseDurationMs: number,
  ): Promise<boolean> {
    const intent = this.#intents.get(operationId);
    if (intent === undefined || TERMINAL_REFRESH_STATUSES.has(intent.status)) {
      return false;
    }
    const current = this.#leases.get(operationId) ?? null;
    if (
      current === null ||
      current.holder !== lease.holder ||
      current.fencingToken !== lease.fencingToken ||
      // An expired lease is never resurrected: a heartbeat firing past the
      // deadline loses, so a peer's takeover can never be silently undone
      // (AUDIT-05 HIGH-11).
      current.expiresAt.getTime() <= this.#now().getTime()
    ) {
      return false;
    }
    const expiresAt = new Date(this.#now().getTime() + leaseDurationMs);
    this.#leases.set(operationId, { ...current, expiresAt });
    return true;
  }

  public async releaseLease(operationId: string, lease: RefreshLease): Promise<void> {
    const current = this.#leases.get(operationId) ?? null;
    if (
      current !== null &&
      current.holder === lease.holder &&
      current.fencingToken === lease.fencingToken
    ) {
      this.#leases.set(operationId, null);
    }
  }

  public async recordLifecycle(
    operationId: string,
    lifecycle: { expiresAt: Date; refreshAfter: Date },
    lease: RefreshLease,
  ): Promise<void> {
    const intent = this.#requireFenced(operationId, lease);
    intent.oauthExpiresAt = lifecycle.expiresAt;
    intent.oauthRefreshAfter = lifecycle.refreshAfter;
  }

  public async markAcquiring(operationId: string, lease: RefreshLease): Promise<void> {
    this.#requireFenced(operationId, lease).status = "ACQUIRING";
  }

  public async markVaultWritten(operationId: string, lease: RefreshLease): Promise<void> {
    this.#requireFenced(operationId, lease).status = "VAULT_WRITTEN";
  }

  public async markPublished(operationId: string, lease: RefreshLease): Promise<void> {
    this.#requireFenced(operationId, lease).status = "PUBLISHED";
    this.#leases.set(operationId, null);
  }

  public async markAborted(operationId: string, lease: RefreshLease): Promise<void> {
    this.#requireFenced(operationId, lease).status = "ABORTED";
    this.#leases.set(operationId, null);
  }

  public async markAmbiguous(operationId: string, lease: RefreshLease): Promise<void> {
    this.#requireFenced(operationId, lease).status = "AMBIGUOUS";
    this.#leases.set(operationId, null);
  }

  #require(operationId: string): RefreshIntent {
    const intent = this.#intents.get(operationId);
    if (intent === undefined) {
      throw new Error(`unknown refresh intent: ${operationId}`);
    }
    return intent;
  }

  /** Return the intent only while `lease` is still the live holder; else fence out. */
  #requireFenced(operationId: string, lease: RefreshLease): RefreshIntent {
    const current = this.#leases.get(operationId) ?? null;
    if (
      current === null ||
      current.holder !== lease.holder ||
      current.fencingToken !== lease.fencingToken
    ) {
      throw new CredentialRefreshLeaseLostError();
    }
    return this.#require(operationId);
  }
}

export interface CredentialRefreshCoordinatorOptions {
  now?: () => Date;
  uuid?: () => string;
  /**
   * Opaque id identifying THIS executor for lease ownership. Defaults to a fresh
   * random id per coordinator instance, which is what a real process wants; tests
   * override it to force takeover/fencing scenarios deterministically.
   */
  holderId?: string;
  /** Wall-clock lifetime of a claimed lease. Must exceed one renew interval. */
  leaseDurationMs?: number;
  /**
   * Heartbeat cadence: while the side effect runs, the lease is renewed every
   * `renewIntervalMs` so a long OAuth/vault/publish keeps ownership and no second
   * executor can repeat the OAuth acquire (AUDIT-04 HIGH-08). Must be shorter than
   * `leaseDurationMs`. Set to 0 to disable renewal (single-process/tests).
   */
  renewIntervalMs?: number;
  /** Delay between observer re-checks while a live foreign lease is held. */
  observerPollMs?: number;
  /** Bound on observer re-checks before giving up (a stuck/held lease). */
  observerMaxAttempts?: number;
  /** Injectable sleep so tests can advance without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable heartbeat scheduler so tests can drive renewal deterministically. */
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RefreshRequest {
  operationId: string;
  connectionId: string;
  ownerId: string;
  provider: Provider;
  expectedRevision: bigint;
  acquire: () => Promise<RefreshedCredential>;
}

/** A live lease heartbeat: `lost()` latches once renewal fails/expires. */
interface Heartbeat {
  stop: () => void;
  lost: () => boolean;
}

/**
 * Publishes a refreshed credential with three durable guarantees:
 *
 *  1. Idempotency — a stable operation/versionId/ref is chosen once and reused on
 *     every retry, so a re-run re-addresses the same vault object.
 *  2. Reconciliation — an unknown write (timeout/crash) is resolved through a
 *     value-free vault probe before any retry or cleanup; a still-unknown outcome
 *     is left AMBIGUOUS and NOT auto-replayed (AGENTS.md §8).
 *  3. Single winner — publication is a compare-and-swap; a loser revokes only its
 *     own unpublished object and records ABORTED.
 */
export class CredentialRefreshCoordinator {
  readonly #vault: CredentialVault;
  readonly #publisher: CredentialMetadataPublisher;
  readonly #store: CredentialRefreshIntentStore;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #holderId: string;
  readonly #leaseDurationMs: number;
  readonly #renewIntervalMs: number;
  readonly #observerPollMs: number;
  readonly #observerMaxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  public constructor(
    vault: CredentialVault,
    publisher: CredentialMetadataPublisher,
    store: CredentialRefreshIntentStore,
    options: CredentialRefreshCoordinatorOptions = {},
  ) {
    this.#vault = vault;
    this.#publisher = publisher;
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.#holderId = options.holderId ?? randomUUID();
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.#renewIntervalMs = options.renewIntervalMs ?? 10_000;
    this.#observerPollMs = options.observerPollMs ?? 25;
    this.#observerMaxAttempts = options.observerMaxAttempts ?? 400;
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  public async refresh(input: RefreshRequest): Promise<string> {
    const freshVersionId = this.#uuid();
    const intent = await this.#store.begin({
      operationId: input.operationId,
      connectionId: input.connectionId,
      ownerId: input.ownerId,
      provider: input.provider,
      expectedRevision: input.expectedRevision,
      versionId: freshVersionId,
      credentialSecretRef: `connections/${input.connectionId}/credentials/${freshVersionId}`,
    });
    // Defence in depth: even if a store returned a mismatched intent, never bind
    // this request to a foreign connection/owner/provider/revision (HIGH-04).
    assertSameIntentIdentity(intent, input);

    // Exactly one executor per operationId runs the side effect. A durable,
    // cross-process lease with a fencing token elects that executor; any other
    // concurrent caller (or a retry of the same intent) either reads a terminal
    // outcome or waits as a read-only observer, so a loser never re-acquires,
    // re-writes or revokes the shared vault ref (AUDIT-03 HIGH-05).
    for (let attempt = 0; attempt < this.#observerMaxAttempts; attempt += 1) {
      const acquisition = await this.#store.acquireLease(
        input.operationId,
        this.#holderId,
        this.#leaseDurationMs,
      );
      if (acquisition.status === "ACQUIRED") {
        return await this.#execute(input, acquisition.intent, acquisition.lease);
      }
      // OBSERVER: either the operation is terminal (read the recorded outcome) or a
      // live foreign lease holds it (wait, then re-check; if the holder crashed its
      // lease will expire and this observer takes over on a later attempt).
      const settled = this.#settleTerminal(acquisition.intent);
      if (settled !== undefined) return settled;
      await this.#sleep(this.#observerPollMs);
    }
    // The lease neither resolved to a terminal outcome nor became free within the
    // budget. Do NOT run the side effect: an unknown holder still owns it.
    throw new CredentialWriteAmbiguousError(
      "credential refresh lease did not resolve within the observer budget",
    );
  }

  /** Return the recorded outcome of a terminal intent, or undefined if not terminal. */
  #settleTerminal(intent: RefreshIntent): string | undefined {
    switch (intent.status) {
      case "PUBLISHED":
        return intent.credentialSecretRef; // winner's credential is preserved
      case "ABORTED":
        throw new CredentialRefreshConflictError();
      case "AMBIGUOUS":
        throw new CredentialWriteAmbiguousError(
          "credential refresh outcome is ambiguous; manual reconciliation required",
        );
      default:
        return undefined;
    }
  }

  /** Run the side effect as the single lease holder, fencing every mutation. */
  async #execute(
    input: RefreshRequest,
    intent: RefreshIntent,
    lease: RefreshLease,
  ): Promise<string> {
    const ref = intent.credentialSecretRef;
    // acquireLease never hands out a terminal intent, so status is PENDING,
    // ACQUIRING or VAULT_WRITTEN here; guard defensively regardless.
    if (intent.status === "PUBLISHED") {
      return ref; // Recovery: the side effect already completed.
    }
    if (intent.status === "ABORTED") {
      throw new CredentialRefreshConflictError();
    }
    // Keep the lease alive for the WHOLE OAuth/vault/publish side effect. While
    // this heartbeat renews, a peer sees a live lease and stays a read-only
    // observer, so no second executor can repeat the OAuth acquire (HIGH-08). A
    // lost/failed renewal is LATCHED and re-checked before every subsequent
    // external side effect and fenced mutation: the heartbeat is a liveness
    // optimisation, never the basis of safety (AUDIT-05 HIGH-11).
    const heartbeat = this.#startHeartbeat(input.operationId, lease);
    try {
      return await this.#runFenced(input, intent, lease, ref, heartbeat);
    } catch (error) {
      if (!(error instanceof CredentialRefreshLeaseLostError)) {
        // Non-terminal exit (e.g. publish threw): free the lease so a retry can
        // re-acquire and reconcile. Never revoke the ref here — the CAS outcome
        // may be unknown. Terminal transitions already released the lease.
        await this.#store.releaseLease(input.operationId, lease);
      }
      throw error;
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * Renew the lease on a fixed cadence until stopped. Each tick reschedules the
   * next only after a successful, fenced renew; a lost/taken-over lease (renew
   * returns false or throws) LATCHES `lost` and stops the heartbeat. The
   * coordinator checks `lost()` before every external side effect and fenced
   * mutation, and the next fenced mutation also fails closed with
   * {@link CredentialRefreshLeaseLostError}.
   */
  #startHeartbeat(operationId: string, lease: RefreshLease): Heartbeat {
    if (this.#renewIntervalMs <= 0) {
      return { stop: () => {}, lost: () => false };
    }
    let stopped = false;
    let lost = false;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      let renewed = false;
      try {
        renewed = await this.#store.renewLease(operationId, lease, this.#leaseDurationMs);
      } catch {
        renewed = false;
      }
      if (stopped) return;
      if (!renewed) {
        // The lease was taken over or expired: latch the loss so the coordinator
        // stops before any further external effect or fenced mutation.
        lost = true;
        return;
      }
      handle = this.#setTimer(() => void tick(), this.#renewIntervalMs);
    };
    handle = this.#setTimer(() => void tick(), this.#renewIntervalMs);
    return {
      stop: () => {
        stopped = true;
        if (handle !== undefined) this.#clearTimer(handle);
      },
      lost: () => lost,
    };
  }

  /**
   * Fail closed if the heartbeat latched a lost/expired lease. A liveness signal
   * only: it prevents acting after ownership was lost, but real safety still
   * comes from the fenced durable mutations (AUDIT-05 HIGH-11).
   */
  #assertLeaseHeld(heartbeat: Heartbeat): void {
    if (heartbeat.lost()) {
      throw new CredentialRefreshLeaseLostError();
    }
  }

  async #runFenced(
    input: RefreshRequest,
    intent: RefreshIntent,
    lease: RefreshLease,
    ref: string,
    heartbeat: Heartbeat,
  ): Promise<string> {
    let written = intent.status === "VAULT_WRITTEN";
    let expiresAt = intent.oauthExpiresAt;
    let refreshAfter = intent.oauthRefreshAfter;

    // A takeover found the intent mid-acquire. The OAuth acquire is a
    // non-idempotent external side effect that may already have rotated the
    // token, so it is NEVER repeated. Resolve it value-free against the vault:
    // only the EXACT intent version, with its lifecycle recorded before the
    // write, proves the acquire+write completed and may resume at publish;
    // anything else is AMBIGUOUS with no re-acquire and no revoke (AUDIT-05
    // HIGH-11).
    if (!written && intent.status === "ACQUIRING") {
      this.#assertLeaseHeld(heartbeat);
      await this.#resumeAcquiring(input, intent, ref, lease);
      written = true;
    }

    if (!written) {
      // Only a brand-new PENDING intent may start the acquire. Persist ACQUIRING
      // under the fenced lease BEFORE input.acquire() so a crash/pause/takeover
      // finds ACQUIRING and never repeats the non-idempotent side effect.
      this.#assertLeaseHeld(heartbeat);
      await this.#store.markAcquiring(input.operationId, lease);
      this.#assertLeaseHeld(heartbeat);
      const credential = await input.acquire();
      // Zeroize the secret for the WHOLE scope from the moment it is received,
      // including if recordLifecycle or a fenced mutation throws (HIGH-08). The
      // secret's lifetime must never be extended by a store/fencing failure.
      try {
        expiresAt = credential.expiresAt;
        refreshAfter = credential.refreshAfter;
        // Persist the lifecycle BEFORE the write so a recovered run can publish
        // metadata matching the stored secret without re-acquiring it.
        await this.#store.recordLifecycle(
          input.operationId,
          { expiresAt: credential.expiresAt, refreshAfter: credential.refreshAfter },
          lease,
        );
        this.#assertLeaseHeld(heartbeat);
        try {
          await this.#vault.put(ref, credential.secret, { versionId: intent.versionId });
          await this.#store.markVaultWritten(input.operationId, lease);
          written = true;
        } catch (error) {
          if (error instanceof CredentialWriteAmbiguousError) {
            written = await this.#reconcileAfterAmbiguousWrite(
              input.operationId,
              ref,
              intent.versionId,
              lease,
            );
            if (!written) {
              // The write is provably absent, but the acquire already ran and the
              // intent stays ACQUIRING; a later takeover reconciles value-free and
              // fails closed to AMBIGUOUS rather than repeating the acquire.
              throw new CredentialVaultUnavailableError("credential vault write failed");
            }
          } else {
            // A definite pre-write failure never persisted anything.
            throw error;
          }
        }
      } finally {
        credential.secret.fill(0);
      }
    }

    if (expiresAt === null || refreshAfter === null) {
      await this.#store.markAmbiguous(input.operationId, lease);
      throw new CredentialWriteAmbiguousError("refreshed credential lifecycle is missing");
    }

    this.#assertLeaseHeld(heartbeat);
    let published: boolean;
    try {
      published = await this.#publisher.publish({
        // Use the intent's VERIFIED identity, never the raw request, so a
        // reference can never be published against a foreign connection/revision.
        connectionId: intent.connectionId,
        expectedRevision: intent.expectedRevision,
        credentialSecretRef: ref,
        health: ConnectionHealth.HEALTHY,
        oauthExpiresAt: expiresAt,
        oauthRefreshAfter: refreshAfter,
        checkedAt: this.#now(),
      });
    } catch (error) {
      // The CAS outcome is UNKNOWN (it may have committed then the response was
      // lost). Never revoke and never assume a lost race: reconcile value-free
      // against the CURRENT metadata. If reconciliation proves nothing committed,
      // rethrow so a retry re-publishes with the intent still VAULT_WRITTEN
      // (AUDIT-04 HIGH-07).
      return await this.#reconcilePublish(input, intent, ref, lease, error);
    }
    if (!published) {
      // The CAS reported it did not commit. It may nonetheless be THIS intent's
      // own earlier commit-then-crash (a retry now sees the revision already
      // advanced): reconcile before any revoke so we never delete a credential
      // the connection actually points at (AUDIT-04 HIGH-07).
      return await this.#reconcilePublish(input, intent, ref, lease, undefined);
    }
    await this.#store.markPublished(input.operationId, lease);
    return ref;
  }

  /**
   * Resolve an ambiguous (`thrown` set) or reportedly-lost (`thrown` undefined)
   * metadata CAS by reading the connection's CURRENT metadata value-free. Never
   * re-runs the CAS. A ref that the connection already points at is kept; a proven
   * foreign winner lets this loser revoke ONLY its own uniquely-keyed, unpublished
   * ref; anything unresolvable stays AMBIGUOUS with no revoke/replay.
   */
  async #reconcilePublish(
    input: RefreshRequest,
    intent: RefreshIntent,
    ref: string,
    lease: RefreshLease,
    thrown: unknown,
  ): Promise<string> {
    let outcome: CredentialPublishReconciliation;
    if (this.#publisher.reconcile === undefined) {
      // Value-free reconciliation is a mandatory part of the contract; a publisher
      // that cannot provide it must NEVER trigger a destructive fallback. Fail
      // closed to AMBIGUOUS with no revoke and no automatic replay (AUDIT-05
      // HIGH-10). This runtime guard defends against a non-conforming adapter.
      await this.#store.markAmbiguous(input.operationId, lease);
      throw new CredentialWriteAmbiguousError(
        "credential publisher does not support value-free reconciliation; manual reconciliation required",
      );
    }
    try {
      outcome = await this.#publisher.reconcile({
        connectionId: intent.connectionId,
        expectedRevision: intent.expectedRevision,
        credentialSecretRef: ref,
      });
    } catch {
      await this.#store.markAmbiguous(input.operationId, lease);
      throw new CredentialWriteAmbiguousError(
        "credential publish reconciliation failed; manual reconciliation required",
      );
    }
    switch (outcome) {
      case "PUBLISHED_THIS":
        // Our credential already won (possibly via a commit-then-crash). Keep it.
        await this.#store.markPublished(input.operationId, lease);
        return ref;
      case "PUBLISHED_OTHER":
        // A different operation won; our ref is uniquely keyed and unpublished, so
        // revoking it cannot delete the winner's.
        await this.#bestEffortRevoke(ref);
        await this.#store.markAborted(input.operationId, lease);
        throw new CredentialRefreshConflictError();
      case "NOT_PUBLISHED":
        if (thrown !== undefined) {
          // Provably not committed: keep VAULT_WRITTEN so a retry re-publishes.
          throw thrown;
        }
        // publish() reported false yet metadata is unchanged: no ref of ours was
        // published, so cleaning up our own object is safe.
        await this.#bestEffortRevoke(ref);
        await this.#store.markAborted(input.operationId, lease);
        throw new CredentialRefreshConflictError();
      case "UNKNOWN":
      default:
        await this.#store.markAmbiguous(input.operationId, lease);
        throw new CredentialWriteAmbiguousError(
          "credential publish outcome is ambiguous; manual reconciliation required",
        );
    }
  }

  /**
   * Resolve an intent found in ACQUIRING after a takeover WITHOUT re-running the
   * non-idempotent OAuth acquire. Reads the vault value-free: the EXACT intent
   * version, with a recorded lifecycle, proves the acquire+write completed and is
   * adopted as VAULT_WRITTEN to resume at publish; a probe failure, a missing or
   * mismatched object, or a missing lifecycle is AMBIGUOUS with no re-acquire and
   * no revoke (AUDIT-05 HIGH-11).
   */
  async #resumeAcquiring(
    input: RefreshRequest,
    intent: RefreshIntent,
    ref: string,
    lease: RefreshLease,
  ): Promise<void> {
    let probe: { exists: boolean; versionId?: string };
    try {
      probe = await this.#vault.head(ref);
    } catch {
      await this.#store.markAmbiguous(input.operationId, lease);
      throw new CredentialWriteAmbiguousError(
        "credential acquire was interrupted and could not be reconciled; manual reconciliation required",
      );
    }
    if (
      !probe.exists ||
      probe.versionId !== intent.versionId ||
      intent.oauthExpiresAt === null ||
      intent.oauthRefreshAfter === null
    ) {
      await this.#store.markAmbiguous(input.operationId, lease);
      throw new CredentialWriteAmbiguousError(
        "credential acquire outcome is ambiguous after takeover; manual reconciliation required",
      );
    }
    await this.#store.markVaultWritten(input.operationId, lease);
  }

  /** Resolve an unknown write via a value-free probe. Returns true iff written. */
  async #reconcileAfterAmbiguousWrite(
    operationId: string,
    ref: string,
    versionId: string,
    lease: RefreshLease,
  ): Promise<boolean> {
    let probe: { exists: boolean; versionId?: string };
    try {
      probe = await this.#vault.head(ref);
    } catch (error) {
      await this.#store.markAmbiguous(operationId, lease);
      throw error instanceof CredentialWriteAmbiguousError
        ? error
        : new CredentialWriteAmbiguousError("credential write outcome unknown");
    }
    if (probe.exists) {
      // Existence is not enough: the stored object must be the EXACT version this
      // intent created, otherwise we would adopt a foreign/stale side effect.
      if (probe.versionId !== versionId) {
        await this.#store.markAmbiguous(operationId, lease);
        throw new CredentialWriteAmbiguousError(
          "vault object version does not match the intent after an ambiguous write",
        );
      }
      await this.#store.markVaultWritten(operationId, lease);
      return true;
    }
    return false;
  }

  async #bestEffortRevoke(ref: string): Promise<void> {
    try {
      await this.#vault.revoke(ref);
    } catch {
      // The immutable ref was never published. Cleanup failure is safe for
      // authorization because no connection points at it.
    }
  }
}
