import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import { caseCheckpoint } from "../src/checkpoint.js";
import { agentCompletion, AgentCompletionStatus } from "../src/agent-completion.js";
import { toolResult, ToolResultStatus } from "../src/tool.js";
import { TrustLevel } from "../src/trust.js";

/**
 * External-derived / model / tool boundaries must not let the sender relabel
 * content as TRUSTED: the trust marker is a fixed literal UNTRUSTED_DATA. These
 * regressions cover the three boundaries called out in AUDIT-03.
 */

const checkpointBase = {
  schema_version: CURRENT_SCHEMA_VERSION,
  case_id: "c-1",
  revision: 0,
  goal: "ship it",
  current_phase: "implementing",
  plan_revision: 0,
  workspace_state: {},
  branch_state: {},
  merge_request_state: {},
  updated_at: "2026-01-01T00:00:00Z",
};

describe("CaseCheckpoint.summary is untrusted-only (persisted external-derived)", () => {
  it("accepts UNTRUSTED_DATA", () => {
    const res = caseCheckpoint.safeParse({
      ...checkpointBase,
      summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "external-derived text" },
    });
    expect(res.success).toBe(true);
  });

  it("rejects a sender-supplied TRUSTED marker", () => {
    const res = caseCheckpoint.safeParse({
      ...checkpointBase,
      summary: { trust: TrustLevel.TRUSTED, value: "external-derived text" },
    });
    expect(res.success).toBe(false);
  });
});

describe("AgentCompletion.checkpoint_patch.summary is untrusted-only (model output)", () => {
  const completionBase = {
    schema_version: CURRENT_SCHEMA_VERSION,
    run_id: "r-1",
    case_id: "c-1",
    summary: "did work",
    status: AgentCompletionStatus.CONTINUE,
  };

  it("accepts UNTRUSTED_DATA in the patch summary", () => {
    const res = agentCompletion.safeParse({
      ...completionBase,
      checkpoint_patch: { summary: { trust: TrustLevel.UNTRUSTED_DATA, value: "model summary" } },
    });
    expect(res.success).toBe(true);
  });

  it("rejects a model-supplied TRUSTED marker in the patch summary", () => {
    const res = agentCompletion.safeParse({
      ...completionBase,
      checkpoint_patch: { summary: { trust: TrustLevel.TRUSTED, value: "model summary" } },
    });
    expect(res.success).toBe(false);
  });
});

describe("ToolResult.output is untrusted-only (tool-derived)", () => {
  const resultBase = {
    schema_version: CURRENT_SCHEMA_VERSION,
    intent_id: "i-1",
    status: ToolResultStatus.SUCCEEDED,
    latency_ms: 10,
    correlation_id: "corr-1",
    observed_at: "2026-01-01T00:00:00Z",
  };

  it("accepts UNTRUSTED_DATA output", () => {
    const res = toolResult.safeParse({
      ...resultBase,
      output: { trust: TrustLevel.UNTRUSTED_DATA, value: { rows: 3 } },
    });
    expect(res.success).toBe(true);
  });

  it("rejects a tool-supplied TRUSTED marker on output", () => {
    const res = toolResult.safeParse({
      ...resultBase,
      output: { trust: TrustLevel.TRUSTED, value: { rows: 3 } },
    });
    expect(res.success).toBe(false);
  });
});
