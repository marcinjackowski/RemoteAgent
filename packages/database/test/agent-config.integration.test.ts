/**
 * RA-032 WU-01: server-owned agent config — AgentConfigRepository get/set/upsert and resolveModelId
 * precedence (DB config wins over env, env over the built-in default).
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  AgentConfigRepository,
  DEFAULT_MODEL_ID,
  Database,
  MODEL_ID_KEY,
  resolveModelId,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";

let db: Database;
let drop: () => Promise<void>;
const config = new AgentConfigRepository();

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});
afterEach(async () => {
  await drop();
});

it("resolveModelId falls back env-then-default when the DB has no config", async () => {
  expect(DEFAULT_MODEL_ID).toBe("us.anthropic.claude-opus-4-8");
  expect(await resolveModelId(db, {})).toBe(DEFAULT_MODEL_ID);
  expect(await resolveModelId(db, { RA_MODEL_ID: "from-ra-env" })).toBe("from-ra-env");
  // BEDROCK_MODEL_ID takes precedence over RA_MODEL_ID.
  expect(
    await resolveModelId(db, { BEDROCK_MODEL_ID: "from-bedrock", RA_MODEL_ID: "from-ra" }),
  ).toBe("from-bedrock");
});

it("DB config wins over env, and set() upserts", async () => {
  await config.set(db, MODEL_ID_KEY, "us.anthropic.claude-opus-4-8");
  expect(await resolveModelId(db, { BEDROCK_MODEL_ID: "ignored-env" })).toBe(
    "us.anthropic.claude-opus-4-8",
  );
  expect(await config.get(db, MODEL_ID_KEY)).toBe("us.anthropic.claude-opus-4-8");

  await config.set(db, MODEL_ID_KEY, "us.anthropic.claude-sonnet-5");
  expect(await config.get(db, MODEL_ID_KEY)).toBe("us.anthropic.claude-sonnet-5");
});
