/**
 * Gmail connector contracts: account registry, history cursor, thread events.
 *
 * Contracts only — no HTTP, no filesystem. Names are prefixed `gmail*` / `Gmail*`
 * or otherwise unique; the export-intersection test guards the barrel, because ESM
 * silently drops an ambiguous name and RA-014 showed the sharper hazard (two
 * same-named schemas where the laxer one wins).
 *
 * ## Criterion 5 is the whole design: two accounts must never mix
 *
 * The user has a private mailbox and a work (SonderMind) mailbox. A single leaked
 * message between them is not a bug to be fixed later — it is the failure this
 * connector exists to prevent, and it is unrecoverable once a private mail reaches
 * a work channel.
 *
 * So isolation is not a check performed on the way past. {@link GmailAccountRef} is
 * a branded type whose ONLY producer is {@link GmailAccountRegistry.resolve}, and
 * every cursor, event, channel route and read operation demands one. An account the
 * server did not register cannot be *named* in a call. Two accounts cannot be
 * conflated because there is no code path that takes a bare string alias.
 *
 * The same reasoning drives {@link assertSameAccount}: every function that combines
 * two values checks they belong to one account, so a cursor from the private mailbox
 * cannot advance the work mailbox even if a caller mixes them up.
 *
 * ## Untrusted content
 *
 * Email is the most hostile input in the system: an attacker chooses the subject,
 * body and headers, and the recipient is a model. Every carried string is pinned to
 * `UNTRUSTED_DATA` by a literal, so no payload can relabel its own trust, and
 * {@link gmailMessageSummary} deliberately has no field for a rendered body — the
 * body is fetched separately, under {@link GmailBodyPolicy}, with provenance.
 */
import {
  TrustLevel,
  idString,
  sha256Digest,
  text,
  valueObject,
  versionedContract,
} from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on a carried header or snippet, in characters. */
export const MAX_GMAIL_SNIPPET = 2_048;

/** Upper bound on messages one reconciliation pass may report. */
export const MAX_GMAIL_BATCH = 512;

/** Raised when a Gmail request cannot be honoured safely. */
export class GmailConnectorError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "GmailConnectorError";
    this.code = code;
  }
}

/** The account alias is not registered. */
export const GMAIL_ACCOUNT_NOT_REGISTERED = "ACCOUNT_NOT_REGISTERED";

/** Two values that must share an account did not. */
export const GMAIL_ACCOUNT_MISMATCH = "ACCOUNT_MISMATCH";

/** The stored history cursor is no longer valid; a full resync is required. */
export const GMAIL_CURSOR_INVALID = "CURSOR_INVALID";

/** A body or attachment was requested without a stated purpose. */
export const GMAIL_FETCH_NOT_JUSTIFIED = "FETCH_NOT_JUSTIFIED";

/**
 * Which mailbox a value belongs to.
 *
 * A closed set of two, deliberately. An open string would let a typo create a third
 * "account" that silently shares neither channel nor credentials with either real
 * one, and the mistake would look like an empty mailbox rather than an error.
 */
export const GmailAccountAlias = {
  PRIVATE: "PRIVATE",
  SONDERMIND: "SONDERMIND",
} as const;

export type GmailAccountAlias = (typeof GmailAccountAlias)[keyof typeof GmailAccountAlias];

export const gmailAccountAlias = z.enum([GmailAccountAlias.PRIVATE, GmailAccountAlias.SONDERMIND]);

/**
 * A registered account. Obtainable ONLY from {@link GmailAccountRegistry.resolve}.
 *
 * The brand makes criterion 5 structural: every API in this package takes a
 * `GmailAccountRef`, so an unregistered account cannot appear in a call, and a value
 * carrying one account's ref cannot be passed where the other's is expected without
 * {@link assertSameAccount} refusing it.
 */
declare const registered: unique symbol;

export type GmailAccountRef = Readonly<{
  readonly [registered]: true;
  alias: GmailAccountAlias;
  /** OAuth connection backing this account. Separate per account, never shared. */
  connection_id: string;
  /** Discord channel this account's events route to. Never the other account's. */
  discord_channel: string;
  /** Google Pub/Sub subscription feeding this account's notifications. */
  subscription: string;
}>;

/** One entry of the server-owned account registry. */
export const gmailAccountEntry = valueObject({
  alias: gmailAccountAlias,
  connection_id: idString,
  discord_channel: z
    .string()
    .min(2)
    .max(100)
    .regex(/^#[a-z0-9-]+$/u, "channel must look like #name"),
  subscription: z.string().min(1).max(512),
});

export type GmailAccountEntry = z.infer<typeof gmailAccountEntry>;

/**
 * The account registry.
 *
 * Rejects a configuration in which two accounts share a connection, a channel or a
 * subscription. That check belongs here rather than in review: a shared channel is
 * the single configuration mistake that would defeat criterion 5 completely while
 * every isolation test in this package still passed, because the code would be
 * routing correctly to a channel that happens to be the wrong one.
 */
export class GmailAccountRegistry {
  readonly #byAlias = new Map<GmailAccountAlias, GmailAccountEntry>();

  public constructor(entries: readonly GmailAccountEntry[]) {
    const connections = new Set<string>();
    const channels = new Set<string>();
    const subscriptions = new Set<string>();

    for (const raw of entries) {
      const entry = gmailAccountEntry.parse(raw);
      if (this.#byAlias.has(entry.alias)) {
        throw new GmailConnectorError(
          GMAIL_ACCOUNT_MISMATCH,
          `duplicate account alias: ${entry.alias}`,
        );
      }
      // Any sharing between accounts is a configuration error, not a preference.
      for (const [set, value, what] of [
        [connections, entry.connection_id, "connection"],
        [channels, entry.discord_channel, "discord channel"],
        [subscriptions, entry.subscription, "subscription"],
      ] as const) {
        if (set.has(value)) {
          throw new GmailConnectorError(
            GMAIL_ACCOUNT_MISMATCH,
            `accounts must not share a ${what}`,
          );
        }
        set.add(value);
      }
      this.#byAlias.set(entry.alias, entry);
    }
  }

  public get aliases(): readonly GmailAccountAlias[] {
    return Object.freeze([...this.#byAlias.keys()].sort());
  }

  /** Resolve an alias, or throw. The ONLY producer of {@link GmailAccountRef}. */
  public resolve(alias: GmailAccountAlias | string): GmailAccountRef {
    const entry = this.#byAlias.get(alias as GmailAccountAlias);
    if (entry === undefined) {
      throw new GmailConnectorError(
        GMAIL_ACCOUNT_NOT_REGISTERED,
        `account is not registered: ${String(alias)}`,
      );
    }
    return Object.freeze({
      alias: entry.alias,
      connection_id: entry.connection_id,
      discord_channel: entry.discord_channel,
      subscription: entry.subscription,
    }) as GmailAccountRef;
  }

  public registered(alias: string): boolean {
    return this.#byAlias.has(alias as GmailAccountAlias);
  }
}

/**
 * Refuse to combine values from different accounts.
 *
 * Called by every function that takes both an account and an account-scoped value.
 * The alternative — trusting callers to pass matching pairs — is exactly how a
 * private cursor ends up advancing a work mailbox.
 */
export function assertSameAccount(
  account: GmailAccountRef,
  scoped: { readonly account_alias: GmailAccountAlias },
): void {
  if (account.alias !== scoped.account_alias) {
    throw new GmailConnectorError(
      GMAIL_ACCOUNT_MISMATCH,
      "value belongs to a different Gmail account",
    );
  }
}

/**
 * A Gmail history cursor.
 *
 * `history_id` is Gmail's own monotonic marker. It is a STRING because Gmail's ids
 * exceed the safe integer range, and comparing them numerically after a lossy parse
 * would silently mis-order history — so {@link compareHistoryIds} compares by length
 * then lexically, which is exact for unsigned decimal.
 */
export const gmailCursor = versionedContract({
  account_alias: gmailAccountAlias,
  history_id: z.string().regex(/^[0-9]{1,20}$/u, "historyId must be a decimal string"),
  /** When this cursor was last advanced. */
  updated_at_ms: z.int().nonnegative(),
});

export type GmailCursor = z.infer<typeof gmailCursor>;

/**
 * Compare two Gmail history ids.
 *
 * Returns <0, 0 or >0. Length-then-lexical, because these values routinely exceed
 * `Number.MAX_SAFE_INTEGER`: `Number("20000000000000001")` and
 * `Number("20000000000000002")` are the same double, so a numeric comparison would
 * report two distinct history points as equal and silently drop the gap between
 * them.
 */
export function compareHistoryIds(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/u, "");
  const b = right.replace(/^0+(?=\d)/u, "");
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What happened to a message or thread. */
export const GmailChangeKind = {
  MESSAGE_ADDED: "MESSAGE_ADDED",
  MESSAGE_DELETED: "MESSAGE_DELETED",
  LABELS_ADDED: "LABELS_ADDED",
  LABELS_REMOVED: "LABELS_REMOVED",
} as const;

export type GmailChangeKind = (typeof GmailChangeKind)[keyof typeof GmailChangeKind];

export const gmailChangeKind = z.enum([
  GmailChangeKind.MESSAGE_ADDED,
  GmailChangeKind.MESSAGE_DELETED,
  GmailChangeKind.LABELS_ADDED,
  GmailChangeKind.LABELS_REMOVED,
]);

/**
 * Thread-centric summary of one message.
 *
 * Note what is ABSENT: there is no body and no attachment content. Those are fetched
 * separately, deliberately, so that "we received a notification" and "we read the
 * contents" are different events with different justifications (criterion 6).
 *
 * Every carried string is `UNTRUSTED_DATA`. The subject and sender are chosen by
 * whoever sent the mail, and a model reads them, so a prompt-injection attempt in a
 * subject line is the expected case rather than an edge case.
 */
export const gmailMessageSummary = valueObject({
  account_alias: gmailAccountAlias,
  message_id: idString,
  thread_id: idString,
  history_id: z.string().regex(/^[0-9]{1,20}$/u),
  kind: gmailChangeKind,
  label_ids: z.array(z.string().max(128)).max(64),
  /** Header and snippet text, pinned untrusted and length-bounded. */
  untrusted: valueObject({
    trust: z.literal(TrustLevel.UNTRUSTED_DATA),
    subject: z.string().max(MAX_GMAIL_SNIPPET),
    from: z.string().max(MAX_GMAIL_SNIPPET),
    snippet: z.string().max(MAX_GMAIL_SNIPPET),
  }),
});

export type GmailMessageSummary = z.infer<typeof gmailMessageSummary>;

/** Health of one account's Gmail `watch` registration. */
export const GmailWatchHealth = {
  ACTIVE: "ACTIVE",
  /** Within the renewal window; still valid but must be renewed. */
  EXPIRING: "EXPIRING",
  EXPIRED: "EXPIRED",
  /** Never registered, or the registration was lost. */
  ABSENT: "ABSENT",
} as const;

export type GmailWatchHealth = (typeof GmailWatchHealth)[keyof typeof GmailWatchHealth];

export const gmailWatchHealth = z.enum([
  GmailWatchHealth.ACTIVE,
  GmailWatchHealth.EXPIRING,
  GmailWatchHealth.EXPIRED,
  GmailWatchHealth.ABSENT,
]);

/**
 * One account's watch state.
 *
 * Per account, never shared: criterion 3 requires each watch to be renewed
 * independently and to have its own health, so one mailbox's expiry cannot mask or
 * trigger the other's.
 */
export const gmailWatchState = versionedContract({
  account_alias: gmailAccountAlias,
  health: gmailWatchHealth,
  /** Epoch ms at which Gmail will stop delivering; `null` when absent. */
  expires_at_ms: z.int().nonnegative().nullable(),
  /** History id recorded when the watch was registered. */
  start_history_id: z
    .string()
    .regex(/^[0-9]{1,20}$/u)
    .nullable(),
});

export type GmailWatchState = z.infer<typeof gmailWatchState>;

/**
 * Why a body or attachment is being fetched.
 *
 * Criterion 6 requires that content is not fetched or logged "without need and
 * provenance". A free-text reason would be satisfied by "because", so the purpose is
 * a closed set, and the fetch API refuses without one.
 */
export const GmailFetchPurpose = {
  /** The user explicitly asked about this message. */
  USER_REQUESTED: "USER_REQUESTED",
  /** A case is actively being worked and needs this thread's content. */
  CASE_CONTEXT: "CASE_CONTEXT",
  /** An operator is diagnosing a delivery problem. */
  OPERATOR_DIAGNOSTIC: "OPERATOR_DIAGNOSTIC",
} as const;

export type GmailFetchPurpose = (typeof GmailFetchPurpose)[keyof typeof GmailFetchPurpose];

export const gmailFetchPurpose = z.enum([
  GmailFetchPurpose.USER_REQUESTED,
  GmailFetchPurpose.CASE_CONTEXT,
  GmailFetchPurpose.OPERATOR_DIAGNOSTIC,
]);

/** Server-owned limits on what may be read out of a mailbox. */
export const gmailBodyPolicy = valueObject({
  /** Maximum body bytes carried into a model's context. */
  max_body_bytes: z.int().positive().max(262_144),
  /** Whether attachment CONTENT may be fetched at all. Default is no. */
  allow_attachment_content: z.boolean(),
  /** Maximum attachment bytes, when permitted. */
  max_attachment_bytes: z.int().nonnegative().max(1_048_576),
});

export type GmailBodyPolicy = z.infer<typeof gmailBodyPolicy>;

/**
 * A fetched body, with provenance.
 *
 * `purpose` and `fetched_at_ms` are part of the record, not of a log line, so the
 * justification travels with the content and survives into any store that keeps it.
 */
export const gmailBodyRecord = versionedContract({
  account_alias: gmailAccountAlias,
  message_id: idString,
  purpose: gmailFetchPurpose,
  fetched_at_ms: z.int().nonnegative(),
  /** Redacted, bounded body text. Untrusted by construction. */
  body: valueObject({
    trust: z.literal(TrustLevel.UNTRUSTED_DATA),
    value: text,
    truncated: z.boolean(),
    original_byte_length: z.int().nonnegative(),
  }),
  /** Attachment metadata only, unless policy permitted content. */
  attachments: z
    .array(
      valueObject({
        filename: z.string().max(512),
        mime_type: z.string().max(255),
        size_bytes: z.int().nonnegative(),
        /** Digest of fetched content; `null` when only metadata was read. */
        content_digest: sha256Digest.nullable(),
      }),
    )
    .max(64),
});

export type GmailBodyRecord = z.infer<typeof gmailBodyRecord>;
