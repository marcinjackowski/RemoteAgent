import {
  agentCompletion,
  agentCompletionStatusSchema,
  agentRoleSchema,
  assertAnswerMatchesRequest,
  caseCheckpoint,
  caseStatusSchema,
  decisionAnswer,
  decisionRequest,
  integrationScope,
  TrustLevel,
  idString,
  providerSchema,
  runSafetyStateSchema,
  type DecisionAnswer,
  type DecisionRequest,
  type Provider,
} from "@remoteagent/contracts";
import { SecretRedactor } from "@remoteagent/observability";
import { buildContext } from "./context/builder.js";
import type { BuiltContext, ContextFragment } from "./context/types.js";
import { prepareDecisionRequest } from "./decisions/prepare.js";

export type RecoveryPlanErrorCode = string;
export class RecoveryPlanError extends Error {
  public constructor(
    public readonly code: RecoveryPlanErrorCode,
    message = "Invalid recovery snapshot",
  ) {
    super(message);
    this.name = "RecoveryPlanError";
  }
}
export type RecoveryPlan = {
  status:
    | "RECONCILIATION_REQUIRED"
    | "MATERIALIZE_DECISION"
    | "WAITING_FOR_USER"
    | "RESUME_QUEUED"
    | "READY";
  automaticAction:
    | { kind: "NONE" }
    | { kind: "MATERIALIZE_DECISION"; sourceRunId: string; preparedRequest: DecisionRequest };
  resumeJob?: { jobId: string; sourceRunId: string; answerId: string; decisionId: string };
  context: BuiltContext;
};
const fail = (code: string): never => {
  throw new RecoveryPlanError(code);
};
const obj = (v: unknown, c: string) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(c);
  return v as Record<string, unknown>;
};
const arr = (v: unknown, c: string) => {
  if (!Array.isArray(v)) fail(c);
  return v as unknown[];
};
const str = (v: unknown, c: string) => {
  if (!idString.safeParse(v).success) fail(c);
  return v as string;
};
const int = (v: unknown, c: string) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) fail(c);
  return v as number;
};
const exact = (v: Record<string, unknown>, keys: readonly string[], c: string) => {
  const ks = Object.keys(v);
  if (ks.length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) fail(c);
};
const stable = (v: unknown): string => {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const r = v as Record<string, unknown>;
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(r[k])}`)
    .join(",")}}`;
};
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const jobStatus = (value: unknown): boolean =>
  ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "DEAD_LETTER", "RECONCILING"].includes(
    value as string,
  );
function parseSnapshot(raw: unknown) {
  const r = obj(raw, "INVALID_SNAPSHOT");
  exact(
    r,
    [
      "case",
      "bindings",
      "checkpoint",
      "activeRun",
      "checkpointCompletion",
      "decisions",
      "resumeJobs",
    ],
    "INVALID_SNAPSHOT",
  );
  const c = obj(r.case, "INVALID_CASE");
  exact(
    c,
    [
      "caseId",
      "ownerId",
      "status",
      "integrationScope",
      "discordThreadId",
      "activeRunId",
      "checkpointRevision",
    ],
    "INVALID_CASE",
  );
  str(c.caseId, "INVALID_CASE");
  str(c.ownerId, "INVALID_CASE");
  str(c.discordThreadId, "INVALID_CASE");
  if (
    !caseStatusSchema.safeParse(c.status).success ||
    !integrationScope.safeParse(c.integrationScope).success
  )
    fail("INVALID_CASE");
  int(c.checkpointRevision, "INVALID_CASE");
  if (c.activeRunId !== null) str(c.activeRunId, "INVALID_CASE");
  if (!caseCheckpoint.safeParse(r.checkpoint).success) fail("INVALID_CHECKPOINT");
  const cp = r.checkpoint as { case_id: string; revision: number; last_run_id: string | null };
  if (cp.case_id !== c.caseId || cp.revision !== c.checkpointRevision)
    fail("MISMATCH_CASE_REVISION");
  for (const x of arr(r.bindings, "INVALID_BINDINGS")) {
    const b = obj(x, "INVALID_BINDINGS");
    exact(b, ["connectionId", "provider"], "INVALID_BINDINGS");
    str(b.connectionId, "INVALID_BINDINGS");
    if (!providerSchema.safeParse(b.provider).success) fail("INVALID_BINDINGS");
  }
  const a = r.activeRun === null ? null : obj(r.activeRun, "INVALID_RUN");
  if (a) {
    exact(
      a,
      [
        "runId",
        "caseId",
        "ownerId",
        "workUnitId",
        "role",
        "safetyState",
        "checkpointRevision",
        "intents",
        "completion",
      ],
      "INVALID_RUN",
    );
    str(a.runId, "INVALID_RUN");
    str(a.caseId, "INVALID_RUN");
    str(a.ownerId, "INVALID_RUN");
    str(a.workUnitId, "INVALID_RUN");
    if (!agentRoleSchema.safeParse(a.role).success) fail("INVALID_RUN");
    if (a.caseId !== c.caseId || a.ownerId !== c.ownerId || c.activeRunId !== a.runId)
      fail("MISMATCH_ACTIVE_RUN");
    if (!runSafetyStateSchema.safeParse(a.safetyState).success) fail("INVALID_SAFETY_STATE");
    int(a.checkpointRevision, "INVALID_RUN");
    if (a.checkpointRevision !== c.checkpointRevision) fail("MISMATCH_CASE_REVISION");
    for (const x of arr(a.intents, "INVALID_INTENTS")) {
      const i = obj(x, "INVALID_INTENTS");
      exact(i, ["intentId", "runId", "caseId", "kind", "payload", "recordedAt"], "INVALID_INTENTS");
      str(i.intentId, "INVALID_INTENTS");
      str(i.runId, "INVALID_INTENTS");
      str(i.caseId, "INVALID_INTENTS");
      str(i.kind, "INVALID_INTENTS");
      if (i.runId !== a.runId || i.caseId !== c.caseId) fail("MISMATCH_ACTIVE_RUN");
    }
    if (
      new Set(
        (a.intents as unknown[]).map((x) =>
          str(obj(x, "INVALID_INTENTS").intentId, "INVALID_INTENTS"),
        ),
      ).size !== (a.intents as unknown[]).length
    )
      fail("DUPLICATE_ID");
    if (a.completion !== null) {
      const w = obj(a.completion, "INVALID_COMPLETION");
      exact(
        w,
        ["completionId", "runId", "caseId", "status", "completion", "recordedAt"],
        "INVALID_COMPLETION",
      );
      if (
        !agentCompletion.safeParse(w.completion).success ||
        !agentCompletionStatusSchema.safeParse(w.status).success ||
        !idString.safeParse(w.completionId).success ||
        !idString.safeParse(w.runId).success ||
        !idString.safeParse(w.caseId).success ||
        w.runId !== a.runId ||
        w.caseId !== c.caseId ||
        (w.completion as Record<string, unknown>).run_id !== w.runId ||
        (w.completion as Record<string, unknown>).case_id !== w.caseId ||
        (w.completion as Record<string, unknown>).status !== w.status
      )
        fail("INVALID_COMPLETION");
    }
  }
  const cc = obj(r.checkpointCompletion, "INVALID_COMPLETION");
  if (cc.state === "ABSENT") {
    exact(cc, ["state"], "INVALID_COMPLETION");
    if (cp.last_run_id !== null) fail("MISMATCH_COMPLETION");
  } else if (cc.state === "CONFIRMED") {
    exact(cc, ["state", "value"], "INVALID_COMPLETION");
    const w = obj(cc.value, "INVALID_COMPLETION");
    exact(
      w,
      ["completionId", "runId", "caseId", "status", "completion", "recordedAt"],
      "INVALID_COMPLETION",
    );
    if (
      !agentCompletion.safeParse(w.completion).success ||
      !agentCompletionStatusSchema.safeParse(w.status).success ||
      !idString.safeParse(w.completionId).success ||
      !idString.safeParse(w.runId).success ||
      !idString.safeParse(w.caseId).success ||
      w.runId !== cp.last_run_id ||
      w.caseId !== c.caseId ||
      (w.completion as Record<string, unknown>).run_id !== w.runId ||
      (w.completion as Record<string, unknown>).case_id !== w.caseId ||
      (w.completion as Record<string, unknown>).status !== w.status
    )
      fail("MISMATCH_COMPLETION");
    const q = w.completion as Record<string, unknown>;
    if (q.run_id !== w.runId || q.case_id !== w.caseId || q.status !== w.status)
      fail("MISMATCH_COMPLETION");
  } else fail("INVALID_COMPLETION");
  arr(r.decisions, "INVALID_DECISIONS");
  arr(r.resumeJobs, "INVALID_JOBS");
  return r;
}
export function buildRecoveryPlan(input: unknown): RecoveryPlan {
  const i = obj(input, "INVALID_INPUT");
  exact(i, ["snapshot", "budgetBytes", "toolNames"], "INVALID_INPUT");
  const budgetBytes = int(i.budgetBytes, "INVALID_BUDGET");
  if (budgetBytes < 1) fail("INVALID_BUDGET");
  const tn = arr(i.toolNames, "INVALID_TOOLS");
  if (tn.some((x) => !idString.safeParse(x).success) || new Set(tn).size !== tn.length)
    fail("INVALID_TOOLS");
  const toolNames = [...tn] as string[];
  toolNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const s = parseSnapshot(i.snapshot),
    c = s.case as Record<string, unknown> & { checkpointRevision: number },
    cp = s.checkpoint as Record<string, unknown>,
    a = s.activeRun as Record<string, unknown> | null;
  const currentRevision = c.checkpointRevision as number;
  const ds = (s.decisions as unknown[]).map((raw) => {
    const d = obj(raw, "INVALID_DECISIONS");
    exact(d, ["request", "answer"], "INVALID_DECISIONS");
    const q = decisionRequest.safeParse(d.request);
    if (!q.success) fail("INVALID_DECISION");
    const request = q.data!;
    if (request.case_id !== c.caseId || request.checkpoint_revision > currentRevision)
      fail("MISMATCH_CASE_REVISION");
    let answer: (DecisionAnswer & { answerId: string }) | null = null;
    if (d.answer !== null) {
      const x = obj(d.answer, "INVALID_ANSWER");
      const answerId = str(x.answerId, "INVALID_ANSWER");
      const p = decisionAnswer.safeParse(
        Object.fromEntries(Object.entries(x).filter(([k]) => k !== "answerId")),
      );
      if (!p.success) fail("INVALID_ANSWER");
      const parsed = p.data!;
      try {
        assertAnswerMatchesRequest(request, parsed);
      } catch {
        fail("MISMATCH_DECISION");
      }
      answer = { ...parsed, answerId };
    }
    return { request, answer };
  });
  if (
    new Set(ds.map((x) => x.request.decision_id)).size !== ds.length ||
    new Set(ds.filter((x) => x.answer).map((x) => x.answer!.answerId)).size !==
      ds.filter((x) => x.answer).length
  )
    fail("DUPLICATE_ID");
  const js = (s.resumeJobs as unknown[]).map((raw) => {
    const j = obj(raw, "INVALID_JOB");
    exact(j, ["jobId", "status", "payload", "createdAt"], "INVALID_JOB");
    const p = obj(j.payload, "INVALID_JOB");
    exact(p, ["answerId", "decisionId", "caseId", "checkpointRevision"], "INVALID_JOB");
    const z = {
      jobId: str(j.jobId, "INVALID_JOB"),
      status: j.status,
      payload: {
        answerId: str(p.answerId, "INVALID_JOB"),
        decisionId: str(p.decisionId, "INVALID_JOB"),
        caseId: str(p.caseId, "INVALID_JOB"),
        checkpointRevision: int(p.checkpointRevision, "INVALID_JOB"),
      },
      createdAt: j.createdAt,
    };
    if (!jobStatus(j.status)) fail("INVALID_JOB");
    if (z.payload.caseId !== c.caseId || z.payload.checkpointRevision > currentRevision)
      fail("MISMATCH_JOB");
    return z;
  });
  if (
    new Set(js.map((x) => x.jobId)).size !== js.length ||
    new Set(js.map((x) => x.payload.answerId)).size !== js.length ||
    new Set(js.map((x) => x.payload.decisionId)).size !== js.length
  )
    fail("DUPLICATE_ID");
  for (const j of js) {
    const d = ds.find((x) => x.request.decision_id === j.payload.decisionId);
    if (
      !d?.answer ||
      d.answer.answerId !== j.payload.answerId ||
      d.answer.checkpoint_revision !== j.payload.checkpointRevision
    )
      fail("MISMATCH_JOB");
  }
  const scope = c.integrationScope as {
    providers: readonly string[];
    connection_ids: readonly string[];
  };
  const bs = (s.bindings as unknown[]).map((x): { provider: Provider; connectionId: string } => {
    const b = obj(x, "INVALID_BINDINGS");
    return { provider: b.provider as Provider, connectionId: b.connectionId as string };
  });
  if (
    bs.length !== scope.connection_ids.length ||
    new Set(bs.map((x) => x.connectionId)).size !== bs.length ||
    bs.some(
      (x) =>
        !scope.connection_ids.includes(x.connectionId) || !scope.providers.includes(x.provider),
    ) ||
    new Set(bs.map((x) => x.provider)).size !== scope.providers.length ||
    scope.providers.some((provider) => !bs.some((binding) => binding.provider === provider))
  )
    fail("INVALID_BINDINGS");
  bs.sort((x, y) => {
    const a = `${x.provider}:${x.connectionId}`,
      b = `${y.provider}:${y.connectionId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const red = new SecretRedactor();
  const fragments: ContextFragment[] = [
    {
      kind: "task",
      content: red.redactString(cp.goal as string),
      provenance: { origin: "model", reference: `recovery:task:${c.caseId}` },
      trust: TrustLevel.UNTRUSTED_DATA,
    },
    {
      kind: "checkpoint",
      content: red.serialize(cp),
      provenance: {
        origin: "model",
        reference: `recovery:checkpoint:${c.caseId}:${c.checkpointRevision}`,
      },
      trust: TrustLevel.UNTRUSTED_DATA,
    },
    ...ds.map((d) => ({
      kind: "decision" as const,
      content: red.serialize({ request: d.request, answer: d.answer }),
      provenance: {
        origin: "model" as const,
        reference: `recovery:decision:${c.caseId}:${d.request.checkpoint_revision}:${d.request.decision_id}`,
      },
      trust: TrustLevel.UNTRUSTED_DATA,
    })),
  ];
  const context = buildContext({
    scope: { caseId: c.caseId as string, ownerId: c.ownerId as string, connections: bs, toolNames },
    budgetBytes,
    fragments,
  });
  if (a) {
    const ins = arr(a.intents, "INVALID_INTENTS");
    if (!ins.length) fail("ACTIVE_RUN_WITHOUT_INTENT");
    if (
      a.completion !== null ||
      !(["INTENT_RECORDED", "STARTED"] as unknown[]).includes(a.safetyState)
    )
      fail("ACTIVE_COMPLETION");
    return { status: "RECONCILIATION_REQUIRED", automaticAction: { kind: "NONE" }, context };
  }
  const cs = s.checkpointCompletion as Record<string, unknown>;
  const completion =
    cs.state === "CONFIRMED"
      ? ((cs.value as Record<string, unknown>).completion as Record<string, unknown>)
      : null;
  let prepared: DecisionRequest | null = null;
  if (completion?.status === "WAITING_FOR_USER")
    prepared = prepareDecisionRequest({ completion, currentCheckpoint: cp });
  const current = prepared
    ? ds.find((d) => d.request.decision_id === prepared!.decision_id)
    : undefined;
  if (prepared && current && !same(current.request, prepared)) fail("MISMATCH_DECISION");
  if (prepared && !current) {
    if (c.status !== "PLANNING" && c.status !== "IMPLEMENTING") fail("WAITING_STATUS_MISMATCH");
    return {
      status: "MATERIALIZE_DECISION",
      automaticAction: {
        kind: "MATERIALIZE_DECISION",
        sourceRunId: str(completion!.run_id, "MISMATCH_COMPLETION"),
        preparedRequest: prepared,
      },
      context,
    };
  }
  if (prepared && current && !current.answer) {
    if (
      c.status !== "WAITING_FOR_USER" ||
      js.some((j) => j.payload.decisionId === current!.request.decision_id)
    )
      fail("WAITING_STATUS_MISMATCH");
    return { status: "WAITING_FOR_USER", automaticAction: { kind: "NONE" }, context };
  }
  if (prepared && current?.answer) {
    if (c.status !== "PLANNING") fail("WAITING_STATUS_MISMATCH");
    const m = js.filter(
      (j) =>
        j.payload.decisionId === current!.request.decision_id &&
        j.payload.answerId === current!.answer!.answerId &&
        j.payload.checkpointRevision === current!.answer!.checkpoint_revision,
    );
    if (m.length !== 1) fail(m.length ? "DUPLICATE_ID" : "ANSWER_WITHOUT_JOB");
    const j = m[0]!,
      r = {
        jobId: j.jobId,
        sourceRunId: str(completion!.run_id, "MISMATCH_COMPLETION"),
        answerId: current.answer.answerId,
        decisionId: current.request.decision_id,
      };
    return {
      status: "RESUME_QUEUED",
      automaticAction: { kind: "NONE" },
      resumeJob: r,
      context,
    };
  }
  if (c.status === "WAITING_FOR_USER") fail("WAITING_STATUS_MISMATCH");
  return { status: "READY", automaticAction: { kind: "NONE" }, context };
}
