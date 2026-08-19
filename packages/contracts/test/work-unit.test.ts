import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import { AgentRole, ROLE_CAN_WRITE_WORKSPACE, workUnit } from "../src/work-unit.js";

const base = {
  schema_version: CURRENT_SCHEMA_VERSION,
  work_unit_id: "wu-1",
  case_id: "c-1",
  status: "PENDING",
  objective: "do the thing",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as const;

describe("WorkUnit single-writer invariant (runtime)", () => {
  it("accepts an IMPLEMENTER with can_write_workspace=true", () => {
    const parsed = workUnit.parse({
      ...base,
      role: AgentRole.IMPLEMENTER,
      authoritative_scope: { can_write_workspace: true },
    });
    expect(parsed.authoritative_scope.can_write_workspace).toBe(true);
  });

  it("rejects an IMPLEMENTER that claims can_write_workspace=false", () => {
    const res = workUnit.safeParse({
      ...base,
      role: AgentRole.IMPLEMENTER,
      authoritative_scope: { can_write_workspace: false },
    });
    expect(res.success).toBe(false);
  });

  it("rejects every non-IMPLEMENTER role that claims can_write_workspace=true", () => {
    for (const role of [
      AgentRole.SUPERVISOR,
      AgentRole.PLANNER,
      AgentRole.REVIEWER,
      AgentRole.VERIFICATION,
      AgentRole.SPECIALIST,
    ]) {
      const res = workUnit.safeParse({
        ...base,
        role,
        authoritative_scope: { can_write_workspace: true },
      });
      expect(res.success, `${role} must not be able to write`).toBe(false);
    }
  });

  it("accepts non-IMPLEMENTER roles with can_write_workspace=false", () => {
    for (const role of [
      AgentRole.SUPERVISOR,
      AgentRole.PLANNER,
      AgentRole.REVIEWER,
      AgentRole.VERIFICATION,
      AgentRole.SPECIALIST,
    ]) {
      const parsed = workUnit.parse({
        ...base,
        role,
        authoritative_scope: { can_write_workspace: false },
      });
      expect(parsed.authoritative_scope.can_write_workspace).toBe(false);
    }
  });

  it("stays consistent with the ROLE_CAN_WRITE_WORKSPACE helper map", () => {
    for (const role of Object.values(AgentRole)) {
      const canWrite = ROLE_CAN_WRITE_WORKSPACE[role];
      const res = workUnit.safeParse({
        ...base,
        role,
        authoritative_scope: { can_write_workspace: canWrite },
      });
      expect(res.success, `${role} map value must be accepted`).toBe(true);
    }
    expect(ROLE_CAN_WRITE_WORKSPACE[AgentRole.IMPLEMENTER]).toBe(true);
  });
});
