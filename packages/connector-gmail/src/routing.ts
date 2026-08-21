/**
 * Routing and content access: where an event goes, and what may be read.
 *
 * **Criterion 5: a private event never reaches a SonderMind channel or context, and
 * vice versa.** {@link routeGmailEvent} derives the destination from the account REF
 * — the registry's own record — and refuses when the event's alias disagrees with it.
 * The channel is never taken from the event, because an event is built from an API
 * response and a mislabelled response would then choose its own destination.
 *
 * The adversarial case this defeats: a work mailbox response that claims
 * `account_alias: "PRIVATE"`. Deriving the channel from the ref means such a response
 * is refused rather than routed, and the refusal names a mismatch rather than quietly
 * delivering to the wrong place.
 *
 * **Criterion 6: bodies and attachments are not fetched or logged without need and
 * provenance.** {@link fetchGmailBody} demands a {@link GmailFetchPurpose} from a
 * closed set, enforces the server-owned {@link GmailBodyPolicy}, and returns the
 * purpose and timestamp as part of the RECORD rather than as a log line — so the
 * justification travels with the content into whatever stores it. Attachment content
 * is off unless policy allows it; metadata alone is the default.
 *
 * Bodies are redacted with `redactCommandOutput` before they are carried. Email is
 * the most hostile input in the system, and a body routinely contains tokens, host
 * paths and key material — quoted from a CI failure, pasted by a colleague, or sent
 * deliberately. See `CTF-006` for why this rather than `SecretRedactor`.
 */
import { redactCommandOutput } from "@remoteagent/implementation-tools";

import {
  GMAIL_FETCH_NOT_JUSTIFIED,
  GmailConnectorError,
  assertSameAccount,
  gmailBodyRecord,
  gmailFetchPurpose,
} from "./contracts.js";
import type {
  GmailAccountRef,
  GmailBodyPolicy,
  GmailBodyRecord,
  GmailFetchPurpose,
  GmailMessageSummary,
} from "./contracts.js";

/** Default policy: read enough to summarise, never attachment content. */
export const DEFAULT_GMAIL_BODY_POLICY: GmailBodyPolicy = Object.freeze({
  max_body_bytes: 65_536,
  // Off by default. An attachment is the most likely place for a payload the system
  // has no reason to open, and turning this on must be a deliberate server decision.
  allow_attachment_content: false,
  max_attachment_bytes: 0,
});

export type GmailRoute = Readonly<{
  discord_channel: string;
  account_alias: GmailMessageSummary["account_alias"];
  thread_id: string;
  message_id: string;
}>;

/**
 * Decide where one event goes.
 *
 * The channel comes from the account ref, never from the event. Criterion 5 is not
 * "check the alias matches before routing" — it is "the destination is not derivable
 * from attacker-influenced data at all".
 */
export function routeGmailEvent(account: GmailAccountRef, event: GmailMessageSummary): GmailRoute {
  // Refuses a response whose alias disagrees with the account it arrived under.
  assertSameAccount(account, event);
  return Object.freeze({
    discord_channel: account.discord_channel,
    account_alias: account.alias,
    thread_id: event.thread_id,
    message_id: event.message_id,
  });
}

/** Fetches raw content. Implemented by a real Gmail client. */
export interface GmailContentApi {
  getBody(input: { account: GmailAccountRef; messageId: string }): Promise<{
    body: string;
    attachments: readonly {
      filename: string;
      mimeType: string;
      sizeBytes: number;
      content?: string;
    }[];
  }>;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Cut at a code-point boundary so clipping cannot split a surrogate pair. */
function clipToBytes(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  let low = 0;
  let high = value.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const code = best > 0 ? value.charCodeAt(best - 1) : 0;
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? best - 1 : best);
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export type GmailFetchOptions = Readonly<{
  api: GmailContentApi;
  account: GmailAccountRef;
  message: GmailMessageSummary;
  /** Required, from a closed set. There is no default. */
  purpose: GmailFetchPurpose;
  policy?: GmailBodyPolicy;
  knownSecrets?: readonly string[];
  now?: () => number;
}>;

/**
 * Fetch a message body under policy, with provenance.
 *
 * Refuses an unrecognised purpose rather than defaulting to one: a default purpose
 * would make "we had a reason" unfalsifiable, which is the opposite of what criterion
 * 6 asks for.
 */
export async function fetchGmailBody(options: GmailFetchOptions): Promise<GmailBodyRecord> {
  const { api, account, message } = options;
  assertSameAccount(account, message);

  const purpose = gmailFetchPurpose.safeParse(options.purpose);
  if (!purpose.success) {
    throw new GmailConnectorError(
      GMAIL_FETCH_NOT_JUSTIFIED,
      "a body fetch requires a recognised purpose",
    );
  }

  const policy = options.policy ?? DEFAULT_GMAIL_BODY_POLICY;
  const now = options.now ?? (() => Date.now());
  const fetched = await api.getBody({ account, messageId: message.message_id });

  // Redact BEFORE bounding and before anything is carried, so no unredacted byte
  // reaches a caller, a log or a store.
  const knownSecrets = options.knownSecrets ?? [];
  const redacted = redactCommandOutput(fetched.body, knownSecrets);
  const originalByteLength = byteLength(redacted);
  const carried = clipToBytes(redacted, policy.max_body_bytes);

  const attachments = await Promise.all(
    fetched.attachments.map(async (attachment) => {
      // Content only when policy allows AND it fits. Otherwise metadata only, with a
      // null digest that says plainly "we did not read this".
      const permitted =
        policy.allow_attachment_content &&
        attachment.content !== undefined &&
        attachment.sizeBytes <= policy.max_attachment_bytes;
      return {
        // The FILENAME is redacted too. Found by an audit probe: an attachment named
        // `glpat-....txt` carried the token verbatim into the record even though the
        // body was clean and the content was never read. A filename is
        // sender-controlled text like any other, and "we only kept metadata" is not
        // a reason to treat it as safe.
        filename: redactCommandOutput(attachment.filename, knownSecrets),
        mime_type: attachment.mimeType,
        size_bytes: attachment.sizeBytes,
        content_digest: permitted ? await sha256(attachment.content ?? "") : null,
      };
    }),
  );

  return gmailBodyRecord.parse({
    schema_version: 1,
    account_alias: account.alias,
    message_id: message.message_id,
    purpose: purpose.data,
    fetched_at_ms: now(),
    body: {
      trust: "UNTRUSTED_DATA",
      value: carried,
      truncated: byteLength(carried) !== originalByteLength,
      original_byte_length: originalByteLength,
    },
    attachments,
  });
}
