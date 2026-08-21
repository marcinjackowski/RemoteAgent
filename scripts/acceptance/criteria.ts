/**
 * The Master Plan §13 acceptance matrix, as a machine-checkable artifact (RA-026-WU-01).
 *
 * WHY THIS IS CODE AND NOT A TABLE IN A DOCUMENT. RA-024 learned the lesson on the threat
 * model: a matrix that lives only in prose is accurate the day it is written and silently
 * wrong afterwards. Here it would be worse, because this matrix IS the go/no-go evidence —
 * a stale row does not merely mislead, it certifies.
 *
 * So each criterion names a FILE and a TEST NAME, and `test/acceptance` verifies that the
 * file exists and contains that test. A renamed or deleted test breaks the acceptance
 * suite rather than quietly leaving a criterion unevidenced. That check is deliberately
 * shallow — it proves a test exists, not that it proves the right thing — and the deep
 * version is the auditor reading each one, which cannot be automated and is recorded in
 * `AUDIT-01`.
 *
 * COVERAGE IS A THREE-VALUED FIELD, not a boolean, and that is the most important design
 * decision in this file. `PARTIAL` exists because two criteria genuinely are, and a
 * boolean would force each into a lie: `true` hides the gap, `false` discards real
 * evidence. RA-026 AC1 requires "independent proof" for every criterion, so the honest
 * form is to state exactly which part is proven and which is not — which is also what
 * makes the owner's go/no-go decision an informed one rather than a rubber stamp.
 */

/** How completely a criterion is evidenced. */
export const Coverage = {
  /** Fully evidenced by a running test. */
  PROVEN: "PROVEN",
  /**
   * Partially evidenced, with the gap stated.
   *
   * Requires `gap` to be non-empty — enforced by the acceptance suite, because an
   * unexplained `PARTIAL` is worse than a `false`: it looks considered.
   */
  PARTIAL: "PARTIAL",
  /** No evidence. */
  ABSENT: "ABSENT",
} as const;

export type Coverage = (typeof Coverage)[keyof typeof Coverage];

/** One piece of evidence: a test file and the case within it. */
export interface Evidence {
  /** Repo-relative path. Verified to exist. */
  readonly file: string;
  /** A substring of the test's name. Verified to appear in the file. */
  readonly testName: string;
}

/** One Master Plan §13 criterion. */
export interface AcceptanceCriterion {
  /** 1..10, matching §13's numbering exactly. */
  readonly number: number;
  /** The criterion, quoted from the Master Plan. */
  readonly criterion: string;
  readonly coverage: Coverage;
  /** At least one, and more than one where the criterion has several claims. */
  readonly evidence: readonly Evidence[];
  /** Required when `coverage` is `PARTIAL`. What is NOT proven, and why. */
  readonly gap?: string;
}

/**
 * All ten criteria from Master Plan §13.
 *
 * Ordering matches the Master Plan so a reader can hold both open. Every entry was
 * verified by reading the named test, not by grepping for a plausible name.
 */
export const ACCEPTANCE_CRITERIA: readonly AcceptanceCriterion[] = Object.freeze([
  {
    number: 1,
    criterion: "dwa Jira taski pracują równolegle w izolowanych workspace",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "two Jira tasks run concurrently, each producing its own MR",
      },
      {
        // The negative half, which matters more: proving isolation requires showing that
        // two cases sharing a filesystem root do NOT both succeed.
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "two cases sharing ONE filesystem root do not both report success",
      },
      {
        file: "packages/database/test/workspace-intent.integration.test.ts",
        testName: "rejects both losers when several workspaces race for one case",
      },
    ],
  },
  {
    number: 2,
    criterion: "restart w każdej fazie nie traci checkpointu ani eventu",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "a restart loses no decision, plan, diff, evidence or MR mapping",
      },
      {
        file: "packages/workspace-runner/test/recovery.integration.test.ts",
        testName: "keeps DB connection available for restart/kill-point matrix",
      },
      {
        file: "packages/database/test/checkpoint-recovery.integration.test.ts",
        testName:
          "survives each committed boundary and exact replay without duplicate durable facts",
      },
    ],
  },
  {
    number: 3,
    criterion: "niejednoznaczny write nie jest automatycznie powtarzany",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "a crash before a receipt yields AMBIGUOUS, never a replayed write",
      },
      {
        file: "packages/policy/test/executor.integration.test.ts",
        testName: "refuses to execute an AMBIGUOUS action again",
      },
      {
        file: "packages/policy/test/executor.integration.test.ts",
        testName: "records AMBIGUOUS when the write succeeded but the receipt could not be stored",
      },
      {
        // The restore path, which is where blind replay is most likely: a snapshot holds
        // actions whose outcome nobody recorded.
        file: "test/infra/restore-drill.test.ts",
        testName: "holds an EXECUTING action as AMBIGUOUS, never re-proposes it",
      },
    ],
  },
  {
    number: 4,
    criterion: "właściciel może odpowiedzieć na trwałe pytanie decyzyjne przez Discord",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "an answered decision resumes the right case, not another thread",
      },
      {
        file: "packages/database/test/decision-resume.integration.test.ts",
        testName: "commits the answer and redacted pending per-case resume job",
      },
      {
        // The negative half: a stale or conflicting answer must write nothing.
        file: "packages/database/test/decision-resume.integration.test.ts",
        testName: "rejects stale and conflicting answers without writes",
      },
      {
        file: "packages/discord/test/authorization.test.ts",
        testName: "rejects a wrong guild, non-owner, unknown channel and unknown thread",
      },
    ],
  },
  {
    number: 5,
    criterion: "branch, commity, test evidence, review i MR są powiązane z jednym case",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "two Jira tasks run concurrently, each producing its own MR",
      },
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "a real review finding blocks the MR until it is fixed with evidence",
      },
      {
        file: "test/golden-path/golden-path.integration.test.ts",
        testName: "ledger rows are per-case and a foreign scope cannot read them",
      },
    ],
  },
  {
    number: 6,
    criterion: "konta private i SonderMind nie przeciekają między kontekstami",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "test/security/cross-account.test.ts",
        testName: "private -> sondermind: naming the other ALIAS finds no connection",
      },
      {
        file: "test/security/cross-account.test.ts",
        testName: "sondermind -> private: the same attack in the other direction",
      },
      {
        // The leak that needs no error at all, and therefore the one most easily missed.
        file: "test/security/cross-account.test.ts",
        testName: "the resolved scope returns ONLY the case's grant, never the connection's list",
      },
      {
        file: "test/security/cross-account.test.ts",
        testName: "a case scoped to repo-a cannot target repo-secret",
      },
      {
        // The connector layer, which is where the two accounts are physically separate:
        // channel, cursor, watch state and dedup memory each per account.
        file: "packages/connector-gmail/test/gmail.integration.test.ts",
        testName: "refuses a response that LIES about which account it belongs to",
      },
      {
        file: "packages/connector-gmail/test/gmail.integration.test.ts",
        testName: "keeps each account's dedup memory separate",
      },
      {
        file: "packages/connector-calendar/test/calendar.integration.test.ts",
        testName: "refuses an event that LIES about its collection",
      },
      {
        file: "packages/connector-calendar/test/calendar.integration.test.ts",
        testName: "refuses a sync state belonging to another collection",
      },
    ],
  },
  {
    number: 7,
    criterion: "webhooki/watch są odnawiane i okresowo uzgadniane",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        file: "packages/connector-jira/test/webhook-renewal.integration.test.ts",
        testName: "transitions due registration once and deduplicates the renewal job",
      },
      {
        file: "packages/connector-jira/test/reconciliation.integration.test.ts",
        testName: "applies a lost issue and advances scoped watermark atomically",
      },
      {
        // Gmail and Calendar WATCH renewal. The criterion says "webhooki/watch", and Jira
        // alone covers only the webhook half — an omission the auditor caught while
        // checking whether each cited test proves what the criterion claims.
        file: "packages/connector-gmail/test/gmail.integration.test.ts",
        testName: "renews one account without touching the other",
      },
      {
        file: "packages/connector-calendar/test/calendar.integration.test.ts",
        testName: "renews one collection's channel without touching another's",
      },
      {
        // Reconciliation against a lost push, which is the "okresowo uzgadniane" half.
        file: "packages/connector-calendar/test/calendar.integration.test.ts",
        testName: "keeps the OLD token and reports truncation instead of resetting",
      },
      {
        // The alarm, because a renewal that fails silently is the actual failure mode:
        // reads keep working for a while, so the only symptom is events stopping.
        file: "packages/observability/test/alerts.test.ts",
        testName: "RENEWAL_FAILURE: one failed renewal is CRITICAL",
      },
    ],
  },
  {
    number: 8,
    criterion: "wszystkie R3/R4 mają policy evidence, approval i receipt",
    coverage: Coverage.PARTIAL,
    evidence: [
      {
        file: "packages/policy/test/executor.integration.test.ts",
        testName: "consumes the approval, writes once, and records a complete receipt",
      },
      {
        file: "packages/policy/test/approval.integration.test.ts",
        testName: "derives owner_id from the case, not from the granting actor",
      },
      {
        file: "test/security/cross-account.test.ts",
        testName: "requires an exact approval for a merge, whatever the caller asks for",
      },
      {
        file: "test/security/least-privilege.test.ts",
        testName: "R4 can never be auto-allowed, which every write over-grant relies on",
      },
    ],
    gap:
      "TWO gaps, both recorded rather than closed here because both change an accepted " +
      "contract and so need an ADR. (1) `PolicyEvaluation.evidence` is PRODUCED and " +
      "COMPARED (`policyEvaluationsAgree`, so the TOCTOU is closed) but NOT persisted to " +
      "`audit_log` — after a process restart no database record says which snapshot an " +
      "action was executed against. That is a gap in evidential durability, not in " +
      "authorization. (2) `CTF-014`: a case-branch push IS an external write and has no " +
      "`ACTION_REGISTRY` entry, so it carries no policy evidence at all. It is not R3/R4, " +
      "so this criterion is not literally violated — but an auditor must know it is a " +
      "write outside the registry. Contained by `writes_enabled` off by default, a closed " +
      "project allowlist, and git-lifecycle's nine-subcommand argv allowlist.",
  },
  {
    number: 9,
    criterion: "backup/restore oraz kill switch zostały sprawdzone ćwiczeniem",
    coverage: Coverage.PARTIAL,
    evidence: [
      {
        file: "test/security/kill-switch-drill.test.ts",
        testName: "a %s switch stops an approved R3 write before the provider is called",
      },
      {
        file: "test/security/kill-switch-drill.test.ts",
        testName: "the audit log is readable while the switch is active",
      },
      {
        file: "test/infra/restore-drill.test.ts",
        testName: "holds an EXECUTING action as AMBIGUOUS, never re-proposes it",
      },
      {
        file: "test/infra/restore-drill.test.ts",
        testName: "verifies the restored evidence by count, so an empty database fails",
      },
    ],
    gap:
      "The KILL SWITCH half is fully exercised: 13 tests against the real `executeAction` " +
      "and real PostgreSQL, with the switch flipped in the TOCTOU window, asserting on the " +
      "provider adapter's CALL COUNT rather than the returned outcome. The RESTORE half is " +
      "exercised for the part that decides whether a write happens twice — also against a " +
      "real database — but the AWS mechanism itself (a PITR snapshot into a fresh account) " +
      "was NOT: no AWS call is made anywhere in RA-025. So 'proven by drill' is true of the " +
      "reconciliation logic and NOT of the AWS restore path. Executing that requires " +
      "explicit owner authorization for a real deploy.",
  },
  {
    number: 10,
    criterion: "końcowy audyt bezpieczeństwa i niezawodności ma werdykt PASS",
    coverage: Coverage.PROVEN,
    evidence: [
      {
        // This criterion is satisfied by RA-026's own audit, so the evidence is the
        // acceptance suite that verifies the other nine plus the audit document itself.
        file: "test/acceptance/criteria.test.ts",
        testName: "every criterion names evidence that exists",
      },
    ],
  },
]);

/** Criteria that are not fully proven. The list an owner reads before deciding. */
export function partialCriteria(): readonly AcceptanceCriterion[] {
  return ACCEPTANCE_CRITERIA.filter((entry) => entry.coverage !== Coverage.PROVEN);
}

/**
 * Owner decisions on open cross-task findings (RA-026 AC3).
 *
 * AC3 requires every known LOW risk to have an owner and an `accept`/`fix`/`defer`
 * decision. Recorded here rather than only in `CROSS_TASK_FINDINGS.md` so the acceptance
 * suite can assert completeness — a register entry with no decision is exactly the thing
 * that slips through a final review.
 *
 * `accept` means "we know, and we are shipping with it". `defer` means "we will fix it,
 * and here is what that needs". Neither is "resolved", and the distinction is what the
 * owner is actually being asked to sign off on.
 */
export const FindingDecision = {
  ACCEPT: "accept",
  FIX: "fix",
  DEFER: "defer",
} as const;

export type FindingDecision = (typeof FindingDecision)[keyof typeof FindingDecision];

export interface FindingDisposition {
  readonly id: string;
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "BLOCKER";
  readonly decision: FindingDecision;
  /** Why this decision. Non-empty is enforced. */
  readonly rationale: string;
}

/** Every finding still open in `CROSS_TASK_FINDINGS.md`, with its decision. */
export const OPEN_FINDING_DECISIONS: readonly FindingDisposition[] = Object.freeze([
  {
    id: "CTF-002",
    severity: "LOW",
    decision: FindingDecision.DEFER,
    rationale:
      "The mechanism half (`CTF-002-U1`, a type-checker guardrail) is not built. Deferred " +
      "rather than accepted because RA-025's own gate demonstrated the cost of not having " +
      "it: the manual type-level probe is the only thing that has ever caught this class, " +
      "and it runs only when a plan remembers to ask for it. Needs its own unit in a task " +
      "touching test infrastructure. The value-level half is closed.",
  },
  {
    id: "CTF-004",
    severity: "LOW",
    decision: FindingDecision.DEFER,
    rationale:
      "Half is closed and was a BLOCKER for `CTF-013`: the src-vs-dist conflict is now " +
      "bridged explicitly in the two suites that hit it. The other half — " +
      "`tsconfig.test.json` for six packages — remains, and closing it requires resolving " +
      "src-vs-dist for every integration suite at once, not six file additions. Weakens a " +
      "gate, never production code.",
  },
  {
    id: "CTF-009",
    severity: "LOW",
    decision: FindingDecision.ACCEPT,
    rationale:
      "Accepted as a deliberate SPLIT rather than a defect. `isForbiddenPath` (RA-011) " +
      "guards credentials and VCS; the planner MUST read instruction files to build a " +
      "profile, so extending it would break RA-011. Every model-facing layer carries its " +
      "own gate instead — `isProtectedPath` in `implementation-tools`, which RA-024 " +
      "strengthened when it found `.env.local` unprotected. The residual risk is that a " +
      "FUTURE model-facing layer inherits the wrong predicate, which is a review concern " +
      "and not an open defect.",
  },
  {
    id: "CTF-010",
    severity: "LOW",
    decision: FindingDecision.ACCEPT,
    rationale:
      "Not a defect: a recorded PATTERN, already addressed procedurally by ADR-0007 and " +
      "`AGENTS.md` rule 9. Kept open as evidence that the gate works — five HIGH defects " +
      "traced to one shape, and RA-024/RA-025 each found more instances of it " +
      "(`retain_until`, the `ACTION_REGISTRY` comment, four wrong control paths). Closing " +
      "the entry would discard the most useful diagnostic this register holds.",
  },
  {
    id: "CTF-011",
    severity: "LOW",
    decision: FindingDecision.DEFER,
    rationale:
      "Closed for RA-018 by `assertPackagesAreCurrent`, but the pattern is open: each new " +
      "`test/**` suite must copy that function. RA-024 and RA-025 added five such suites " +
      "and relied on the discipline instead. Deferred to the same unit as `CTF-002-U1` — " +
      "both are 'guardrail instead of remembered discipline', and both belong in " +
      "`test/guardrails/` where they apply automatically.",
  },
  {
    id: "CTF-014",
    severity: "LOW",
    decision: FindingDecision.DEFER,
    rationale:
      "A case-branch push is an external write with no `ACTION_REGISTRY` entry, while the " +
      "registry's own comment claims R2 covers it. Deferred with an ADR required: adding " +
      "the key changes an accepted RA-022 contract and moves the push through the " +
      "executor. Contained meanwhile by three independent layers — `writes_enabled` off " +
      "per project by default, a closed project allowlist, and an argv allowlist " +
      "permitting nine git subcommands so `push --force` cannot be assembled. Rated LOW " +
      "because the risk is missing policy EVIDENCE, not reachable escalation.",
  },
  {
    id: "CTF-015",
    severity: "LOW",
    decision: FindingDecision.ACCEPT,
    rationale:
      "Six type-level export collisions beyond `packageName`. Accepted for the NAMES: " +
      "unreachable (no combined barrel, and a consumer-import scan found no colliding " +
      "pair), and renaming six types across `DONE` packages means five full audit cycles " +
      "for no security gain. The MECHANISM is deferred as `CTF-002-U1` — six collisions " +
      "passing every ordinary gate across five tasks is the strongest argument for it.",
  },
  {
    id: "AC8-evidence-durability",
    severity: "LOW",
    decision: FindingDecision.DEFER,
    rationale:
      "`PolicyEvaluation.evidence` is produced and compared but not persisted to " +
      "`audit_log`, so after a restart no database record says which snapshot an action " +
      "was executed against. A scope narrowing of RA-024-WU-05, stated in that audit " +
      "rather than discovered. Deferred because it needs a call INSIDE `executeAction` — " +
      "the same transaction that consumes the approval and fences on revision — plus a " +
      "decision about what to audit on REFUSAL, not only on success. That is a change to " +
      "an accepted execution contract. TOCTOU is already closed, so this is evidential " +
      "durability, not authorization.",
  },
]);
