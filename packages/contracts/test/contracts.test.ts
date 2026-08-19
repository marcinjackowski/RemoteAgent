import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import { eventEnvelope } from "../src/event-envelope.js";
import { externalEntityRef, Provider, ExternalEntityKind } from "../src/external-entity.js";
import { caseContract, CaseStatus } from "../src/case.js";
import { toolIntent, resolvedToolIntent } from "../src/tool.js";
import { TrustLevel } from "../src/trust.js";
import {
  agentCompletion,
  AgentCompletionStatus,
  isTerminalCompletion,
} from "../src/agent-completion.js";
import {
  decisionRequest,
  decisionAnswer,
  assertAnswerMatchesRequest,
  StaleDecisionAnswerError,
  DecisionMismatchError,
  UnknownDecisionOptionError,
} from "../src/decision.js";

const validEntity = {
  provider: Provider.JIRA,
  connection_id: "conn-1",
  kind: ExternalEntityKind.JIRA_ISSUE,
  external_id: "PROJ-1",
};

const validEnvelope = {
  schema_version: CURRENT_SCHEMA_VERSION,
  event_id: "evt-1",
  provider: Provider.JIRA,
  connection_id: "conn-1",
  external_event_id: "x-1",
  event_type: "issue_updated",
  occurred_at: "2026-01-01T00:00:00Z",
  received_at: "2026-01-01T00:00:01Z",
  actor: { external_actor_id: "u-1" },
  entity_ref: validEntity,
  dedupe_key: "d-1",
  payload_ref: {
    ref: "s3://raw/1",
    digest: `sha256:${"0".repeat(64)}`,
  },
  trace_id: "trace-1",
  sensitivity: "internal",
};

describe("boundary contracts reject unknown fields (fail-closed)", () => {
  it("EventEnvelope rejects an unexpected top-level key", () => {
    const bad = { ...validEnvelope, injected: "evil" };
    expect(eventEnvelope.safeParse(bad).success).toBe(false);
  });

  it("EventEnvelope accepts a well-formed envelope", () => {
    const parsed = eventEnvelope.parse(validEnvelope);
    expect(parsed.correlation_keys).toEqual([]);
  });

  it("EventEnvelope rejects entity_ref.connection_id different from the top-level connection_id", () => {
    const bad = {
      ...validEnvelope,
      entity_ref: { ...validEntity, connection_id: "conn-other" },
    };
    expect(eventEnvelope.safeParse(bad).success).toBe(false);
  });

  it("EventEnvelope rejects entity_ref.provider different from the top-level provider", () => {
    const bad = {
      ...validEnvelope,
      provider: Provider.GITLAB,
      // entity_ref stays on jira -> provider mismatch (connection still matches).
      entity_ref: { ...validEntity, provider: Provider.JIRA },
    };
    expect(eventEnvelope.safeParse(bad).success).toBe(false);
  });

  it("ExternalEntityRef rejects unknown provider", () => {
    const res = externalEntityRef.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      ...validEntity,
      provider: "slack",
    });
    expect(res.success).toBe(false);
  });

  it("Case rejects unknown nested key in integration_scope", () => {
    const res = caseContract.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      case_id: "c-1",
      owner_id: "o-1",
      status: CaseStatus.NEW,
      integration_scope: {
        providers: [Provider.JIRA],
        connection_ids: ["conn-1"],
        surprise: true,
      },
      discord_thread_id: "th-1",
      checkpoint_revision: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(res.success).toBe(false);
  });
});

describe("trust markers", () => {
  it("carries an explicit trust marker on external display names", () => {
    const parsed = eventEnvelope.parse({
      ...validEnvelope,
      actor: {
        external_actor_id: "u-1",
        display_name: { trust: TrustLevel.UNTRUSTED_DATA, value: "Jane" },
      },
    });
    expect(parsed.actor.display_name?.trust).toBe(TrustLevel.UNTRUSTED_DATA);
  });

  it("requires the trust field to be present", () => {
    const res = eventEnvelope.safeParse({
      ...validEnvelope,
      actor: {
        external_actor_id: "u-1",
        display_name: { value: "Jane" },
      },
    });
    expect(res.success).toBe(false);
  });

  it("forbids a TRUSTED marker on a provider-controlled display name", () => {
    const res = eventEnvelope.safeParse({
      ...validEnvelope,
      actor: {
        external_actor_id: "u-1",
        display_name: { trust: TrustLevel.TRUSTED, value: "Jane" },
      },
    });
    expect(res.success).toBe(false);
  });
});

describe("authoritative scope is not sourced from model output", () => {
  it("ToolIntent has no scope field and marks arguments untrusted", () => {
    const parsed = toolIntent.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      intent_id: "i-1",
      tool_name: "jira.get_issue",
      arguments: { trust: TrustLevel.UNTRUSTED_DATA, value: { key: "PROJ-1" } },
    });
    expect("scope" in parsed).toBe(false);
    expect(parsed.arguments.trust).toBe(TrustLevel.UNTRUSTED_DATA);
  });

  it("ToolIntent rejects an injected scope field", () => {
    const res = toolIntent.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      intent_id: "i-1",
      tool_name: "jira.get_issue",
      arguments: { trust: TrustLevel.UNTRUSTED_DATA, value: {} },
      scope: { owner_id: "attacker" },
    });
    expect(res.success).toBe(false);
  });

  it("ResolvedToolIntent (broker-built) carries authoritative scope separately", () => {
    const parsed = resolvedToolIntent.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      intent_id: "i-1",
      case_id: "c-1",
      tool_name: "jira.get_issue",
      arguments: { key: "PROJ-1" },
      scope: { owner_id: "o-1" },
    });
    expect(parsed.scope.owner_id).toBe("o-1");
  });
});

describe("AgentCompletion discriminated union", () => {
  const base = {
    schema_version: CURRENT_SCHEMA_VERSION,
    run_id: "r-1",
    case_id: "c-1",
    summary: "did work",
    checkpoint_patch: {},
  };

  it("accepts WAITING_FOR_USER only with a decision_request", () => {
    const withoutDecision = agentCompletion.safeParse({
      ...base,
      status: AgentCompletionStatus.WAITING_FOR_USER,
    });
    expect(withoutDecision.success).toBe(false);

    const withDecision = agentCompletion.safeParse({
      ...base,
      status: AgentCompletionStatus.WAITING_FOR_USER,
      decision_request: {
        schema_version: CURRENT_SCHEMA_VERSION,
        decision_id: "d-1",
        case_id: "c-1",
        question: "Which approach?",
        why_now: "blocks impl",
        options: [
          { id: "a", label: "A", consequences: "x" },
          { id: "b", label: "B", consequences: "y" },
        ],
        recommendation: "a",
        blocked_scope: "impl",
        checkpoint_revision: 3,
      },
    });
    expect(withDecision.success).toBe(true);
  });

  it("rejects a decision_request on CONTINUE (unknown key)", () => {
    const res = agentCompletion.safeParse({
      ...base,
      status: AgentCompletionStatus.CONTINUE,
      decision_request: {},
    });
    expect(res.success).toBe(false);
  });

  const validDecision = (caseId: string) => ({
    schema_version: CURRENT_SCHEMA_VERSION,
    decision_id: "d-1",
    case_id: caseId,
    question: "Which approach?",
    why_now: "blocks impl",
    options: [
      { id: "a", label: "A", consequences: "x" },
      { id: "b", label: "B", consequences: "y" },
    ],
    recommendation: "a",
    blocked_scope: "impl",
    checkpoint_revision: 3,
  });

  it("WAITING_FOR_USER accepts a decision_request bound to the same case_id", () => {
    const res = agentCompletion.safeParse({
      ...base,
      status: AgentCompletionStatus.WAITING_FOR_USER,
      decision_request: validDecision(base.case_id),
    });
    expect(res.success).toBe(true);
  });

  it("WAITING_FOR_USER rejects a decision_request for a different case_id (no cross-case)", () => {
    const res = agentCompletion.safeParse({
      ...base,
      status: AgentCompletionStatus.WAITING_FOR_USER,
      decision_request: validDecision("case-other"),
    });
    expect(res.success).toBe(false);
  });

  it("classifies terminal statuses", () => {
    expect(isTerminalCompletion(AgentCompletionStatus.COMPLETED)).toBe(true);
    expect(isTerminalCompletion(AgentCompletionStatus.FAILED)).toBe(true);
    expect(isTerminalCompletion(AgentCompletionStatus.CANCELLED)).toBe(true);
    expect(isTerminalCompletion(AgentCompletionStatus.CONTINUE)).toBe(false);
    expect(isTerminalCompletion(AgentCompletionStatus.WAITING_FOR_USER)).toBe(false);
    expect(isTerminalCompletion(AgentCompletionStatus.BLOCKED)).toBe(false);
  });

  it("requires reasons on BLOCKED/FAILED/CANCELLED", () => {
    expect(
      agentCompletion.safeParse({ ...base, status: AgentCompletionStatus.BLOCKED }).success,
    ).toBe(false);
    expect(
      agentCompletion.safeParse({
        ...base,
        status: AgentCompletionStatus.FAILED,
        failure_reason: "boom",
      }).success,
    ).toBe(true);
  });
});

describe("DecisionRequest / Answer binding", () => {
  const request = decisionRequest.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    decision_id: "d-1",
    case_id: "c-1",
    question: "Which?",
    why_now: "now",
    options: [
      { id: "a", label: "A", consequences: "x" },
      { id: "b", label: "B", consequences: "y" },
    ],
    recommendation: "a",
    blocked_scope: "impl",
    checkpoint_revision: 5,
  });

  it("rejects a recommendation that is not an option", () => {
    const res = decisionRequest.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-2",
      case_id: "c-1",
      question: "Which?",
      why_now: "now",
      options: [
        { id: "a", label: "A", consequences: "x" },
        { id: "b", label: "B", consequences: "y" },
      ],
      recommendation: "zzz",
      blocked_scope: "impl",
      checkpoint_revision: 5,
    });
    expect(res.success).toBe(false);
  });

  it("rejects duplicate option ids", () => {
    const res = decisionRequest.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-dup",
      case_id: "c-1",
      question: "Which?",
      why_now: "now",
      options: [
        { id: "a", label: "A", consequences: "x" },
        { id: "a", label: "A again", consequences: "y" },
      ],
      recommendation: "a",
      blocked_scope: "impl",
      checkpoint_revision: 5,
    });
    expect(res.success).toBe(false);
  });

  it("accepts the maximum of three options", () => {
    const res = decisionRequest.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-3opt",
      case_id: "c-1",
      question: "Which?",
      why_now: "now",
      options: [
        { id: "a", label: "A", consequences: "x" },
        { id: "b", label: "B", consequences: "y" },
        { id: "c", label: "C", consequences: "z" },
      ],
      recommendation: "a",
      blocked_scope: "impl",
      checkpoint_revision: 5,
    });
    expect(res.success).toBe(true);
  });

  it("rejects a fourth option (workflow allows exactly 2-3)", () => {
    const res = decisionRequest.safeParse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-4opt",
      case_id: "c-1",
      question: "Which?",
      why_now: "now",
      options: [
        { id: "a", label: "A", consequences: "x" },
        { id: "b", label: "B", consequences: "y" },
        { id: "c", label: "C", consequences: "z" },
        { id: "d", label: "D", consequences: "w" },
      ],
      recommendation: "a",
      blocked_scope: "impl",
      checkpoint_revision: 5,
    });
    expect(res.success).toBe(false);
  });

  it("accepts an answer at the same revision", () => {
    const answer = decisionAnswer.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-1",
      case_id: "c-1",
      checkpoint_revision: 5,
      selected_option_id: "b",
      answered_by: "owner",
      answered_at: "2026-01-01T00:00:00Z",
    });
    expect(() => assertAnswerMatchesRequest(request, answer)).not.toThrow();
  });

  it("rejects a stale answer at an older revision", () => {
    const answer = decisionAnswer.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-1",
      case_id: "c-1",
      checkpoint_revision: 4,
      selected_option_id: "b",
      answered_by: "owner",
      answered_at: "2026-01-01T00:00:00Z",
    });
    expect(() => assertAnswerMatchesRequest(request, answer)).toThrow(StaleDecisionAnswerError);
  });

  it("rejects an answer for a different decision_id with a mismatch error", () => {
    const answer = decisionAnswer.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "other-decision",
      case_id: "c-1",
      checkpoint_revision: 5,
      selected_option_id: "b",
      answered_by: "owner",
      answered_at: "2026-01-01T00:00:00Z",
    });
    expect(() => assertAnswerMatchesRequest(request, answer)).toThrow(DecisionMismatchError);
    try {
      assertAnswerMatchesRequest(request, answer);
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionMismatchError);
      expect((error as DecisionMismatchError).field).toBe("decision_id");
    }
  });

  it("rejects an answer for a different case_id with a mismatch error", () => {
    const answer = decisionAnswer.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-1",
      case_id: "other-case",
      checkpoint_revision: 5,
      selected_option_id: "b",
      answered_by: "owner",
      answered_at: "2026-01-01T00:00:00Z",
    });
    expect(() => assertAnswerMatchesRequest(request, answer)).toThrow(DecisionMismatchError);
    try {
      assertAnswerMatchesRequest(request, answer);
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionMismatchError);
      expect((error as DecisionMismatchError).field).toBe("case_id");
    }
  });

  it("rejects an answer selecting a non-existent option with a typed error", () => {
    const answer = decisionAnswer.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      decision_id: "d-1",
      case_id: "c-1",
      checkpoint_revision: 5,
      selected_option_id: "does-not-exist",
      answered_by: "owner",
      answered_at: "2026-01-01T00:00:00Z",
    });
    expect(() => assertAnswerMatchesRequest(request, answer)).toThrow(UnknownDecisionOptionError);
  });
});
