import { AgentRole, ROLE_CAN_WRITE_WORKSPACE } from "@remoteagent/contracts";
import { getRolePrompt, UnknownPromptVersionError } from "./prompts.js";
import {
  ROLE_PROMPT_VERSION,
  TOOL_MANIFEST_VERSION,
  type ModelIdentity,
  type RoleDefinition,
  type RoleRegistrySnapshot,
  type ToolManifest,
} from "./types.js";

export class UnknownRoleError extends Error {
  public constructor(public readonly role: string) {
    super(`Unknown semantic role '${role}'`);
    this.name = "UnknownRoleError";
  }
}

const roleValues = Object.values(AgentRole) as AgentRole[];

const ROLE_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = {
  [AgentRole.SUPERVISOR]: [],
  [AgentRole.PLANNER]: ["workspace.read"],
  [AgentRole.IMPLEMENTER]: ["workspace.read", "workspace.write", "checks.run"],
  [AgentRole.REVIEWER]: ["workspace.read", "diff.read"],
  [AgentRole.VERIFICATION]: ["workspace.read", "checks.run"],
  [AgentRole.SPECIALIST]: ["workspace.read"],
};

/** Immutable registry of semantic role bindings. Scope is intentionally absent. */
export class RoleRegistry {
  private readonly definitions: RoleRegistrySnapshot;

  public constructor(models: Readonly<Record<AgentRole, ModelIdentity>>) {
    const definitions = {} as Record<AgentRole, RoleDefinition>;
    for (const role of roleValues) {
      const model = models[role];
      if (!model) throw new UnknownRoleError(role);
      const toolManifest: ToolManifest = {
        version: TOOL_MANIFEST_VERSION,
        tools: ROLE_TOOLS[role],
        canWriteWorkspace: ROLE_CAN_WRITE_WORKSPACE[role],
      };
      definitions[role] = Object.freeze({
        role,
        prompt: Object.freeze(getRolePrompt(role, ROLE_PROMPT_VERSION)),
        model: Object.freeze({ ...model }),
        toolManifest: Object.freeze({
          ...toolManifest,
          tools: Object.freeze([...toolManifest.tools]),
        }),
      });
    }
    this.definitions = Object.freeze(definitions);
  }

  public get(role: AgentRole | string, promptVersion = ROLE_PROMPT_VERSION): RoleDefinition {
    const definition = this.definitions[role as AgentRole];
    if (!definition) throw new UnknownRoleError(role);
    if (definition.prompt.version !== promptVersion)
      throw new UnknownPromptVersionError(definition.role, promptVersion);
    return definition;
  }

  public getRole(role: AgentRole | string, promptVersion = ROLE_PROMPT_VERSION): RoleDefinition {
    return this.get(role, promptVersion);
  }

  public snapshot(): RoleRegistrySnapshot {
    return this.definitions;
  }
}

export function createRoleRegistry(
  models: Readonly<Record<AgentRole, ModelIdentity>>,
): RoleRegistry {
  return new RoleRegistry(models);
}
