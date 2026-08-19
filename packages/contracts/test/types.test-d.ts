import { describe, expectTypeOf, it } from "vitest";

import type {
  AgentCompletion,
  WaitingForUserCompletion,
  ContinueCompletion,
} from "../src/agent-completion.js";
import { AgentCompletionStatus } from "../src/agent-completion.js";
import type { DecisionRequest } from "../src/decision.js";
import type { ToolIntent } from "../src/tool.js";
import type { WorkUnit } from "../src/work-unit.js";
import { AgentRole } from "../src/work-unit.js";

/**
 * Compile-time type tests. These assertions are enforced by `tsc`
 * (tsconfig.test.json) and would fail the typecheck if the discriminated unions
 * or scope-isolation guarantees regressed.
 */
describe("AgentCompletion discriminated union (type-level)", () => {
  it("narrows WAITING_FOR_USER to require a decision_request", () => {
    const narrow = (c: AgentCompletion): DecisionRequest | undefined => {
      if (c.status === AgentCompletionStatus.WAITING_FOR_USER) {
        // In this branch the field is present and typed.
        expectTypeOf(c).toEqualTypeOf<WaitingForUserCompletion>();
        return c.decision_request;
      }
      return undefined;
    };
    expectTypeOf(narrow).toBeFunction();
  });

  it("does not expose decision_request on the CONTINUE variant", () => {
    expectTypeOf<ContinueCompletion>().not.toHaveProperty("decision_request");
  });

  it("exhaustively covers every status", () => {
    const assertExhaustive = (c: AgentCompletion): string => {
      switch (c.status) {
        case AgentCompletionStatus.CONTINUE:
          return "continue";
        case AgentCompletionStatus.WAITING_FOR_USER:
          return "waiting";
        case AgentCompletionStatus.BLOCKED:
          return "blocked";
        case AgentCompletionStatus.COMPLETED:
          return "completed";
        case AgentCompletionStatus.FAILED:
          return "failed";
        case AgentCompletionStatus.CANCELLED:
          return "cancelled";
        default: {
          // If a variant is added without handling, this line fails to compile.
          const _exhaustive: never = c;
          return _exhaustive;
        }
      }
    };
    expectTypeOf(assertExhaustive).toBeFunction();
  });
});

describe("ToolIntent scope isolation (type-level)", () => {
  it("has no authoritative scope field", () => {
    expectTypeOf<ToolIntent>().not.toHaveProperty("scope");
    expectTypeOf<ToolIntent>().not.toHaveProperty("owner_id");
    expectTypeOf<ToolIntent>().not.toHaveProperty("connection_ids");
  });
});

describe("WorkUnit single-writer invariant (type-level)", () => {
  it("pins can_write_workspace to true only for the IMPLEMENTER variant", () => {
    const canWriteOf = (unit: WorkUnit): boolean => {
      if (unit.role === AgentRole.IMPLEMENTER) {
        // In the implementer branch the literal type is `true`.
        expectTypeOf(unit.authoritative_scope.can_write_workspace).toEqualTypeOf<true>();
        return unit.authoritative_scope.can_write_workspace;
      }
      // Every other role narrows to the read-only literal `false`.
      expectTypeOf(unit.authoritative_scope.can_write_workspace).toEqualTypeOf<false>();
      return unit.authoritative_scope.can_write_workspace;
    };
    expectTypeOf(canWriteOf).toBeFunction();
  });

  it("discriminates the union on role", () => {
    expectTypeOf<WorkUnit["role"]>().toEqualTypeOf<AgentRole>();
  });
});
