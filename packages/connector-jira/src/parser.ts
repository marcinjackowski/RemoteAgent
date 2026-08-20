import * as z from "zod";

import { JiraContractError } from "./errors.js";

const text = z.string().max(65_536);
const issueSchema = z
  .object({
    key: z.string().min(1).max(128),
    fields: z
      .object({
        project: z.object({ key: z.string().min(1).max(128) }).passthrough(),
        summary: text.optional(),
        description: z.unknown().optional(),
        status: z.object({ name: text }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const baseSchema = {
  timestamp: z.number().int().finite().min(0).max(4_102_444_800_000),
  issue: issueSchema,
  comment: z.object({ body: z.unknown().optional() }).passthrough().optional(),
  user: z
    .object({
      accountId: z.string().min(1).max(512).optional(),
      displayName: text.optional(),
    })
    .passthrough()
    .optional(),
};
const changelogItemSchema = z
  .object({
    field: z.string().min(1).max(1_024),
    fromString: z.string().max(8_192).optional(),
    toString: z.string().max(8_192).optional(),
  })
  .passthrough();
const payloadSchema = z
  .discriminatedUnion("webhookEvent", [
    z.object({ webhookEvent: z.literal("jira:issue_created"), ...baseSchema }).passthrough(),
    z
      .object({
        webhookEvent: z.literal("jira:issue_updated"),
        ...baseSchema,
        changelog: z
          .object({ items: z.array(changelogItemSchema).max(128) })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    z.object({ webhookEvent: z.literal("jira:issue_deleted"), ...baseSchema }).passthrough(),
    z
      .object({
        webhookEvent: z.literal("comment_created"),
        ...baseSchema,
        comment: z.object({ body: z.unknown().optional() }).passthrough(),
      })
      .passthrough(),
    z
      .object({
        webhookEvent: z.literal("comment_updated"),
        ...baseSchema,
        comment: z.object({ body: z.unknown().optional() }).passthrough(),
      })
      .passthrough(),
    z
      .object({
        webhookEvent: z.literal("comment_deleted"),
        ...baseSchema,
        comment: z.object({ body: z.unknown().optional() }).passthrough(),
      })
      .passthrough(),
  ])
  .superRefine((value, ctx) => {
    if (value.webhookEvent !== "jira:issue_updated" && "changelog" in value)
      ctx.addIssue({ code: "custom", message: "changelog is only valid for issue_updated" });
  });

export interface JiraParsedPayload {
  eventType:
    | "issue_created"
    | "issue_updated"
    | "issue_deleted"
    | "comment_created"
    | "comment_updated"
    | "comment_deleted";
  issueKey: string;
  projectKey: string;
  occurredAt: string;
  summary?: string;
  description?: string;
  status?: string;
  comment?: string;
  actorId?: string;
  actorName?: string;
  changes?: Array<{ field: string; from?: string; to?: string }>;
}

export function parseJiraPayload(raw: unknown): JiraParsedPayload {
  let parsed: z.infer<typeof payloadSchema>;
  try {
    parsed = payloadSchema.parse(raw);
  } catch {
    throw new JiraContractError("invalid jira webhook payload");
  }
  const issue = parsed.issue;
  const eventType =
    parsed.webhookEvent === "jira:issue_created"
      ? "issue_created"
      : parsed.webhookEvent === "jira:issue_updated"
        ? "issue_updated"
        : parsed.webhookEvent === "jira:issue_deleted"
          ? "issue_deleted"
          : parsed.webhookEvent;
  const result: JiraParsedPayload = {
    eventType,
    issueKey: issue.key,
    projectKey: issue.fields.project.key,
    occurredAt: new Date(parsed.timestamp).toISOString(),
  };
  if (issue.fields.summary !== undefined) result.summary = issue.fields.summary;
  if (typeof issue.fields.description === "string") result.description = issue.fields.description;
  if (issue.fields.status !== undefined) result.status = issue.fields.status.name;
  if (parsed.webhookEvent.startsWith("comment_") && typeof parsed.comment?.body === "string")
    result.comment = parsed.comment.body;
  if (parsed.user?.accountId !== undefined) result.actorId = parsed.user.accountId;
  if (parsed.user?.displayName !== undefined) result.actorName = parsed.user.displayName;
  if (parsed.webhookEvent === "jira:issue_updated" && parsed.changelog !== undefined)
    result.changes = parsed.changelog.items.map((item) => ({
      field: item.field,
      ...(item.fromString === undefined ? {} : { from: item.fromString }),
      ...(item.toString === undefined ? {} : { to: item.toString }),
    }));
  return result;
}
