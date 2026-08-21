/**
 * The least-privilege register (RA-024-WU-04).
 *
 * `docs/security/LEAST_PRIVILEGE.md` is the prose review; this is the machine-checked
 * half, for the same reason as `./trust-boundaries.ts`: a scope review that lives only
 * in a document is accurate on the day it is written and silently wrong afterwards.
 *
 * WHAT "LEAST PRIVILEGE" MEANS HERE, PRECISELY. Not "the smallest scope that exists"
 * — that would be unusable — but "no scope is requested that no registered action
 * needs". A grant nobody uses is pure blast radius: it cannot make anything work, and
 * it is available to anything that gets in. So the test derived from this register
 * compares requested scopes against the server-owned `ACTION_REGISTRY`, and an
 * unjustified scope is a FAILING TEST rather than a review note.
 *
 * That direction is the important one. Reviewing "does every action have a scope?"
 * finds nothing — a missing scope breaks the feature immediately and gets fixed. The
 * dangerous case is the opposite: a scope requested during development, never removed,
 * and never noticed because everything works.
 *
 * WHY WRITE SCOPES ARE LISTED SEPARATELY. Google's OAuth model has no
 * "create-a-draft-but-never-send" scope: `gmail.compose` permits sending. That
 * over-grant cannot be fixed at the OAuth layer, so it is contained deterministically
 * instead — `gmail.message.send` is absent from `ACTION_REGISTRY`, and an unregistered
 * tool is R4 and refused. Recording it here as an explicitly ACCEPTED over-grant with
 * its compensating control is the honest form; deleting the row because it looks bad
 * would hide a real residual risk from RA-026 AC3.
 */

/** Where a privilege is granted, which decides who can change it. */
export const PrivilegeSurface = {
  /** An OAuth scope requested from a provider. */
  OAUTH: "OAUTH",
  /** A provider API token's permission set. */
  API_TOKEN: "API_TOKEN",
  /** A Discord gateway intent or bot permission. */
  DISCORD: "DISCORD",
  /** An AWS IAM action. */
  IAM: "IAM",
  /** A capability string the tool broker checks. */
  CAPABILITY: "CAPABILITY",
} as const;

export type PrivilegeSurface = (typeof PrivilegeSurface)[keyof typeof PrivilegeSurface];

/** The owner's decision about a privilege that is broader than its use. */
export const OvergrantDecision = {
  /** Broader than needed, accepted, with a compensating control named. */
  ACCEPTED: "ACCEPTED",
  /** Broader than needed and to be narrowed; not yet done. */
  FIX: "FIX",
  /** Not broader than needed. */
  NONE: "NONE",
} as const;

export type OvergrantDecision = (typeof OvergrantDecision)[keyof typeof OvergrantDecision];

/** One requested privilege, and what actually needs it. */
export interface PrivilegeGrant {
  readonly surface: PrivilegeSurface;
  /** The scope/permission string as the provider names it. */
  readonly scope: string;
  readonly provider: string;
  /**
   * Registered action names (`ACTION_REGISTRY` keys) or read operations that need
   * this scope.
   *
   * MUST be non-empty. An empty list means nothing uses the scope, which is the
   * over-grant this register exists to catch, and the test rejects it.
   */
  readonly requiredBy: readonly string[];
  /** Whether the scope permits writes. */
  readonly writes: boolean;
  /**
   * Set when the provider's scope model is coarser than our use.
   *
   * `ACCEPTED` requires `compensatingControl`. RA-026 AC3 requires every known
   * residual risk to have an owner and an accept/fix/defer decision, so an
   * unexplained over-grant is not a valid state.
   */
  readonly overgrant: OvergrantDecision;
  readonly compensatingControl?: string;
}

/**
 * Every privilege this system requests.
 *
 * Ordered by provider. Read scopes first within each provider, then writes, so the
 * write surface — the part that can cause an externally-visible effect — reads as a
 * short list rather than being buried.
 */
export const PRIVILEGE_GRANTS: readonly PrivilegeGrant[] = Object.freeze([
  // --- Jira -----------------------------------------------------------------
  {
    surface: PrivilegeSurface.API_TOKEN,
    scope: "read:jira-work",
    provider: "jira",
    requiredBy: ["jira.read_issue", "jira.search", "jira.webhook.ingest"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.API_TOKEN,
    scope: "write:jira-work",
    provider: "jira",
    requiredBy: ["jira.issue.comment", "jira.issue.transition", "jira.issue.delete"],
    writes: true,
    overgrant: OvergrantDecision.ACCEPTED,
    compensatingControl:
      "Jira has no comment-only write scope. Every write goes through ACTION_REGISTRY: " +
      "comment and transition are R3 (exact owner approval), delete is R4. Anything not " +
      "in the registry is R4 and refused, so the token's breadth is not reachable.",
  },
  {
    surface: PrivilegeSurface.CAPABILITY,
    scope: "jira:read",
    provider: "jira",
    requiredBy: ["jira.read_issue", "jira.search"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },

  // --- GitLab ---------------------------------------------------------------
  {
    surface: PrivilegeSurface.API_TOKEN,
    scope: "read_repository",
    provider: "gitlab",
    requiredBy: ["gitlab.clone", "gitlab.read_mr", "gitlab.read_pipeline"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.CAPABILITY,
    scope: "gitlab:read",
    provider: "gitlab",
    requiredBy: ["gitlab.read_mr", "gitlab.read_pipeline"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.API_TOKEN,
    scope: "write_repository",
    provider: "gitlab",
    // `git.push.force` and `gitlab.branch.delete` are listed because this scope is
    // what MAKES THEM POSSIBLE, not because we want them. Omitting them read as a
    // narrower grant than we hold, which is the opposite of what this register is
    // for — the least-privilege test caught it by finding two R4 registry actions
    // with no scope backing them.
    //
    // An ordinary case-branch push is deliberately NOT listed here. It is not an
    // `ACTION_REGISTRY` entry, and that is a real gap recorded as `CTF-014` rather
    // than papered over: the registry's own comment says R2 covers "case-branch
    // pushes", but no such key exists and the push path never calls
    // `evaluatePolicy`. Adding a key would change an accepted contract and needs an
    // ADR, so this register states what actually contains the push instead —
    // see `pushContainment` below.
    requiredBy: ["git.push.force", "gitlab.branch.delete"],
    writes: true,
    overgrant: OvergrantDecision.ACCEPTED,
    compensatingControl:
      "`write_repository` also permits force-push and branch deletion. Both are R4 in " +
      "ACTION_REGISTRY (`git.push.force`, `gitlab.branch.delete`) and can never be " +
      "auto-allowed — stated twice, by APPROVAL_REQUIRED_TIERS and by " +
      "assertR4NeverAutoAllowed, because this failure is unrecoverable. An ordinary " +
      "case-branch push is contained differently and NOT by the policy engine: " +
      "`writes_enabled` is off per project by default, GitLabProjectAllowlist is a " +
      "closed list, and git-lifecycle's argv allowlist permits nine subcommands so " +
      "`push --force` and `branch -D` cannot be assembled at all. See CTF-014.",
  },
  {
    surface: PrivilegeSurface.API_TOKEN,
    scope: "api",
    provider: "gitlab",
    requiredBy: ["gitlab.mr.draft.update", "gitlab.mr.comment", "gitlab.mr.merge"],
    writes: true,
    overgrant: OvergrantDecision.ACCEPTED,
    compensatingControl:
      "GitLab's `api` scope is coarse and cannot be narrowed to MR operations. " +
      "Contained by GitLabProjectAllowlist (a closed project list, so the token cannot " +
      "be pointed at another repository) plus the R2/R3/R4 tiers. Merge is R4.",
  },

  // --- Gmail ----------------------------------------------------------------
  {
    surface: PrivilegeSurface.OAUTH,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    provider: "gmail",
    requiredBy: ["gmail.read_thread", "gmail.read_message", "gmail.watch"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.CAPABILITY,
    scope: "gmail:read",
    provider: "gmail",
    requiredBy: ["gmail.read_thread", "gmail.read_message"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.OAUTH,
    scope: "https://www.googleapis.com/auth/gmail.compose",
    provider: "gmail",
    requiredBy: ["gmail.draft.create"],
    writes: true,
    overgrant: OvergrantDecision.ACCEPTED,
    compensatingControl:
      "Google has no draft-only scope: `gmail.compose` permits SENDING. Contained " +
      "deterministically rather than at the OAuth layer — `gmail.message.send` is " +
      "deliberately ABSENT from ACTION_REGISTRY, and an unregistered tool resolves to " +
      "R4 and is refused with UNKNOWN_ACTION. So the only reachable write is the R2 " +
      "draft. Recorded rather than removed: it is a real residual risk, and RA-026 AC3 " +
      "requires it to have a decision.",
  },

  // --- Calendar -------------------------------------------------------------
  {
    surface: PrivilegeSurface.OAUTH,
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    provider: "calendar",
    requiredBy: ["calendar.read_event", "calendar.watch"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.CAPABILITY,
    scope: "calendar:read",
    provider: "calendar",
    requiredBy: ["calendar.read_event"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.OAUTH,
    scope: "https://www.googleapis.com/auth/calendar.events",
    provider: "calendar",
    requiredBy: [
      "calendar.event.create",
      "calendar.event.update",
      "calendar.event.respond",
      "calendar.event.delete",
    ],
    writes: true,
    overgrant: OvergrantDecision.ACCEPTED,
    compensatingControl:
      "`calendar.events` covers create, update and delete with no finer split. " +
      "Create/update/respond are R3 (exact approval); delete is R4. The per-case " +
      "resource grant additionally binds each action to ONE calendar id, so the two " +
      "accounts cannot reach each other.",
  },

  // --- Discord --------------------------------------------------------------
  {
    surface: PrivilegeSurface.DISCORD,
    scope: "GUILD_MESSAGES",
    provider: "discord",
    requiredBy: ["discord.receive_command", "discord.receive_decision"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.DISCORD,
    scope: "SEND_MESSAGES_IN_THREADS",
    provider: "discord",
    requiredBy: ["discord.post_status", "discord.ask_decision"],
    writes: true,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.DISCORD,
    scope: "CREATE_PUBLIC_THREADS",
    provider: "discord",
    requiredBy: ["discord.open_case_thread"],
    writes: true,
    overgrant: OvergrantDecision.NONE,
  },

  // --- AWS ------------------------------------------------------------------
  {
    surface: PrivilegeSurface.IAM,
    scope: "bedrock:InvokeModel",
    provider: "bedrock",
    requiredBy: ["bedrock.converse"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.IAM,
    scope: "bedrock:InvokeModelWithResponseStream",
    provider: "bedrock",
    requiredBy: ["bedrock.converse_stream"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.IAM,
    scope: "secretsmanager:GetSecretValue",
    provider: "secrets",
    requiredBy: ["credential.use"],
    writes: false,
    overgrant: OvergrantDecision.NONE,
  },
  {
    surface: PrivilegeSurface.IAM,
    scope: "secretsmanager:PutSecretValue",
    provider: "secrets",
    requiredBy: ["credential.refresh"],
    writes: true,
    overgrant: OvergrantDecision.NONE,
  },
]);

/** Grants that permit an externally-visible write. The short list, on purpose. */
export function writeGrants(): readonly PrivilegeGrant[] {
  return PRIVILEGE_GRANTS.filter((grant) => grant.writes);
}

/** Grants broader than their use, with the decision recorded. */
export function overgrants(): readonly PrivilegeGrant[] {
  return PRIVILEGE_GRANTS.filter((grant) => grant.overgrant !== OvergrantDecision.NONE);
}

/**
 * Scopes this system must NEVER request, with the reason.
 *
 * A denylist alongside an allowlist looks redundant, and `CTF-010` finding 2 says to
 * prefer allowlists. It is here for a different job: these are the scopes whose
 * absence is a DELIBERATE containment decision rather than an oversight, so a future
 * task adding one has to delete a line that explains why not. Without this, adding
 * `gmail.send` would look like ordinary feature work.
 */
export const FORBIDDEN_SCOPES: Readonly<Record<string, string>> = Object.freeze({
  "https://www.googleapis.com/auth/gmail.send":
    "sending mail is not a capability this system has; only drafts (R2) are reachable",
  "https://mail.google.com/": "full-mailbox access including delete; nothing needs it",
  "https://www.googleapis.com/auth/gmail.modify":
    "permits deleting and altering messages in the owner's mailbox",
  sudo: "GitLab admin impersonation; an escalation of authority with no use here",
  "admin:org": "organisation administration is outside every registered action",
  "iam:*": "IAM mutation would let the system widen its own privileges",
  "bedrock:*":
    "wildcards hide which model operations are used; RA-025 AC2 requires an ADR for any wildcard",
  "s3:*": "wildcard object access; artifact writes are scoped to one prefix per case",
});
