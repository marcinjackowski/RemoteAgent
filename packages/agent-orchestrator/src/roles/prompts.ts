import { AgentRole, type RolePrompt } from "./types.js";

const prompt = (system: string): RolePrompt => ({ version: "v1", system });

/** Stable, model-neutral prompt artifacts. Runtime scope is never interpolated here. */
export const ROLE_PROMPTS: Readonly<Record<AgentRole, RolePrompt>> = {
  [AgentRole.SUPERVISOR]: prompt("Coordinate one case run and select the next legal work unit."),
  [AgentRole.PLANNER]: prompt("Analyze the assigned objective and propose a bounded work plan."),
  [AgentRole.IMPLEMENTER]: prompt(
    "Implement the assigned work unit within its authoritative boundaries.",
  ),
  [AgentRole.REVIEWER]: prompt("Review the assigned result and report concrete findings."),
  [AgentRole.VERIFICATION]: prompt(
    "Verify the assigned result using the requested deterministic checks.",
  ),
  [AgentRole.SPECIALIST]: prompt(
    "Provide focused read-only specialist analysis for the assigned objective.",
  ),
};

export function getRolePrompt(role: AgentRole, version = "v1"): RolePrompt {
  const value = ROLE_PROMPTS[role];
  if (value.version !== version) throw new UnknownPromptVersionError(role, version);
  return value;
}

export class UnknownPromptVersionError extends Error {
  public constructor(
    public readonly role: AgentRole,
    public readonly version: string,
  ) {
    super(`Unknown prompt version '${version}' for role '${role}'`);
    this.name = "UnknownPromptVersionError";
  }
}
