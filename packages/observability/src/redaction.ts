/** Recursive, non-mutating redaction for logs, errors and serialized context. */
import { SECRET_PLACEHOLDER, maskSecretShapes } from "./secret-patterns.js";

const REDACTED = SECRET_PLACEHOLDER;

const SENSITIVE_KEY =
  /(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|bearer[_-]?token|client[_-]?secret|api[_-]?key|password|passphrase|credential|secret(?:[_-]?value)?|private[_-]?key)/i;

/**
 * A bare or suffixed `token` key (`token`, `id_token`, `session-token`) carries
 * credential material and must be redacted even when its concrete value is not
 * registered (AUDIT-01 HIGH-03). Token *metrics* — `tokens`, `token_count`,
 * `max_tokens`, `prompt_tokens`, `total_tokens` — are observability data, not
 * secrets, so the anchored `(^|[_-])token$` shape deliberately excludes them.
 */
const BARE_TOKEN_KEY = /(^|[_-])token$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || BARE_TOKEN_KEY.test(key);
}

export interface RedactionOptions {
  knownSecrets?: readonly string[];
  replacement?: string;
  maxDepth?: number;
}

export class SecretRedactor {
  readonly #knownSecrets: readonly string[];
  readonly #replacement: string;
  readonly #maxDepth: number;

  public constructor(options: RedactionOptions = {}) {
    this.#knownSecrets = [...(options.knownSecrets ?? [])]
      .filter((secret) => secret.length > 0)
      .sort((a, b) => b.length - a.length);
    this.#replacement = options.replacement ?? REDACTED;
    this.#maxDepth = options.maxDepth ?? 32;
  }

  /**
   * Mask one string: registered literals first, longest-first, then every shape in
   * the shared {@link SECRET_PATTERNS} table.
   *
   * Literals go first so a value the server already knows to be sensitive (a
   * workspace root, an artifact root, a live token) is removed even when it matches
   * no shape at all. Only then do the patterns run, which is what closes `CTF-006`:
   * a redactor constructed with NO `knownSecrets` — as
   * `agent-orchestrator/src/context/compaction.ts` does when building model
   * context — now still masks host paths, `glpat-`, `AKIA`, private keys and JWTs.
   */
  public redactString(value: string): string {
    let redacted = value;
    for (const secret of this.#knownSecrets) {
      redacted = redacted.split(secret).join(this.#replacement);
    }
    return maskSecretShapes(redacted, this.#replacement);
  }

  public redact(value: unknown): unknown {
    return this.#walk(value, 0, new WeakSet<object>());
  }

  public serialize(value: unknown): string {
    return JSON.stringify(this.redact(value));
  }

  #walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (depth > this.#maxDepth) return "[MAX_DEPTH]";
    if (typeof value === "string") return this.redactString(value);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "undefined"
    ) {
      return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
    if (value instanceof Date) return value.toISOString();

    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
      if (value instanceof Error) {
        const out: Record<string, unknown> = {
          name: value.name,
          message: this.redactString(value.message),
        };
        if (value.stack !== undefined) out.stack = this.redactString(value.stack);
        if (value.cause !== undefined) out.cause = this.#walk(value.cause, depth + 1, seen);
        return out;
      }
      if (Array.isArray(value)) {
        return value.map((entry) => this.#walk(entry, depth + 1, seen));
      }
      if (value instanceof Uint8Array) return this.#replacement;

      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        const safeKey = this.redactString(key);
        out[safeKey] = isSensitiveKey(key) ? this.#replacement : this.#walk(entry, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
}

export function redactForLogging(value: unknown, options?: RedactionOptions): unknown {
  return new SecretRedactor(options).redact(value);
}
