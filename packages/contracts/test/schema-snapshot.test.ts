import { describe, expect, it } from "vitest";

import { buildJsonSchemaMap, contractSchemas, toJsonSchema } from "../src/schema.js";

/**
 * Snapshot of every contract's JSON Schema. A change here means a contract's
 * runtime shape changed; the reviewer must confirm the diff is intended and,
 * per RA-002, that `schema_version` and the migration note were updated when the
 * change is breaking.
 */
describe("JSON Schema snapshots", () => {
  it("matches the recorded schema map", () => {
    expect(buildJsonSchemaMap()).toMatchSnapshot();
  });

  it("emits fail-closed schemas (additionalProperties: false) for objects", () => {
    for (const name of Object.keys(contractSchemas)) {
      const schema = toJsonSchema(name as keyof typeof contractSchemas) as Record<string, unknown>;
      // Top-level is either a strict object or a discriminated union (anyOf).
      if (schema["type"] === "object") {
        expect(schema["additionalProperties"]).toBe(false);
      } else {
        expect(Array.isArray(schema["anyOf"]) || Array.isArray(schema["oneOf"])).toBe(true);
      }
    }
  });
});
