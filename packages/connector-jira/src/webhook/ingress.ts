import { createHash } from "node:crypto";

import type { Database, Transaction } from "@remoteagent/database";
import {
  JiraWebhookIngressConflictError,
  JiraWebhookIngressRepository,
} from "@remoteagent/database";

import { JiraWebhookIngressError } from "../errors.js";
import { verifyJiraWebhookAuthorization, type JiraWebhookVerifierOptions } from "./verify.js";

export interface RawPayloadStoreResult {
  ref: string;
  digest: string;
}
export interface RawPayloadStore {
  putIfAbsent(input: { key: string; body: Uint8Array }): Promise<RawPayloadStoreResult>;
}

export interface JiraWebhookIngressOptions extends JiraWebhookVerifierOptions {
  db: Database;
  rawPayloadStore: RawPayloadStore;
  connectionId: string;
  ownerId: string;
  maxBodyBytes?: number;
}

export interface JiraWebhookIngressResult {
  accepted: boolean;
  rawEventId: string;
  outboxId: string;
}

export interface JiraWebhookRequest {
  authorization: string | null | undefined;
  body: Uint8Array;
}

export async function ingestJiraWebhook(
  request: JiraWebhookRequest,
  options: JiraWebhookIngressOptions,
): Promise<JiraWebhookIngressResult> {
  const { authorization, body } = request;
  const max = options.maxBodyBytes ?? 1_048_576;
  if (body.byteLength > max) throw new JiraWebhookIngressError("body_limit");
  const verified = await verifyJiraWebhookAuthorization(authorization, options);
  const identity = createHash("sha256")
    .update(`${options.connectionId}\0${options.ownerId}\0${verified.claims.jti}`)
    .digest("hex");
  const key = `jira:${identity}`;
  const incomingDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const stored = await options.rawPayloadStore.putIfAbsent({ key, body });
  const storedDigest = stored.digest.startsWith("sha256:")
    ? stored.digest
    : `sha256:${stored.digest}`;
  if (storedDigest !== incomingDigest) throw new JiraWebhookIngressError("identity_conflict");
  try {
    return await options.db.withTransaction(async (tx: Transaction) =>
      new JiraWebhookIngressRepository().persist(tx, {
        rawEventId: `jira_raw_${identity}`,
        outboxId: `jira_outbox_${identity}`,
        connectionId: options.connectionId,
        ownerId: options.ownerId,
        payloadRef: stored.ref,
        payloadDigest: incomingDigest,
        payloadSizeBytes: body.byteLength,
      }),
    );
  } catch (error) {
    if (error instanceof JiraWebhookIngressConflictError) {
      throw new JiraWebhookIngressError(
        error.kind === "outbox" ? "outbox_conflict" : "identity_conflict",
      );
    }
    throw error;
  }
}

export const handleJiraWebhook = ingestJiraWebhook;
