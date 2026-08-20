import {
  rootThreadPayload,
  threadMessagePayload,
  type RootThreadPayload,
  type ThreadMessagePayload,
} from "@remoteagent/discord";
import { sanitizeMessage, sanitizeSingle, sanitizeThreadName } from "@remoteagent/discord";
import { JiraContractError } from "./errors.js";
import * as z from "zod";

export interface JiraProjectionInput {
  caseId: string;
  ownerId: string;
  seq: number;
  provider: "jira";
  alias: "private" | "sondermind";
  issueKey: string;
  status?: string;
  summary?: string;
}
export interface JiraProjection {
  root: RootThreadPayload;
  thread: ThreadMessagePayload;
}
const bounded = (value: string | undefined, limit: number) =>
  value === undefined ? "" : value.slice(0, limit);
const projectionInput = z.strictObject({
  caseId: z.string().min(1).max(512),
  ownerId: z.string().min(1).max(512),
  seq: z.int().min(1),
  provider: z.literal("jira"),
  alias: z.enum(["private", "sondermind"]),
  issueKey: z.string().min(1).max(128),
  status: z.string().max(65_536).optional(),
  summary: z.string().max(65_536).optional(),
});
export function projectJiraIssue(input: unknown): JiraProjection {
  const parsed = projectionInput.safeParse(input);
  if (!parsed.success) throw new JiraContractError("invalid jira projection input");
  const value = parsed.data;
  const key = value.issueKey;
  const status = bounded(value.status, 256);
  const summary = bounded(value.summary, 2_000);
  const body = sanitizeMessage(
    `Jira issue ${key}\nStatus (UNTRUSTED Jira): ${status || "(unknown)"}\nSummary (UNTRUSTED Jira): ${summary || "(empty)"}`,
  ).join("\n");
  const root = rootThreadPayload.parse({
    case_id: value.caseId,
    owner_id: value.ownerId,
    seq: value.seq,
    provider: value.provider,
    alias: value.alias,
    title: sanitizeThreadName(`Jira ${key}`),
    body: sanitizeSingle(body),
  });
  const thread = threadMessagePayload.parse({
    case_id: value.caseId,
    seq: value.seq,
    body: sanitizeSingle(body),
  });
  return { root, thread };
}
