/**
 * `@remoteagent/review-loop` — an independent, bounded review/fix loop.
 *
 * Three absences carry the design. The reviewer context contains no function, so
 * the reviewer holds no write capability and is read-only by construction rather
 * than by rule. The readiness verdict has no setter, so it is derived from real
 * reports or not at all. And the loop has no unbounded path: exhausting its
 * iteration or token budget yields `ESCALATED`, never a quiet pass.
 *
 * A blocking finding must name a location and quote text that actually appears in
 * the diff. An unsubstantiated remark is downgraded rather than dropped — it can
 * still be read, but it cannot stop work it cannot substantiate.
 *
 * This barrel shares NO exported name with the packages it builds on, asserted by a
 * test: ESM silently drops an ambiguous name from `export *`, and RA-014 showed the
 * sharper failure — two same-named schemas with different rules, where the laxer one
 * silently wins.
 */
export * from "./contracts.js";
export * from "./reviewer.js";
export * from "./loop.js";
export * from "./pre-commit.js";
