import { createHash } from "node:crypto";
import { JiraWebhookIngressRepository } from "@remoteagent/database";
import type { Database } from "@remoteagent/database";

export interface RawPayloadReader {
  get(ref: string): Promise<Uint8Array>;
}
export interface JiraVerifiedPayloadInput {
  db: Database;
  ownerId: string;
  connectionId: string;
  rawEventId: string;
  reader: RawPayloadReader;
}
export interface JiraVerifiedPayloadWithMetadata {
  bytes: Uint8Array;
  metadata: {
    rawEventId: string;
    ownerId: string;
    connectionId: string;
    receivedAt: string;
    traceId: string;
    payloadRef: { ref: string; digest: string; size_bytes: number };
  };
}
function traceIdFor(rawEventId: string): string {
  return `jira_trace_${createHash("sha256").update(rawEventId).digest("hex")}`;
}
export class JiraRawPayloadReadError extends Error {
  public readonly code = "JIRA_RAW_PAYLOAD_READ_REJECTED" as const;
  public constructor() {
    super("jira raw payload read rejected");
    this.name = "JiraRawPayloadReadError";
  }
}
export async function readVerifiedJiraPayload(
  input: JiraVerifiedPayloadInput,
): Promise<Uint8Array> {
  const verified = await readVerifiedJiraPayloadWithMetadata(input);
  return new Uint8Array(verified.bytes);
}
export async function readVerifiedJiraPayloadWithMetadata(
  input: JiraVerifiedPayloadInput,
): Promise<JiraVerifiedPayloadWithMetadata> {
  let metadata;
  try {
    metadata = await new JiraWebhookIngressRepository().findRawPayload(input.db, {
      ownerId: input.ownerId,
      connectionId: input.connectionId,
      rawEventId: input.rawEventId,
    });
  } catch {
    throw new JiraRawPayloadReadError();
  }
  if (!metadata) throw new JiraRawPayloadReadError();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await input.reader.get(metadata.payloadRef));
  } catch {
    throw new JiraRawPayloadReadError();
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== metadata.payloadSizeBytes || digest !== metadata.payloadDigest)
    throw new JiraRawPayloadReadError();
  return {
    bytes: new Uint8Array(bytes),
    metadata: {
      rawEventId: metadata.rawEventId,
      ownerId: metadata.ownerId,
      connectionId: metadata.connectionId,
      receivedAt: metadata.receivedAt,
      traceId: traceIdFor(metadata.rawEventId),
      payloadRef: {
        ref: metadata.payloadRef,
        digest: metadata.payloadDigest,
        size_bytes: metadata.payloadSizeBytes,
      },
    },
  };
}
