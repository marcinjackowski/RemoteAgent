/**
 * `@remoteagent/connector-gmail` — two mailboxes that cannot mix.
 *
 * The user has a private mailbox and a work one. A single message crossing between
 * them is unrecoverable once it reaches the wrong Discord channel, so isolation is
 * structural rather than checked: `GmailAccountRef` is a branded type whose only
 * producer is `GmailAccountRegistry.resolve`, every API demands one, and the registry
 * refuses a configuration in which two accounts share a connection, a channel or a
 * subscription.
 *
 * A push notification is a hint, not a change — it carries only a `historyId`. The
 * engine therefore replays from its OWN stored cursor, which is what recovers a lost
 * notification, and the cursor moves forward only, which is what makes a duplicate or
 * out-of-order delivery a no-op.
 *
 * Bodies and attachments are a separate, justified act: a purpose from a closed set is
 * required, attachment content is off by default, and the justification is part of the
 * record rather than a log line.
 *
 * The former `packageName` skeleton export is gone — one of the six duplicate
 * `packageName` literals recorded in `CTF-002`, and this task owns the file.
 */
export * from "./contracts.js";
export * from "./sync.js";
export * from "./routing.js";
