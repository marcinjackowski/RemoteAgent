/**
 * `jira.reconcile` job — poll a Jira project for changed issues and correlate each into a case
 * (RA-029-WU-04 / ADR-0009).
 *
 * WHY THIS RUNS IN THE WORKER, NOT THE SCHEDULER. The scheduler's contract is scan-and-enqueue,
 * never a provider call (`apps/scheduler/src/scheduler.ts`). `reconcileJiraIssues` DOES call
 * Jira (a REST read) and writes locally, so it belongs in the worker under a job lease — the
 * same shape as `jira.webhook.renewal`. The scheduler enqueues a `jira.reconcile` job; this run
 * executes it.
 *
 * WHY `search` IS INJECTED. `reconcileJiraIssues` needs a `JiraRestClient` holding a live access
 * token (OAuth 3LO in production, or the dev Basic-auth transport used by
 * `scripts/dev/jira-poll.ts`). That is deployment configuration and a secret, which this module
 * does not own — so a deployment WITH credentials builds the client and registers the handler,
 * and one without registers nothing (the job fails closed to the DLQ, exactly like renewal).
 *
 * The `applyIssue` callback is the seam the dev poll left as a no-op printer: here it calls the
 * real `correlateJiraIssueInTransaction`, which creates the case and enqueues the `discord_case`
 * outbox row the discord-bot relay then delivers. That closes Jira → Discord.
 */
import {
  reconcileJiraIssues,
  correlateJiraIssueInTransaction,
  type JiraReconciliationSearch,
} from "@remoteagent/connector-jira";
import type { ChannelRegistry } from "@remoteagent/discord";
import type { ConnectionAlias } from "@remoteagent/contracts";
import {
  ConnectionRepository,
  OwnerRepository,
  type Database,
  type JobLease,
} from "@remoteagent/database";

/**
 * Idempotent provisioning of the owner + Jira connection the correlator validates scope against
 * (`correlateJiraIssueInTransaction` rejects an issue whose connection is missing / not `jira` /
 * not owned by `ownerId`). Single-owner: safe to run at every worker start. Mirrors what
 * `scripts/dev/jira-poll.ts` seeds, but reusably and from the deployment's config.
 */
export async function ensureJiraConnection(input: {
  readonly db: Database;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly alias: ConnectionAlias;
  readonly displayName: string;
}): Promise<void> {
  const owners = new OwnerRepository();
  const connections = new ConnectionRepository();
  if ((await owners.findById(input.db, input.ownerId)) === null) {
    await owners.insert(input.db, { ownerId: input.ownerId, displayName: "owner" });
  }
  if ((await connections.findById(input.db, input.connectionId)) === null) {
    await connections.insert(input.db, {
      connectionId: input.connectionId,
      ownerId: input.ownerId,
      provider: "jira",
      alias: input.alias,
      displayName: input.displayName,
    });
  }
}

export interface JiraReconcileDeps {
  readonly db: Database;
  /** A `JiraRestClient` (or equivalent) holding a live token. Injected — never built here. */
  readonly search: JiraReconciliationSearch;
  readonly channelRegistry: Pick<ChannelRegistry, "routeChannelId">;
  readonly ids: { caseId(): string; entityId(): string; outboxId(): string };
  /** Authoritative capture instant (ISO 8601) recorded on each snapshot. */
  readonly now: () => string;
}

interface ReconcilePayload {
  readonly ownerId: string;
  readonly connectionId: string;
  readonly projectKey: string;
}

function parsePayload(payload: Record<string, unknown>): ReconcilePayload {
  const { ownerId, connectionId, projectKey } = payload;
  if (
    typeof ownerId !== "string" ||
    typeof connectionId !== "string" ||
    typeof projectKey !== "string"
  ) {
    throw new Error("jira.reconcile payload requires string ownerId, connectionId, projectKey");
  }
  return { ownerId, connectionId, projectKey };
}

/**
 * Build the `jira.reconcile` job runner. The returned function reconciles the project named in
 * the job payload and correlates every changed issue into a case within the reconciler's own
 * transaction — so a snapshot and its case/outbox row commit atomically.
 */
export function createJiraReconcileRun(
  deps: JiraReconcileDeps,
): (lease: JobLease) => Promise<void> {
  return async (lease: JobLease): Promise<void> => {
    const { ownerId, connectionId, projectKey } = parsePayload(lease.payload);
    await reconcileJiraIssues(
      { ownerId, connectionId, projectKey },
      {
        db: deps.db,
        search: deps.search,
        capturedAt: deps.now(),
        applyIssue: async (tx, context) => {
          const fields = context.issue.fields;
          await correlateJiraIssueInTransaction(
            tx,
            {
              eventId: context.eventId,
              issueKey: context.issue.key,
              // status/summary are UNTRUSTED_DATA wrappers; unwrap `.value`. Absent stays absent.
              ...(fields.status !== undefined ? { status: fields.status.value } : {}),
              ...(fields.summary !== undefined ? { summary: fields.summary.value } : {}),
            },
            {
              ownerId,
              connectionId,
              channelRegistry: deps.channelRegistry,
              ids: deps.ids,
            },
          );
        },
      },
    );
  };
}
