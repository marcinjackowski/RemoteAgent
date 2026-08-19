/**
 * Production inbound entry point with durable denial audit (RA-006, AUDIT-01
 * MEDIUM-04).
 *
 * {@link handleInbound} only computes an authorization outcome; on its own it
 * does not persist anything, so a caller that merely acked the interaction would
 * leave no evidence of an unauthorized probe after a restart (AUDIT-01 MEDIUM-04).
 * {@link processInbound} is the composition the production bot uses: it authorizes
 * and normalizes the interaction and, when the outcome is `denied`, writes a
 * CONTENT-FREE row to the append-only audit log BEFORE returning — so the denial
 * is durable regardless of what the ack path does next.
 *
 * The audit row deliberately carries only ids + reason (never the message body or
 * any component payload), so an unauthorized probe can never smuggle content into
 * the audit log (acceptance criterion 2).
 */
import type { AuditLogRepository, Queryable } from "@remoteagent/database";

import type { ChannelRegistry } from "./channels.js";
import type { ThreadCaseResolver } from "./authorization.js";
import { handleInbound, type InboundInteraction, type IntakeOutcome } from "./intake.js";

export interface InboundProcessorDeps {
  registry: ChannelRegistry;
  resolveThreadCase: ThreadCaseResolver;
  /** Append-only audit sink (RA-003); denials are recorded here. */
  audit: AuditLogRepository;
  /** Queryable the audit row is inserted through (pool or an active transaction). */
  db: Queryable;
}

/**
 * Authorize + normalize an inbound interaction and DURABLY record a content-free
 * audit row when it is denied, before returning. Returns the same outcome shape as
 * {@link handleInbound} so callers can drive their ack/response from it.
 */
export async function processInbound(
  deps: InboundProcessorDeps,
  interaction: InboundInteraction,
): Promise<IntakeOutcome> {
  const outcome = await handleInbound(deps.registry, interaction, deps.resolveThreadCase);
  if (outcome.kind === "denied") {
    // Content-free by construction: DeniedAudit.detail carries only ids + reason.
    await deps.audit.record(deps.db, {
      actor: outcome.audit.actor,
      action: outcome.audit.action,
      outcome: outcome.audit.outcome,
      detail: outcome.audit.detail,
    });
  }
  return outcome;
}
