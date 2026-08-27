import { expect, it } from "vitest";

import {
  ToolLimitError as NeutralToolLimitError,
  createRuntimeConfig as createNeutralRuntimeConfig,
} from "@remoteagent/model-runtime";

import {
  ToolLimitError as BedrockCompatibilityToolLimitError,
  createRuntimeConfig as createBedrockCompatibilityRuntimeConfig,
} from "../src/index.js";

it("re-exports the single provider-neutral runtime rather than defining a second contract", () => {
  expect(BedrockCompatibilityToolLimitError).toBe(NeutralToolLimitError);
  expect(createBedrockCompatibilityRuntimeConfig).toBe(createNeutralRuntimeConfig);
  expect(new NeutralToolLimitError("limit")).toBeInstanceOf(BedrockCompatibilityToolLimitError);
});
