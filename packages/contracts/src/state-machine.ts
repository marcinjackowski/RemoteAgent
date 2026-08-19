/**
 * Generic, declarative finite-state-machine helper.
 *
 * A machine is described by the set of allowed transitions between string
 * states. Attempting a transition that is not in the allowed set throws a typed
 * {@link InvalidTransitionError} and never mutates any state — the caller keeps
 * the previous value (RA-002 acceptance criterion 3).
 *
 * The helper is intentionally free of domain semantics so every contract
 * (Case lifecycle, run safety, …) reuses the same deterministic behavior and
 * the same error type.
 */

/** Typed error raised on a disallowed state transition. */
export class InvalidTransitionError<TState extends string> extends Error {
  public readonly machine: string;
  public readonly from: TState;
  public readonly to: TState;
  public readonly allowed: readonly TState[];

  public constructor(machine: string, from: TState, to: TState, allowed: readonly TState[]) {
    super(
      `Invalid ${machine} transition: ${from} -> ${to}. Allowed from ${from}: ` +
        (allowed.length > 0 ? allowed.join(", ") : "<none>"),
    );
    this.name = "InvalidTransitionError";
    this.machine = machine;
    this.from = from;
    this.to = to;
    this.allowed = allowed;
  }
}

/** Map of a state to the states reachable from it in one step. */
export type TransitionMap<TState extends string> = {
  readonly [K in TState]: readonly TState[];
};

export interface StateMachine<TState extends string> {
  readonly name: string;
  readonly states: readonly TState[];
  /** All non-terminal outgoing transitions, keyed by source state. */
  readonly transitions: TransitionMap<TState>;
  /** Whether `to` is reachable from `from` in exactly one step. */
  canTransition(from: TState, to: TState): boolean;
  /**
   * Return `to` if the transition is allowed, otherwise throw
   * {@link InvalidTransitionError}. The input state is never mutated.
   */
  assertTransition(from: TState, to: TState): TState;
  /** States with no outgoing transitions. */
  terminalStates(): readonly TState[];
  isTerminal(state: TState): boolean;
}

export function defineStateMachine<TState extends string>(
  name: string,
  transitions: TransitionMap<TState>,
): StateMachine<TState> {
  const states = Object.keys(transitions) as TState[];
  const stateSet = new Set<TState>(states);

  // Fail-closed sanity check: every declared target must be a known state.
  for (const from of states) {
    for (const to of transitions[from]) {
      if (!stateSet.has(to)) {
        throw new Error(
          `State machine ${name} declares transition to unknown state: ${from} -> ${to}`,
        );
      }
    }
  }

  const canTransition = (from: TState, to: TState): boolean => {
    if (!stateSet.has(from)) {
      return false;
    }
    return transitions[from].includes(to);
  };

  return {
    name,
    states,
    transitions,
    canTransition,
    assertTransition(from: TState, to: TState): TState {
      if (!stateSet.has(from)) {
        throw new InvalidTransitionError<TState>(name, from, to, []);
      }
      if (!canTransition(from, to)) {
        throw new InvalidTransitionError<TState>(name, from, to, transitions[from]);
      }
      return to;
    },
    terminalStates(): readonly TState[] {
      return states.filter((state) => transitions[state].length === 0);
    },
    isTerminal(state: TState): boolean {
      return stateSet.has(state) && transitions[state].length === 0;
    },
  };
}
