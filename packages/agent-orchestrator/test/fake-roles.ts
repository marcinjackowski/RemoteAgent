import { agentCompletion, type AgentCompletion, type AgentRole } from "@remoteagent/contracts";

import type { RuntimeRole, RuntimeRoleInput, RuntimeRoles } from "../src/supervisor/runtime.js";

export type FakeRoleFault = "BEFORE_RETURN" | "AFTER_WRITER_FENCE";

export interface FakeRoleOptions {
  readonly completion:
    AgentCompletion | ((input: RuntimeRoleInput) => AgentCompletion | Promise<AgentCompletion>);
  readonly fault?: FakeRoleFault;
}

/** Deterministic role doubles; no model, clock, or network is involved. */
export class FakeRoles {
  readonly #calls = new Map<string, number>();
  readonly #roles: RuntimeRoles;
  readonly #options: Readonly<Record<AgentRole, FakeRoleOptions>>;

  public constructor(options: Partial<Record<AgentRole, FakeRoleOptions>>) {
    this.#options = options as Readonly<Record<AgentRole, FakeRoleOptions>>;
    const roles: Partial<Record<AgentRole, RuntimeRole>> = {};
    for (const role of Object.keys(options) as AgentRole[]) {
      roles[role] = { invoke: (input) => this.invoke(role, input) };
    }
    this.#roles = roles;
  }

  public get roles(): RuntimeRoles {
    return this.#roles;
  }

  public calls(workUnitId: string): number {
    return this.#calls.get(workUnitId) ?? 0;
  }

  public totalCalls(): number {
    return [...this.#calls.values()].reduce((total, count) => total + count, 0);
  }

  private async invoke(role: AgentRole, input: RuntimeRoleInput): Promise<AgentCompletion> {
    const count = this.#calls.get(input.unit.workUnit.work_unit_id) ?? 0;
    this.#calls.set(input.unit.workUnit.work_unit_id, count + 1);
    const option = this.#options[role];
    if (!option) throw new Error(`no fake configured for ${role}`);
    if (option.fault === "BEFORE_RETURN") throw new Error("injected fake role fault");
    if (option.fault === "AFTER_WRITER_FENCE" && input.writerFence) {
      await input.writerFence.assertCurrent();
      throw new Error("injected fake role fault after fence");
    }
    const completion =
      typeof option.completion === "function" ? await option.completion(input) : option.completion;
    const parsed = agentCompletion.safeParse(completion);
    if (!parsed.success) throw new Error("fake completion is invalid");
    return parsed.data;
  }
}
