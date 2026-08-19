/**
 * `@remoteagent/discord` — the private Discord case interface (RA-006).
 *
 * Maps integration events and owner conversations onto durable cases
 * (Master Plan §3.4, §4) behind a small, testable {@link DiscordGateway} port.
 * Provides deterministic owner/guild/channel authorization, idempotent + ordered
 * outbox→Discord dispatch, inbound intake for messages / `/stop` / decision +
 * approval buttons, a pinned status projection, rate-limit-aware retry, and
 * in-memory fakes (no Bedrock, no real Discord, no secrets) for tests.
 */
export const packageName = "discord" as const;

export * from "./gateway.js";
export * from "./channels.js";
export * from "./authorization.js";
export * from "./sanitize.js";
export * from "./custom-id.js";
export * from "./messages.js";
export * from "./retry.js";
export * from "./status.js";
export * from "./dispatcher.js";
export * from "./intake.js";
export * from "./inbound-audit.js";
export * from "./fakes.js";
// Marker matching/room helpers used by the production adapter (caseTag /
// statusMarker are re-exported via ./dispatcher.js). Named to avoid clashing with
// the dispatcher's re-export (AUDIT-03 HIGH-14 / MEDIUM-17).
export {
  bodyHasMarker,
  nameHasMarker,
  threadNameTagToken,
  markerSubtextOverhead,
  withMarkerSubtext,
} from "./markers.js";
