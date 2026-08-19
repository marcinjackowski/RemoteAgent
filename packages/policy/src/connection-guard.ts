/** Fail-closed connection health and kill-switch evaluation. */
import { ConnectionHealth } from "@remoteagent/contracts";
import type { Provider } from "@remoteagent/contracts";

export interface KillSwitchState {
  level: "GLOBAL" | "PROVIDER" | "CONNECTION";
  provider: Provider | null;
  connectionId: string | null;
  enabled: boolean;
  reason: string;
}

export class ConnectionBlockedError extends Error {
  public readonly health: ConnectionHealth;

  public constructor(message: string, health: ConnectionHealth) {
    super(message);
    this.name = new.target.name;
    this.health = health;
  }
}

export function assertConnectionEffectAllowed(input: {
  connectionId: string;
  provider: Provider;
  health: ConnectionHealth;
  expiresAt: Date | null;
  now: Date;
  killSwitches: readonly KillSwitchState[];
}): void {
  const activeSwitch = input.killSwitches.find(
    (state) =>
      state.enabled &&
      (state.level === "GLOBAL" ||
        (state.level === "PROVIDER" && state.provider === input.provider) ||
        (state.level === "CONNECTION" &&
          state.provider === input.provider &&
          state.connectionId === input.connectionId)),
  );
  if (activeSwitch !== undefined) {
    throw new ConnectionBlockedError(
      `new external effects are disabled by ${activeSwitch.level} kill switch: ${activeSwitch.reason}`,
      input.health,
    );
  }

  if (input.health === ConnectionHealth.REVOKED) {
    throw new ConnectionBlockedError("connection credential is revoked", input.health);
  }
  if (
    input.health === ConnectionHealth.EXPIRED ||
    (input.expiresAt !== null && input.expiresAt.getTime() <= input.now.getTime())
  ) {
    throw new ConnectionBlockedError("connection credential is expired", ConnectionHealth.EXPIRED);
  }
  if (input.health === ConnectionHealth.ERROR) {
    throw new ConnectionBlockedError("connection health is ERROR", input.health);
  }
}
