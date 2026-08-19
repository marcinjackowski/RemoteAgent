/**
 * Discord length/formatting limits and untrusted-content sanitization (RA-006).
 *
 * Two concerns live here:
 *
 *   1. Hard Discord limits. A message body is at most {@link MAX_MESSAGE_LENGTH}
 *      characters and a thread name at most {@link MAX_THREAD_NAME_LENGTH}. Sends
 *      that exceed the body limit are split into ordered chunks (never silently
 *      truncated), preferring line boundaries so formatting survives.
 *
 *   2. Untrusted content. Text originating from events, model output or owner
 *      input is UNTRUSTED_DATA (AGENTS.md §7). Before it reaches Discord we
 *      neutralize mass-mention injection (`@everyone` / `@here` and raw role/user
 *      mention syntax) so a crafted payload cannot ping a whole guild. We never
 *      execute or trust the content — we only make it inert as a Discord message.
 */

/** Discord's maximum message body length (characters). */
export const MAX_MESSAGE_LENGTH = 2000;

/** Discord's maximum thread name length (characters). */
export const MAX_THREAD_NAME_LENGTH = 100;

/**
 * Neutralize mass-mention and raw mention syntax in untrusted content by
 * inserting a zero-width space after the `@`, so the text is preserved verbatim
 * to a human reader but Discord never resolves it into a ping.
 */
export function neutralizeMentions(content: string): string {
  return (
    content
      .replace(/@(everyone|here)/gi, "@\u200b$1")
      // Raw mention markup: <@id>, <@!id>, <@&id>. Break the leading `<@`.
      .replace(/<@(!|&)?(\d+)>/g, "<@\u200b$1$2>")
  );
}

/**
 * Prepare untrusted text for delivery: neutralize mentions, then split into
 * ordered chunks each within {@link MAX_MESSAGE_LENGTH}. An empty/blank input
 * yields a single placeholder chunk so a message is always sendable. Splitting
 * prefers newline boundaries; a single over-long line is hard-split.
 *
 * `firstLimit` (defaulting to `limit`) bounds ONLY the first chunk, so a caller
 * that will append a marker to the first chunk can RESERVE room for it up front
 * and keep the final body within Discord's limit (AUDIT-03 MEDIUM-17).
 */
export function sanitizeMessage(
  content: string,
  limit = MAX_MESSAGE_LENGTH,
  firstLimit = limit,
): string[] {
  const safe = neutralizeMentions(content);
  const trimmed = safe.trim();
  if (trimmed.length === 0) {
    return ["_(empty message)_"];
  }
  return chunk(safe, limit, firstLimit);
}

/**
 * Sanitize a thread name: neutralize mentions, collapse newlines to spaces and
 * clamp to {@link MAX_THREAD_NAME_LENGTH}. Discord thread names must be a single
 * non-empty line.
 */
export function sanitizeThreadName(name: string): string {
  const oneLine = neutralizeMentions(name).replace(/\s+/g, " ").trim();
  const clamped = oneLine.slice(0, MAX_THREAD_NAME_LENGTH);
  return clamped.length === 0 ? "case" : clamped;
}

/**
 * Sanitize a single-message body that must NOT be split (e.g. the pinned status
 * projection): neutralize mentions and, if still too long, truncate with an
 * explicit marker so the reader knows content was elided.
 */
export function sanitizeSingle(content: string, limit = MAX_MESSAGE_LENGTH): string {
  const safe = neutralizeMentions(content);
  if (safe.length <= limit) {
    return safe.length === 0 ? "_(empty)_" : safe;
  }
  const marker = "\n… (truncated)";
  return safe.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/**
 * Final, defensive clamp of a single value to a hard character limit, applied by
 * the adapter right before it hits Discord (AUDIT-03 MEDIUM-17). Construction
 * already reserves room for markers, so this is a belt-and-braces guard that a
 * body/name can never exceed Discord's limit regardless of how it was built.
 */
export function clampToLimit(text: string, limit = MAX_MESSAGE_LENGTH): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function chunk(content: string, limit: number, firstLimit = limit): string[] {
  const chunks: string[] = [];
  let remaining = content;
  let currentLimit = firstLimit;
  while (remaining.length > currentLimit) {
    // Prefer to break on the last newline within the limit; otherwise hard-split.
    const window = remaining.slice(0, currentLimit);
    const newlineAt = window.lastIndexOf("\n");
    const cut = newlineAt > 0 ? newlineAt + 1 : currentLimit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    currentLimit = limit;
  }
  if (remaining.length > 0 || chunks.length === 0) {
    chunks.push(remaining);
  }
  return chunks;
}
