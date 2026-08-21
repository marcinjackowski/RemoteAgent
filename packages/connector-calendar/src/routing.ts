/**
 * Routing: which Discord channel one calendar event goes to.
 *
 * **Criterion 6: private and SonderMind stay separate in DB, context and Discord.**
 * The destination comes from the {@link CalendarCollectionRef} — the registry's own
 * record — and never from the event. An event is built from an API response, so
 * letting it name its own channel would let a mislabelled response choose its own
 * destination.
 *
 * The DB half of criterion 6 is carried by the contracts: every persisted shape is
 * keyed by `(account_alias, calendar_id)`, so one account's rows cannot be read or
 * advanced through the other's scope. The context half is carried by `UNTRUSTED_DATA`
 * plus the fact that a summary is bounded before it is carried anywhere.
 */
import { assertSameCollection } from "./contracts.js";
import type { CalendarCollectionRef, CalendarEventRecord } from "./contracts.js";

export type CalendarRoute = Readonly<{
  discord_channel: string;
  account_alias: CalendarEventRecord["account_alias"];
  calendar_id: string;
  event_id: string;
  /** Series correlation, so a routed instance can be threaded with its series. */
  series_id: string;
}>;

/** Decide where one event goes. Refuses an event from another collection. */
export function routeCalendarEvent(
  collection: CalendarCollectionRef,
  event: CalendarEventRecord,
): CalendarRoute {
  assertSameCollection(collection, event);
  return Object.freeze({
    discord_channel: collection.discord_channel,
    account_alias: collection.account_alias,
    calendar_id: collection.calendar_id,
    event_id: event.event_id,
    series_id: event.series_id ?? event.event_id,
  });
}
