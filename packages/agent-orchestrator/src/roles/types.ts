import {
  AgentRole,
  ROLE_CAN_WRITE_WORKSPACE,
  agentRoleSchema,
  type AgentRole as AgentRoleValue,
} from "@remoteagent/contracts";

/** The model identity is deliberately independent from the semantic role. */
export type ModelIdentity = {
  readonly provider: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
};

/** A versioned prompt artifact. It contains no case scope or credentials. */
export type RolePrompt = {
  readonly version: string;
  readonly system: string;
};

/** Names and capabilities only; authoritative scope is assigned per WorkUnit. */
export type ToolManifest = {
  readonly version: string;
  readonly tools: readonly string[];
  readonly canWriteWorkspace: boolean;
};

export type RoleDefinition = {
  readonly role: AgentRoleValue;
  readonly prompt: RolePrompt;
  readonly model: ModelIdentity;
  readonly toolManifest: ToolManifest;
};

export type RoleRegistrySnapshot = Readonly<Record<AgentRoleValue, RoleDefinition>>;

export const ROLE_PROMPT_VERSION = "v1" as const;
export const TOOL_MANIFEST_VERSION = "v1" as const;

export function isKnownRole(value: string): value is AgentRoleValue {
  return agentRoleSchema.safeParse(value).success;
}

export function canRoleWriteWorkspace(role: AgentRoleValue): boolean {
  return ROLE_CAN_WRITE_WORKSPACE[role];
}

export { AgentRole };
