/**
 * `@remoteagent/connector-calendar` — two accounts, many calendars, no mixing.
 *
 * The unit of scope is the (account, calendar) PAIR, not the account: one account
 * commonly watches several calendars, each with its own sync token and watch channel,
 * and a per-account cursor would let one calendar's response advance another's
 * position and skip events.
 *
 * Two things differ fundamentally from the Gmail connector, and the difference drives
 * the design rather than being incidental. A Calendar `syncToken` is OPAQUE — no
 * ordering, no local validation — so staleness cannot be detected by comparison and
 * expiry is only discoverable by using the token and receiving HTTP 410. And a
 * notification has no body at all, so it can only authenticate itself and name a
 * collection.
 *
 * Consequently deduplication keys on `(event_id, etag)` rather than on the cursor:
 * Google changes the etag on every mutation, so the same etag twice is a duplicate —
 * which is exactly what a deliberately overlapping renewal channel delivers — while a
 * real second edit carries a new etag and is emitted.
 *
 * The former `packageName` skeleton export is gone: another of the six `packageName`
 * duplicates recorded in `CTF-002`, and this task owns the file.
 */
export * from "./contracts.js";
export * from "./sync.js";
export * from "./routing.js";
