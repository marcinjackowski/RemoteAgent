/**
 * The read-only tool catalogue for Jira, Gmail, Calendar and GitLab.
 *
 * This module is pure server-owned configuration: descriptors, and the step policies
 * that decide which role sees which tool when. It deliberately imports nothing from
 * the four connector packages.
 *
 * That absence is a design constraint, not an oversight. The plan for this task
 * records it as a red-team correction — "provider packages must not create a
 * dependency cycle with the broker" — and notes that `eslint.config.mjs` permits
 * `package → package` imports, so a cycle would not be caught by the boundary lint.
 * A descriptor needs only a name, a provider, an argument schema and a scope kind;
 * the connector supplies the *transport* at wiring time, which is a runtime edge from
 * the composition root inward, not a compile-time edge between packages. So the
 * broker can be built and tested with a fake transport (`WU-04`, `WU-06`) and the
 * connectors remain free to depend on `contracts` alone.
 *
 * Every tool here is `R0`: a read inside the case's own scope. Note what is absent —
 * no `jira.add_comment`, no `gmail.send`, no `gitlab.create_merge_request`. Those are
 * external writes and belong to RA-022 behind policy and approval; the registry
 * refuses a non-`R0` descriptor at construction time, so adding one here would fail
 * loudly rather than quietly becoming callable.
 *
 * No descriptor declares a scope-naming argument. The scope argument
 * (`project_id`, `account_id`, …) is injected by the broker from the case's grants,
 * and registration rejects a descriptor that tries to declare one — which is why
 * these schemas carry only the genuinely model-chosen parameters.
 */
import { AgentRole, RiskTier } from "@remoteagent/contracts";
import * as z from "zod";

import type { ToolDescriptor } from "./contracts.js";
import type { ToolStepPolicy } from "./registry.js";

/** Bounded page size. The model may ask for fewer results, never for unbounded. */
const pageSize = z.number().int().min(1).max(50);

/** An opaque provider cursor the model may echo back but never construct meaning from. */
const cursor = z.string().min(1).max(4096);

/**
 * Jira reads.
 *
 * Scoped to `project`: the case's granted project, injected as `project_key`. A JQL
 * tool is deliberately NOT offered — arbitrary JQL is a query language over the whole
 * instance, so scoping it would mean parsing and rewriting untrusted query text, and
 * a scope enforced by rewriting attacker-influenced input is not a boundary. The
 * narrow reads below express what an agent actually needs.
 */
export const JIRA_READ_TOOLS: readonly ToolDescriptor[] = [
  {
    name: "jira.read_issue",
    provider: "jira",
    version: 1,
    risk_tier: RiskTier.R0,
    description:
      "Read one issue (summary, description, status, assignee, labels) from the case's project.",
    scope: { scope_kind: "project", required_capability: "jira:read" },
    arguments_schema: z.strictObject({ issue_key: z.string().trim().min(1).max(64) }),
    allowed_roles: [
      AgentRole.SUPERVISOR,
      AgentRole.PLANNER,
      AgentRole.REVIEWER,
      AgentRole.SPECIALIST,
    ],
  },
  {
    name: "jira.list_issue_comments",
    provider: "jira",
    version: 1,
    risk_tier: RiskTier.R0,
    description: "List comments on one issue in the case's project, newest first.",
    scope: { scope_kind: "project", required_capability: "jira:read" },
    arguments_schema: z.strictObject({
      issue_key: z.string().trim().min(1).max(64),
      limit: pageSize.optional(),
      page_cursor: cursor.optional(),
    }),
    allowed_roles: [AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.SPECIALIST],
  },
  {
    name: "jira.list_issue_links",
    provider: "jira",
    version: 1,
    risk_tier: RiskTier.R0,
    description: "List issues linked to one issue in the case's project.",
    scope: { scope_kind: "project", required_capability: "jira:read" },
    arguments_schema: z.strictObject({ issue_key: z.string().trim().min(1).max(64) }),
    allowed_roles: [AgentRole.PLANNER, AgentRole.REVIEWER],
  },
];

/**
 * Gmail reads.
 *
 * Scoped to `account`, which is the unit RA-019 established: two mailboxes that must
 * not mix, isolated by the granted account rather than by a filter. A case granted the
 * work account cannot address the private one, because the account is injected from
 * the grant and the resolver refuses a case spanning both aliases.
 *
 * Attachment CONTENT is absent by design. RA-019 made fetching a body or an
 * attachment a separate, justified act with a purpose from a closed set; re-exposing
 * it as an ordinary tool argument would route around that decision, so an agent that
 * needs a body goes through the connector's own justified path.
 */
export const GMAIL_READ_TOOLS: readonly ToolDescriptor[] = [
  {
    name: "gmail.read_thread_metadata",
    provider: "gmail",
    version: 1,
    risk_tier: RiskTier.R0,
    description:
      "Read one mail thread's metadata (participants, subject, timestamps, snippet) in the case's mailbox.",
    scope: { scope_kind: "account", required_capability: "gmail:read" },
    arguments_schema: z.strictObject({ thread_id: z.string().trim().min(1).max(256) }),
    allowed_roles: [AgentRole.SUPERVISOR, AgentRole.PLANNER, AgentRole.SPECIALIST],
  },
  {
    name: "gmail.list_thread_messages",
    provider: "gmail",
    version: 1,
    risk_tier: RiskTier.R0,
    description:
      "List message headers and snippets in one thread in the case's mailbox. Bodies and " +
      "attachments are not returned.",
    scope: { scope_kind: "account", required_capability: "gmail:read" },
    arguments_schema: z.strictObject({
      thread_id: z.string().trim().min(1).max(256),
      limit: pageSize.optional(),
    }),
    allowed_roles: [AgentRole.PLANNER, AgentRole.SPECIALIST],
  },
];

/**
 * Calendar reads.
 *
 * Scoped to `calendar`, not to `account` — RA-020 established that the unit of scope
 * is the (account, calendar) PAIR, because one account commonly watches several
 * calendars with independent state. Scoping these tools per account would let a read
 * reach a calendar the case was never granted.
 */
export const CALENDAR_READ_TOOLS: readonly ToolDescriptor[] = [
  {
    name: "calendar.read_event",
    provider: "calendar",
    version: 1,
    risk_tier: RiskTier.R0,
    description:
      "Read one event (title, time, attendees, recurrence, status) from the case's calendar.",
    scope: { scope_kind: "calendar", required_capability: "calendar:read" },
    arguments_schema: z.strictObject({ event_id: z.string().trim().min(1).max(256) }),
    allowed_roles: [AgentRole.SUPERVISOR, AgentRole.PLANNER, AgentRole.SPECIALIST],
  },
  {
    name: "calendar.list_events_in_window",
    provider: "calendar",
    version: 1,
    risk_tier: RiskTier.R0,
    description: "List events in a bounded time window on the case's calendar.",
    scope: { scope_kind: "calendar", required_capability: "calendar:read" },
    arguments_schema: z.strictObject({
      // ISO instants, validated as real dates. A window is REQUIRED: an unbounded
      // list is how a scoped read becomes an export of the whole calendar.
      window_start: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "must be an ISO-8601 timestamp",
      }),
      window_end: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
        message: "must be an ISO-8601 timestamp",
      }),
      limit: pageSize.optional(),
    }),
    allowed_roles: [AgentRole.PLANNER, AgentRole.SPECIALIST],
  },
];

/**
 * GitLab reads.
 *
 * Scoped to `repository`, matching the branded-allowlist boundary RA-017 built: a
 * project outside the server-owned allowlist cannot be named, and here it cannot be
 * named because the repository comes from the case grant rather than from an argument.
 */
export const GITLAB_READ_TOOLS: readonly ToolDescriptor[] = [
  {
    name: "gitlab.read_merge_request",
    provider: "gitlab",
    version: 1,
    risk_tier: RiskTier.R0,
    description:
      "Read one merge request (title, description, state, source/target branch, draft flag) " +
      "in the case's repository.",
    scope: { scope_kind: "repository", required_capability: "gitlab:read" },
    arguments_schema: z.strictObject({ merge_request_iid: z.number().int().positive() }),
    allowed_roles: [AgentRole.PLANNER, AgentRole.REVIEWER, AgentRole.VERIFICATION],
  },
  {
    name: "gitlab.list_merge_request_discussions",
    provider: "gitlab",
    version: 1,
    risk_tier: RiskTier.R0,
    description: "List review discussions on one merge request in the case's repository.",
    scope: { scope_kind: "repository", required_capability: "gitlab:read" },
    arguments_schema: z.strictObject({
      merge_request_iid: z.number().int().positive(),
      limit: pageSize.optional(),
      page_cursor: cursor.optional(),
    }),
    allowed_roles: [AgentRole.REVIEWER, AgentRole.VERIFICATION],
  },
  {
    name: "gitlab.read_pipeline_status",
    provider: "gitlab",
    version: 1,
    risk_tier: RiskTier.R0,
    description:
      "Read the status of one pipeline (state, stages, failed job names) in the case's repository.",
    scope: { scope_kind: "repository", required_capability: "gitlab:read" },
    arguments_schema: z.strictObject({ pipeline_id: z.number().int().positive() }),
    allowed_roles: [AgentRole.VERIFICATION, AgentRole.REVIEWER],
  },
];

/** Every read-only tool this broker serves. */
export const ALL_READ_TOOLS: readonly ToolDescriptor[] = [
  ...JIRA_READ_TOOLS,
  ...GMAIL_READ_TOOLS,
  ...CALENDAR_READ_TOOLS,
  ...GITLAB_READ_TOOLS,
];

/**
 * Default step policies: which role sees which tools, in which step (AC2).
 *
 * Narrow on purpose, and narrower than "every tool the role may use". A Planner
 * triaging an incoming Jira issue has no reason to see pipeline status, and a
 * Verification role checking a pipeline has no reason to see a mailbox. The step is
 * the unit because it is the smallest scope that is stable across a run — narrower
 * (per call) would make the manifest meaningless, and wider (per role) would hand
 * every role every tool it might ever need.
 *
 * A step absent from this list yields an EMPTY manifest, not a fallback to everything
 * — see `ToolRegistry.manifestFor`.
 */
export const DEFAULT_STEP_POLICIES: readonly ToolStepPolicy[] = [
  {
    role: AgentRole.SUPERVISOR,
    step: "intake",
    tools: ["jira.read_issue", "gmail.read_thread_metadata", "calendar.read_event"],
  },
  {
    role: AgentRole.PLANNER,
    step: "triage",
    tools: ["jira.read_issue", "jira.list_issue_comments", "jira.list_issue_links"],
  },
  {
    role: AgentRole.PLANNER,
    step: "context",
    tools: [
      "jira.read_issue",
      "jira.list_issue_comments",
      "gmail.read_thread_metadata",
      "gmail.list_thread_messages",
      "calendar.read_event",
      "calendar.list_events_in_window",
    ],
  },
  {
    role: AgentRole.REVIEWER,
    step: "review",
    tools: [
      "jira.read_issue",
      "gitlab.read_merge_request",
      "gitlab.list_merge_request_discussions",
    ],
  },
  {
    role: AgentRole.VERIFICATION,
    step: "verify",
    tools: ["gitlab.read_pipeline_status", "gitlab.read_merge_request"],
  },
  {
    // Deliberately empty: the Implementer works in the isolated workspace through
    // RA-012's local toolset and has no business reading provider APIs mid-patch.
    role: AgentRole.IMPLEMENTER,
    step: "implement",
    tools: [],
  },
];
