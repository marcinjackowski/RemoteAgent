import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  createRuntimeConfig,
  MAX_TOOL_CALLS,
  MAX_TOOL_ITERATIONS,
  MAX_TIMEOUT_MS,
} from "../src/index.js";

const valid = {
  model: { provider: "test-provider", model_id: "test-model" },
  timeoutMs: 5_000,
  toolLimits: { maxIterations: 3, maxCalls: 10 },
} as const;

describe("createRuntimeConfig", () => {
  it("returns only safe, immutable, provider-neutral configuration", () => {
    const config = createRuntimeConfig({ ...valid, credentials: "must-not-copy" } as never);
    expect(config).toEqual(valid);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.model)).toBe(true);
    expect(Object.isFrozen(config.toolLimits)).toBe(true);
    expect("credentials" in config).toBe(false);
  });

  it.each([
    ["timeoutMs", { ...valid, timeoutMs: 0 }],
    ["timeoutMs", { ...valid, timeoutMs: MAX_TIMEOUT_MS + 1 }],
    ["model", { ...valid, model: { ...valid.model, model_id: "" } }],
    [
      "maxIterations",
      { ...valid, toolLimits: { ...valid.toolLimits, maxIterations: MAX_TOOL_ITERATIONS + 1 } },
    ],
    ["maxCalls", { ...valid, toolLimits: { ...valid.toolLimits, maxCalls: MAX_TOOL_CALLS + 1 } }],
  ])("rejects invalid %s", (_field, input) => {
    expect(() => createRuntimeConfig(input)).toThrow(ConfigurationError);
  });

  it("allows zero limits to disable tools", () => {
    expect(
      createRuntimeConfig({ ...valid, toolLimits: { maxIterations: 0, maxCalls: 0 } }).toolLimits,
    ).toEqual({ maxIterations: 0, maxCalls: 0 });
  });
});
