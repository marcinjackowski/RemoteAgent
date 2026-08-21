/**
 * The ONE set of secret shapes this system recognises (`CTF-006`, RA-024-WU-01).
 *
 * Before this module there were three, each with a different idea of what a secret
 * looks like:
 *
 *   - `SecretRedactor` (`./redaction.ts`) — knew `Bearer`, `Basic`, URL userinfo
 *     and `key=value`, and passed host paths, `glpat-`, `AKIA`, private keys and
 *     JWTs straight through;
 *   - `unsafeString` (`packages/repository-planner/src/profile.ts`) — knew all of
 *     those, but was private to that file;
 *   - `redactCommandOutput` (`packages/implementation-tools/src/command.ts`) — a
 *     third table, added in RA-012-WU-05 and marked `Transitional` precisely
 *     because it should collapse into this one.
 *
 * That is the failure mode `CTF-006` rates HIGH, and the reason is not that any one
 * table was weak: it is that "redaction is enabled" read as a complete guarantee
 * while `packages/agent-orchestrator/src/context/compaction.ts` was passing MODEL
 * CONTEXT through the weakest of the three. A partial mechanism behind a total
 * claim is worse than no mechanism, because nobody looks again.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The patterns are shared; the REACTION is not, and
 * that distinction is the whole design:
 *
 *   - {@link SecretRedactor} **masks** — a log line with a token in it is still
 *     worth having, minus the token;
 *   - `unsafeString` **rejects** — a repository profile is server-owned data that
 *     should never have contained a host path, so a match means the profile is
 *     wrong and must fail closed rather than be silently laundered.
 *
 * Sharing the reaction would break one of the two callers, so only
 * {@link SECRET_PATTERNS} and {@link containsSecretShape} live here.
 *
 * EACH PATTERN KEEPS CAPTURE GROUP 1 and replaces the rest. Group 1 is either the
 * boundary character that preceded the match or the credential's own scheme prefix
 * (`Bearer `, `https://`), so a redacted line still says WHAT was removed. Patterns
 * with nothing to preserve open with an empty `()` so every entry has the same
 * arity and a caller can treat them uniformly — a detail that matters, because the
 * alternative is a replacement callback that has to guess which groups exist.
 */

/** The placeholder every consumer in this repository substitutes. */
export const SECRET_PLACEHOLDER = "[REDACTED]";

/**
 * Secret and host-topology shapes, as `g`-flagged patterns with a group-1 prefix.
 *
 * Ordering is deliberate: the PEM block runs first because its body would
 * otherwise be shredded by the base64-ish patterns below into something no longer
 * recognisable as a key, and `file://` runs before the POSIX path matcher because a
 * URI form smuggles a host path past a leading-slash matcher.
 *
 * Every entry is `g`-flagged because callers use `String.replace` for ALL matches;
 * a missing `g` silently redacts only the first occurrence, which is exactly the
 * kind of half-measure this module exists to remove.
 */
export const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  // PEM private key blocks, header through footer, body included.
  /()-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  // An unterminated PEM header still leaks the key material that follows it, and a
  // truncated log or a streamed chunk is the normal way this arrives.
  /()-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gu,
  // `file://` URIs, which smuggle a host path past a leading-slash matcher.
  /()\bfile:\/\/\S+/giu,
  // POSIX host paths and Windows drive paths, wherever they appear in a line.
  /(^|[\s"'`=([<{,;:])((?:\/(?:Users|home|root|private|var|tmp|etc|opt|srv|mnt|media|Volumes|usr\/local)\b|[A-Za-z]:[\\/])[^\s"'`)\]>}]*)/gmu,
  // Provider tokens with a self-identifying prefix.
  /()\b(?:glpat-|glrt-|gh[pousr]_|github_pat_|xox[abposr]-|sk-|AKIA|ASIA)[A-Za-z0-9_-]{8,}/gu,
  // Google OAuth refresh/access tokens, which the two Gmail and two Calendar
  // connections hold and which match none of the shapes above.
  /()\b(?:1\/\/|ya29\.)[A-Za-z0-9_-]{10,}/gu,
  // Compact JWTs (header.payload.signature).
  /()\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  // HTTP credential schemes.
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu,
  /(\bBasic\s+)[A-Za-z0-9+/=]+/giu,
  // Credentials embedded in a URL's userinfo.
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
  // `key=value` / `key: value` credential assignments.
  /(\b(?:password|passphrase|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|credential|private[_-]?key)\s*[:=]\s*)[^\s,;]+/giu,
  // Credentials in a query string.
  /([?&](?:access_token|refresh_token|api_key|key|token|password)=)[^&#\s]+/giu,
]);

/**
 * Replace every recognised secret shape in `value`, keeping each pattern's prefix.
 *
 * The patterns are `g`-flagged and therefore stateful (`lastIndex`), but
 * `String.replace` resets `lastIndex` on entry and exit for a global regex, so
 * reusing the frozen array across calls is safe. Verified by test rather than
 * asserted here, because "shared mutable regex" is a real trap and a comment is not
 * evidence (`AGENTS.md` rule 9).
 */
export function maskSecretShapes(value: string, placeholder = SECRET_PLACEHOLDER): string {
  let masked = value;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (_match, prefix: string) => `${prefix}${placeholder}`);
  }
  return masked;
}

/**
 * Whether `value` contains anything shaped like a secret or a host path.
 *
 * This is the REJECT half of the split described in the module comment: a caller
 * holding server-owned data that must never contain these shapes uses this and
 * fails closed, instead of masking and continuing with a value it has now proven
 * untrustworthy.
 *
 * Implemented as "does masking change it?" rather than as a second pass of `.test()`
 * calls, so the two halves can never disagree about what a secret is — which is the
 * precise way the three tables drifted apart in the first place.
 */
export function containsSecretShape(value: string): boolean {
  return maskSecretShapes(value) !== value;
}
