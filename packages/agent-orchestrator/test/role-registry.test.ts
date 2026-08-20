import { describe, expect, it } from "vitest";
import { AgentRole } from "@remoteagent/contracts";
import {
  createRoleRegistry,
  UnknownPromptVersionError,
  UnknownRoleError,
} from "../src/roles/registry.js";

const registry = createRoleRegistry({
  SUPERVISOR: { provider: "provider-a", modelId: "model-supervisor" },
  PLANNER: { provider: "provider-a", modelId: "model-planner" },
  IMPLEMENTER: { provider: "provider-a", modelId: "model-implementer" },
  REVIEWER: { provider: "provider-a", modelId: "model-reviewer" },
  VERIFICATION: { provider: "provider-a", modelId: "model-verification" },
  SPECIALIST: { provider: "provider-a", modelId: "model-specialist" },
});

describe("role registry", () => {
  it("keeps semantic role and model identity separate", () => {
    const value = registry.get(AgentRole.IMPLEMENTER);
    expect(value.role).toBe(AgentRole.IMPLEMENTER);
    expect(value.model).toEqual({ provider: "provider-a", modelId: "model-implementer" });
    expect(value.prompt.version).toBe("v1");
  });

  it("fails closed for unknown roles and prompt versions", () => {
    expect(() => registry.get("NOT_A_ROLE")).toThrow(UnknownRoleError);
    expect(() => registry.get(AgentRole.PLANNER, "v999")).toThrow(UnknownPromptVersionError);
  });

  it("allows writes only for IMPLEMENTER and does not expose scope", () => {
    const snapshot = registry.snapshot();
    expect(snapshot.IMPLEMENTER.toolManifest.canWriteWorkspace).toBe(true);
    for (const role of Object.values(AgentRole)) {
      if (role !== AgentRole.IMPLEMENTER)
        expect(snapshot[role].toolManifest.canWriteWorkspace).toBe(false);
    }
    for (const definition of Object.values(snapshot)) {
      expect(definition.toolManifest).not.toHaveProperty("scope");
      expect(definition.toolManifest).not.toHaveProperty("connection_ids");
      expect(definition.toolManifest).not.toHaveProperty("repo_allowlist");
      expect(definition.prompt.system).not.toMatch(/secret|connection_ids|repo_allowlist/i);
    }
  });
});
