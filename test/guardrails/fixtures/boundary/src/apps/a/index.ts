// Deliberately broken fixture: app "a" imports app "b", which the dependency
// boundary policy forbids (app -> app). The guardrails spec asserts eslint
// reports `boundaries/element-types` here. Excluded from the main lint run.
import { bName } from "../b/index.ts";

export const aName = `a-uses-${bName}` as const;
