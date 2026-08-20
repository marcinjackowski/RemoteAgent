import { describe, expect, it } from "vitest";
import { Provider, TrustLevel } from "@remoteagent/contracts";
import { buildRecoveryPlan, RecoveryPlanError } from "../src/index.js";

const stamp = "2026-08-20T10:00:00.000Z";
const checkpoint = (last_run_id: string | null = null, revision = 7) => ({
  schema_version: 1,
  case_id: "case-1",
  revision,
  goal: "goal api_key=secret password=hunter Bearer token",
  current_phase: "planning",
  summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "summary" },
  plan_revision: 1,
  completed_work: [],
  decisions: ["decision-old", "decision-current"],
  assumptions: [],
  evidence: [],
  open_questions: [],
  next_actions: [],
  blockers: [],
  pending_approvals: [],
  workspace_state: { tree_digest: null, base_sha: null },
  branch_state: { branch_name: null, ahead: 0, behind: 0 },
  test_runs: [],
  snapshot_changes: [],
  review_findings: [],
  merge_request_state: { mr_ref: null, status: null },
  external_state_versions: [],
  last_event_id: null,
  last_run_id,
  updated_at: stamp,
});
const request = (id = "decision-current", revision = 7) => ({
  schema_version: 1,
  decision_id: id,
  case_id: "case-1",
  question: `question-${id}`,
  why_now: "now",
  options: [
    { id: "a", label: "A", consequences: "one" },
    { id: "b", label: "B", consequences: "two" },
  ],
  recommendation: "a",
  blocked_scope: "scope",
  checkpoint_revision: revision,
});
const answer = (id = "decision-current", answerId = "answer-1", revision = 7) => ({
  schema_version: 1,
  decision_id: id,
  case_id: "case-1",
  checkpoint_revision: revision,
  selected_option_id: "a",
  answered_by: "owner-1",
  answered_at: stamp,
  answerId,
});
const answerWithNote = (id: string, answerId: string, note: string) => ({
  ...answer(id, answerId),
  note,
});
const completion = (status: "WAITING_FOR_USER" | "COMPLETED" = "WAITING_FOR_USER") => ({
  schema_version: 1,
  run_id: "run-1",
  case_id: "case-1",
  status,
  summary: "completion",
  completed_steps: [],
  evidence: [],
  checkpoint_patch: {},
  next_actions: [],
  ...(status === "WAITING_FOR_USER" ? { decision_request: request() } : {}),
});
const base = (overrides: Record<string, unknown> = {}) => ({
  case: {
    caseId: "case-1",
    ownerId: "owner-1",
    status: "PLANNING",
    integrationScope: { providers: [Provider.JIRA], connection_ids: ["jira-1"] },
    discordThreadId: "thread-1",
    activeRunId: null,
    checkpointRevision: 7,
  },
  bindings: [{ connectionId: "jira-1", provider: Provider.JIRA }],
  checkpoint: checkpoint(),
  activeRun: null,
  checkpointCompletion: { state: "ABSENT" },
  decisions: [],
  resumeJobs: [],
  ...overrides,
});
const input = (snapshot: unknown, budgetBytes = 100_000, toolNames = ["jira.read"]) => ({
  snapshot,
  budgetBytes,
  toolNames,
});
const plan = (snapshot: unknown, budgetBytes = 100_000) =>
  buildRecoveryPlan(input(snapshot, budgetBytes));
const expectCode = (fn: () => unknown, code: string) => {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RecoveryPlanError);
  expect((error as RecoveryPlanError).code).toBe(code);
  expect((error as Error).message).not.toContain("api_key");
};
const waitingSnapshot = (status = "PLANNING", decisions: unknown[] = []) =>
  base({
    case: { ...base().case, status },
    checkpoint: checkpoint("run-1"),
    checkpointCompletion: {
      state: "CONFIRMED",
      value: {
        completionId: "completion-1",
        runId: "run-1",
        caseId: "case-1",
        status: "WAITING_FOR_USER",
        completion: completion(),
        recordedAt: stamp,
      },
    },
    decisions,
  });
const job = (
  id = "job-1",
  decisionId = "decision-current",
  answerId = "answer-1",
  status = "PENDING",
  checkpointRevision = 7,
) => ({
  jobId: id,
  status,
  payload: { answerId, decisionId, caseId: "case-1", checkpointRevision },
  createdAt: stamp,
});
const activeRun = (
  safetyState = "INTENT_RECORDED",
  completionValue: unknown = null,
  intents: unknown[] = [
    {
      intentId: "intent-1",
      runId: "run-1",
      caseId: "case-1",
      kind: "WRITE",
      payload: {},
      recordedAt: stamp,
    },
  ],
) => ({
  runId: "run-1",
  caseId: "case-1",
  ownerId: "owner-1",
  workUnitId: "wu-1",
  role: "IMPLEMENTER",
  safetyState,
  checkpointRevision: 7,
  intents,
  completion: completionValue,
});
const dualBase = (overrides: Record<string, unknown> = {}) =>
  base({
    case: {
      ...base().case,
      integrationScope: {
        providers: [Provider.JIRA, Provider.GMAIL],
        connection_ids: ["jira-1", "gmail-1"],
      },
    },
    bindings: [
      { connectionId: "jira-1", provider: Provider.JIRA },
      { connectionId: "gmail-1", provider: Provider.GMAIL },
    ],
    ...overrides,
  });
const completionWrapper = (value = completion("COMPLETED"), status = "COMPLETED") => ({
  completionId: "completion-1",
  runId: "run-1",
  caseId: "case-1",
  status,
  completion: value,
  recordedAt: stamp,
});

describe("buildRecoveryPlan", () => {
  it.each(["INTENT_RECORDED", "STARTED"] as const)(
    "reconciles active %s without replay",
    (state) => {
      const result = plan(
        base({ case: { ...base().case, activeRunId: "run-1" }, activeRun: activeRun(state) }),
      );
      expect(result.status).toBe("RECONCILIATION_REQUIRED");
      expect(result.automaticAction).toEqual({ kind: "NONE" });
      expect(result).not.toHaveProperty("resumeJob");
    },
  );
  it.each(["PLANNED", "SUCCEEDED", "FAILED", "AMBIGUOUS"] as const)("rejects active %s", (state) =>
    expectCode(
      () =>
        plan(base({ case: { ...base().case, activeRunId: "run-1" }, activeRun: activeRun(state) })),
      state === "PLANNED" ? "ACTIVE_COMPLETION" : "ACTIVE_COMPLETION",
    ),
  );
  it("rejects active run without intent", () =>
    expectCode(
      () =>
        plan(
          base({
            case: { ...base().case, activeRunId: "run-1" },
            activeRun: activeRun("STARTED", null, []),
          }),
        ),
      "ACTIVE_RUN_WITHOUT_INTENT",
    ));
  it("rejects active confirmed completion", () =>
    expectCode(
      () =>
        plan(
          base({
            case: { ...base().case, activeRunId: "run-1" },
            activeRun: activeRun("STARTED", completionWrapper()),
          }),
        ),
      "ACTIVE_COMPLETION",
    ));
  it("rejects duplicate and mismatched active intents", () => {
    expectCode(
      () =>
        plan(
          base({
            case: { ...base().case, activeRunId: "run-1" },
            activeRun: activeRun("STARTED", null, [
              activeRun().intents[0],
              { ...activeRun().intents[0], kind: "OTHER" },
            ]),
          }),
        ),
      "DUPLICATE_ID",
    );
    expectCode(
      () =>
        plan(
          base({
            case: { ...base().case, activeRunId: "run-1" },
            activeRun: activeRun("STARTED", null, [
              { ...activeRun().intents[0], runId: "other-run" },
            ]),
          }),
        ),
      "MISMATCH_ACTIVE_RUN",
    );
  });
  it("is READY with no active run or completion", () => expect(plan(base()).status).toBe("READY"));
  it("materializes only a missing committed waiting decision", () => {
    const result = plan(waitingSnapshot("PLANNING"));
    expect(result.status).toBe("MATERIALIZE_DECISION");
    expect(result.automaticAction.kind).toBe("MATERIALIZE_DECISION");
    expect((result.automaticAction as { preparedRequest: unknown }).preparedRequest).toMatchObject({
      decision_id: "decision-current",
      checkpoint_revision: 7,
    });
  });
  it.each(["PLANNING", "IMPLEMENTING"] as const)("materializes from %s", (status) =>
    expect(plan(waitingSnapshot(status)).status).toBe("MATERIALIZE_DECISION"),
  );
  it.each(["WAITING_FOR_USER", "DONE"] as const)(
    "rejects missing materialization from %s",
    (status) => expectCode(() => plan(waitingSnapshot(status)), "WAITING_STATUS_MISMATCH"),
  );
  it("rejects a current prepared request with changed semantics", () =>
    expectCode(
      () =>
        plan(
          waitingSnapshot("WAITING_FOR_USER", [
            { request: { ...request(), question: "different" }, answer: null },
          ]),
        ),
      "MISMATCH_DECISION",
    ));
  it("rejects WAITING_FOR_USER without a confirmed completion", () =>
    expectCode(
      () => plan(base({ case: { ...base().case, status: "WAITING_FOR_USER" } })),
      "WAITING_STATUS_MISMATCH",
    ));
  it("waits for an exact request without an answer", () =>
    expect(
      plan(waitingSnapshot("WAITING_FOR_USER", [{ request: request(), answer: null }])).status,
    ).toBe("WAITING_FOR_USER"));
  it("queues only an exact answer and one matching job", () => {
    const withJob = plan({
      ...waitingSnapshot("PLANNING", [{ request: request(), answer: answer() }]),
      resumeJobs: [job()],
    });
    expect(withJob.status).toBe("RESUME_QUEUED");
    expect(withJob.automaticAction).toEqual({ kind: "NONE" });
    expect(withJob.resumeJob).toMatchObject({
      jobId: "job-1",
      answerId: "answer-1",
      decisionId: "decision-current",
    });
  });
  it.each(["IMPLEMENTING", "DONE"] as const)("rejects waiting semantic status %s", (status) =>
    expectCode(
      () => plan(waitingSnapshot(status, [{ request: request(), answer: null }])),
      "WAITING_STATUS_MISMATCH",
    ),
  );
  it("rejects answer without job and duplicate jobs", () => {
    const snap = waitingSnapshot("PLANNING", [{ request: request(), answer: answer() }]);
    expectCode(() => plan(snap), "ANSWER_WITHOUT_JOB");
    expectCode(() => plan({ ...snap, resumeJobs: [job(), job("job-2")] }), "DUPLICATE_ID");
  });
  it("uses prepared current decision, retaining older history", () => {
    const old = request("decision-old", 6);
    const result = plan({
      ...waitingSnapshot("WAITING_FOR_USER", [
        { request: old, answer: null },
        { request: request(), answer: null },
      ]),
    });
    expect(result.context.fragments.filter((x) => x.fragment.kind === "decision")).toHaveLength(2);
    expect(result.status).toBe("WAITING_FOR_USER");
  });
  it("is invariant to decisions, jobs, bindings and tools permutations", () => {
    const snap = dualBase({
      case: { ...dualBase().case, status: "PLANNING" },
      checkpoint: checkpoint("run-1"),
      checkpointCompletion: {
        state: "CONFIRMED",
        value: completionWrapper(completion(), "WAITING_FOR_USER"),
      },
      decisions: [
        { request: request("decision-old", 6), answer: answer("decision-old", "answer-old", 6) },
        { request: request(), answer: answer() },
      ],
      resumeJobs: [
        job("job-old", "decision-old", "answer-old", "PENDING", 6),
        job("job-current", "decision-current", "answer-1"),
      ],
    });
    const a = buildRecoveryPlan(input(snap, 100_000, ["jira.read", "gmail.read"]));
    const b = buildRecoveryPlan(
      input(
        {
          ...snap,
          bindings: [...snap.bindings].reverse(),
          decisions: [...snap.decisions].reverse(),
          resumeJobs: [...snap.resumeJobs].reverse(),
        },
        100_000,
        ["gmail.read", "jira.read"],
      ),
    );
    expect(a).toEqual(b);
  });
  it("cannot infer swapped provider pairs from separate scope sets", () => {
    const snap = dualBase();
    const swapped = {
      ...snap,
      bindings: [
        { connectionId: "jira-1", provider: Provider.GMAIL },
        { connectionId: "gmail-1", provider: Provider.JIRA },
      ],
    };
    expect(() => plan(swapped)).not.toThrow();
  });
  it("reconstructs redacted untrusted context without markdown truncation", () => {
    const result = plan(base());
    const texts = result.context.fragments.map((x) => x.fragment.content).join("\n");
    expect(texts).toContain("[REDACTED]");
    expect(texts).not.toContain("api_key=secret");
    expect(texts).not.toContain("Bearer token");
    expect(
      result.context.fragments.every(
        (x) =>
          x.fragment.provenance.origin === "model" &&
          x.fragment.trust === TrustLevel.UNTRUSTED_DATA,
      ),
    ).toBe(true);
    expect(texts).toContain("goal");
    expect(JSON.stringify(result)).not.toContain("REPLAY_MODEL_CALL");
  });
  it("redacts decision answer notes and preserves the full checkpoint JSON", () => {
    const result = plan({
      ...waitingSnapshot("PLANNING", [
        {
          request: request(),
          answer: answerWithNote(
            "decision-current",
            "answer-1",
            "password=secret Bearer abc.def.ghi",
          ),
        },
      ]),
      resumeJobs: [job()],
    });
    const decision = result.context.fragments.find((x) => x.fragment.kind === "decision")!.fragment
      .content;
    const checkpointContent = result.context.fragments.find(
      (x) => x.fragment.kind === "checkpoint",
    )!.fragment.content;
    expect(decision).toContain("[REDACTED]");
    expect(decision).not.toContain("password=secret");
    expect(decision).not.toContain("Bearer abc.def.ghi");
    expect(checkpointContent).toContain('"workspace_state"');
    expect(checkpointContent).not.toMatch(/^#/);
  });
  it("keeps checkpoint material fields and every decision/answer", () => {
    const result = plan({
      ...waitingSnapshot("PLANNING", [{ request: request(), answer: answer() }]),
      resumeJobs: [job()],
    });
    expect(
      result.context.fragments.find((x) => x.fragment.kind === "checkpoint")?.fragment.content,
    ).toContain("last_run_id");
    expect(result.context.fragments.filter((x) => x.fragment.kind === "decision")).toHaveLength(1);
  });
  it("fails protected decisions over budget", () => {
    const snap = waitingSnapshot("WAITING_FOR_USER", [{ request: request(), answer: null }]);
    const full = plan(snap);
    expectCode(() => plan(snap, full.context.usedBytes - 1), "MANDATORY_CONTEXT_FRAGMENT");
  });
  it("does not mutate deeply frozen input", () => {
    const snap = structuredClone({
      ...waitingSnapshot("PLANNING", [{ request: request(), answer: answer() }]),
      resumeJobs: [job()],
    });
    const before = structuredClone(snap);
    const freeze = (v: unknown): unknown => {
      if (v && typeof v === "object") {
        Object.freeze(v);
        Object.values(v as object).forEach(freeze);
      }
      return v;
    };
    plan(freeze(snap));
    expect(snap).toEqual(before);
  });
  it.each([
    { providers: [Provider.GMAIL], connection_ids: ["jira-1"] },
    { providers: [Provider.JIRA], connection_ids: ["jira-1", "extra"] },
  ])("rejects binding scope mismatch", (scope) =>
    expectCode(
      () => plan(base({ case: { ...base().case, integrationScope: scope } })),
      "INVALID_BINDINGS",
    ),
  );
  it("rejects duplicate bindings and invalid nested keys", () => {
    expectCode(
      () =>
        plan(
          base({
            bindings: [
              { connectionId: "jira-1", provider: Provider.JIRA },
              { connectionId: "jira-1", provider: Provider.JIRA },
            ],
          }),
        ),
      "INVALID_BINDINGS",
    );
    expectCode(
      () =>
        plan(
          base({ bindings: [{ connectionId: "jira-1", provider: Provider.JIRA, extra: true }] }),
        ),
      "INVALID_BINDINGS",
    );
  });
  it("rejects malformed completion, absent last run and malformed jobs", () => {
    expectCode(
      () => plan(base({ checkpointCompletion: { state: "ABSENT", value: 1 } })),
      "INVALID_COMPLETION",
    );
    expectCode(() => plan(base({ checkpoint: checkpoint("run-1") })), "MISMATCH_COMPLETION");
    expectCode(
      () => plan(base({ resumeJobs: [job("job-1", "decision-current", "answer-1", "NOPE")] })),
      "INVALID_JOB",
    );
    expectCode(
      () => plan(base({ resumeJobs: [{ ...job(), payload: { ...job().payload, extra: true } }] })),
      "INVALID_JOB",
    );
    expectCode(
      () =>
        plan(
          base({
            checkpoint: checkpoint("run-1"),
            checkpointCompletion: {
              state: "CONFIRMED",
              value: completionWrapper(completion(), "COMPLETED"),
            },
          }),
        ),
      "MISMATCH_COMPLETION",
    );
    expectCode(
      () => buildRecoveryPlan(input(base({ resumeJobs: [job()] }), 100_000, [123])),
      "INVALID_TOOLS",
    );
    expectCode(
      () =>
        buildRecoveryPlan(
          input(base({ resumeJobs: [job()] }), 100_000, ["jira.read", "jira.read"]),
        ),
      "INVALID_TOOLS",
    );
  });
  it("rejects duplicate or mismatched decision IDs and answer IDs", () => {
    const duplicate = [
      { request: request(), answer: null },
      { request: request(), answer: null },
    ];
    expectCode(() => plan(waitingSnapshot("WAITING_FOR_USER", duplicate)), "DUPLICATE_ID");
    expectCode(
      () =>
        plan(
          waitingSnapshot("WAITING_FOR_USER", [{ request: request(), answer: answer("other") }]),
        ),
      "MISMATCH_DECISION",
    );
    expectCode(
      () =>
        plan(
          waitingSnapshot("WAITING_FOR_USER", [
            { request: request(), answer: answer("decision-current", "same-answer") },
            {
              request: request("decision-old", 6),
              answer: answer("decision-old", "same-answer", 6),
            },
          ]),
        ),
      "DUPLICATE_ID",
    );
  });
  it("rejects duplicate or mismatched job identity", () => {
    const snap = waitingSnapshot("PLANNING", [{ request: request(), answer: answer() }]);
    expectCode(
      () =>
        plan({
          ...snap,
          resumeJobs: [
            job("job-1", "decision-current", "answer-1"),
            job("job-2", "decision-current", "answer-1"),
          ],
        }),
      "DUPLICATE_ID",
    );
    expectCode(
      () =>
        plan({
          ...snap,
          resumeJobs: [
            job("job-1", "decision-current", "answer-1"),
            job("job-2", "decision-old", "answer-2"),
          ],
        }),
      "MISMATCH_JOB",
    );
  });
});
