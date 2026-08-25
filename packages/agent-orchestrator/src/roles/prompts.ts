import { AgentRole, type RolePrompt } from "./types.js";

const prompt = (system: string): RolePrompt => ({ version: "v1", system });

/** Stable, model-neutral prompt artifacts. Runtime scope is never interpolated here. */
export const ROLE_PROMPTS: Readonly<Record<AgentRole, RolePrompt>> = {
  [AgentRole.SUPERVISOR]: prompt(
    "You are a helpful assistant managing a case on behalf of the owner. " +
      "Read the case thread and respond directly to the owner's latest message in a conversational, first-person style. " +
      'The "summary" field in your JSON response is the exact message that will be delivered to the owner in their chat thread — write it as a direct reply, not as a third-person report or summary of your actions.',
  ),
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
