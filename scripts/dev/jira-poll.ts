/**
 * Jira board poll — does the system notice changes on the board?
 *
 * WHY A POLL AND NOT A WEBHOOK. The webhook path needs `ingestJiraWebhook` (JWT verification),
 * a `RawPayloadStore`, ingress routes that do not exist yet, and a publicly reachable URL. The
 * reconciliation path needs none of that: `reconcileJiraIssues` asks Jira "what changed since
 * my watermark" over plain REST. It is the audited production reconciler, not a shortcut — the
 * same code a scheduler tick will call.
 *
 * READ-ONLY AGAINST JIRA. The only Jira call is `GET /rest/api/3/search/jql`. Nothing is
 * created, transitioned or commented on. It DOES write locally: the watermark row that makes
 * the next run incremental (that is the point of the test).
 *
 * BASIC AUTH LIVES HERE, DELIBERATELY. `JiraRestClient` sends `Authorization: Bearer`, which is
 * correct for the OAuth 3LO path the deployment uses. A personal API token needs
 * `Basic base64(email:token)`. Rather than widen the audited client for a dev script, the
 * transport rewrites the header — the client still owns origin allow-listing, path validation,
 * redirect rejection and retry classification.
 *
 * Usage:
 *   . scripts/dev/env.sh
 *   export JIRA_ORIGIN='https://your-site.atlassian.net'
 *   export JIRA_EMAIL='you@example.com'
 *   export JIRA_API_TOKEN='...'          # id.atlassian.com/manage-profile/security/api-tokens
 *   export JIRA_PROJECT_KEY='MOBL'
 *   pnpm tsx scripts/dev/jira-poll.ts            # incremental
 *   pnpm tsx scripts/dev/jira-poll.ts --reset    # forget the watermark, re-read from scratch
 */
import {
  ConnectionRepository,
  Database,
  OwnerRepository,
  type Transaction,
} from "@remoteagent/database";
import {
  JiraRestClient,
  reconcileJiraIssues,
  type JiraHttpRequest,
  type JiraHttpResponse,
  type JiraReconciliationIssueContext,
} from "@remoteagent/connector-jira";

const OWNER_ID = "owner-local";
const CONNECTION_ID = "connection-local-jira";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    process.stderr.write(`missing required environment variable ${name}\n`);
    process.exit(1);
  }
  return value;
}

/**
 * A `fetch`-backed transport that swaps the client's `Bearer` header for Basic. The token is
 * built per request and never logged; `redirect: "manual"` is required because the client
 * rejects any redirect (a redirected Jira call can mean an SSO interception).
 */
function basicAuthTransport(email: string, token: string) {
  const credential = Buffer.from(`${email}:${token}`).toString("base64");
  return async (request: JiraHttpRequest): Promise<JiraHttpResponse> => {
    const response = await fetch(request.url, {
      method: request.method,
      redirect: "manual",
      headers: {
        ...request.headers,
        Authorization: `Basic ${credential}`,
        "User-Agent": "RemoteAgent-JiraPoll/1.0",
      },
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers,
      json: () => response.json(),
      // The client compares these against the URL it asked for, so a 3xx surfaces as a
      // rejected redirect rather than a silently followed one.
      finalUrl: response.redirected ? response.url : request.url,
      redirected: response.redirected,
    };
  };
}

async function main(): Promise<void> {
  const origin = required("JIRA_ORIGIN");
  const email = required("JIRA_EMAIL");
  const token = required("JIRA_API_TOKEN");
  const projectKey = required("JIRA_PROJECT_KEY");
  const reset = process.argv.includes("--reset");

  const originUrl = new URL(origin).origin;
  const db = Database.fromEnv();

  try {
    // The reconciler validates scope against a real `connections` row: owner must match and
    // provider must be `jira`. Seeded idempotently so re-running is safe.
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    if ((await owners.findById(db, OWNER_ID)) === null) {
      await owners.insert(db, { ownerId: OWNER_ID, displayName: "local owner" });
      process.stdout.write(`seeded owner ${OWNER_ID}\n`);
    }
    if ((await connections.findById(db, CONNECTION_ID)) === null) {
      await connections.insert(db, {
        connectionId: CONNECTION_ID,
        ownerId: OWNER_ID,
        provider: "jira",
        displayName: originUrl,
      });
      process.stdout.write(`seeded connection ${CONNECTION_ID}\n`);
    }

    if (reset) {
      // Deleting the cursor makes the next JQL start from epoch, so the whole project is
      // re-read. Useful to see everything once; the watermark then makes runs incremental.
      const deleted = await db.query(
        `DELETE FROM jira_reconciliation_watermarks
          WHERE owner_id = $1 AND connection_id = $2 AND project_key = $3`,
        [OWNER_ID, CONNECTION_ID, projectKey],
      );
      process.stdout.write(`--reset: cleared ${String(deleted.rowCount ?? 0)} cursor row(s)\n`);
    }

    const before = await db.query<{ watermark_ms: string; revision: string }>(
      `SELECT watermark_ms, revision FROM jira_reconciliation_watermarks
        WHERE owner_id = $1 AND connection_id = $2 AND project_key = $3`,
      [OWNER_ID, CONNECTION_ID, projectKey],
    );
    const previous = before.rows[0];
    process.stdout.write(
      previous === undefined
        ? `\nno watermark yet — reading ${projectKey} from the beginning\n`
        : `\nwatermark: ${new Date(Number(previous.watermark_ms)).toISOString()} (revision ${previous.revision})\n`,
    );

    const client = new JiraRestClient({
      origin: originUrl,
      allowedOrigins: [originUrl],
      getAccessToken: () => Promise.resolve(new TextEncoder().encode(token)),
      transport: basicAuthTransport(email, token),
    });

    const seen: string[] = [];
    const result = await reconcileJiraIssues(
      { ownerId: OWNER_ID, connectionId: CONNECTION_ID, projectKey },
      {
        db,
        search: client,
        // Called inside the reconciler's transaction, once per eligible issue. This script only
        // RECORDS what it saw — turning an issue into a case is `correlateJiraIssue`, which is
        // the next step, not this one.
        applyIssue: async (_tx: Transaction, context: JiraReconciliationIssueContext) => {
          const fields = context.issue.fields;
          // `summary` and `status` are TRUST-WRAPPED: the parser marks every externally
          // authored field `UNTRUSTED_DATA`, so reading them means unwrapping `.value`. That is
          // the contract doing its job — external text can never be mistaken for instructions.
          const status = fields.status?.value ?? "?";
          const summary = fields.summary?.value ?? "";
          seen.push(`${context.issue.key}  [${status}]  ${summary}`.slice(0, 110));
        },
        capturedAt: new Date().toISOString(),
      },
    );

    process.stdout.write(`\n=== ${projectKey}: ${String(result.applied)} change(s) ===\n`);
    for (const line of seen) process.stdout.write(`  ${line}\n`);
    if (seen.length === 0) {
      process.stdout.write("  (nothing new since the watermark)\n");
    }
    process.stdout.write(
      `\nwatermark now: ${new Date(result.watermarkMs).toISOString()}\n` +
        `revision: ${String(result.revision)}${result.replay ? "  (replay — no advance)" : ""}\n\n` +
        "Change something on the board and run this again: only the changed issues appear.\n\n",
    );
  } finally {
    await db.close();
  }
}

await main();
