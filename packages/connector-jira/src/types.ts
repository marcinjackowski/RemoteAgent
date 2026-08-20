import type { z } from "zod";
import type { EventEnvelope } from "@remoteagent/contracts";

import { jiraConnectorConfig, jiraEventContract, jiraIssueSnapshotContract } from "./contracts.js";

export type JiraConnectorConfig = z.infer<typeof jiraConnectorConfig>;
export type JiraEvent = z.infer<typeof jiraEventContract>;
export type JiraIssueSnapshot = z.infer<typeof jiraIssueSnapshotContract>;

export interface JiraIngressContext {
  rawEventId: string;
  ownerId: string;
  connectionId: string;
  receivedAt: string;
  traceId: string;
  payloadRef: { ref: string; digest: string; size_bytes?: number };
  projectAllowlist: readonly string[];
}

export interface ParsedJiraEvent {
  envelope: EventEnvelope;
  jiraEvent: JiraEvent;
  orderingKey: string;
}
