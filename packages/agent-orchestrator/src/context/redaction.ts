import { SecretRedactor, containsSecretShape } from "@remoteagent/observability";

import { utf8ByteLength } from "./budget.js";
import type { EngineeringContextAuthority, EngineeringContextSource } from "./types.js";

export const CONTEXT_ARTIFACT_INLINE_BYTES = 32 * 1024;

export class ContextRedactionError extends Error {
  readonly code = "CONTEXT_SENSITIVE_IDENTIFIER" as const;
  constructor(label: string) {
    super(`${label} must be a safe opaque identifier`);
    this.name = "ContextRedactionError";
  }
}

export class ContextOutputBoundary {
  readonly #redactor: SecretRedactor;

  constructor(knownSecrets: readonly string[] = []) {
    this.#redactor = new SecretRedactor({ knownSecrets });
  }

  redactText(value: string): string {
    return this.#redactor.redactString(value);
  }

  assertOpaque(value: string, label: string): string {
    if (
      this.redactText(value) !== value ||
      !/^[A-Za-z][A-Za-z0-9._:-]{0,511}$/.test(value) ||
      value.includes("..")
    ) {
      throw new ContextRedactionError(label);
    }
    return value;
  }

  sanitizeAuthority(authority: EngineeringContextAuthority): void {
    this.assertOpaque(authority.caseId, "caseId");
    this.assertOpaque(authority.ownerId, "ownerId");
    this.assertOpaque(authority.runId, "runId");
    for (const binding of authority.integrationScope) {
      this.assertOpaque(binding.connectionId, "connectionId");
    }
    for (const toolName of authority.toolNames) this.assertOpaque(toolName, "toolName");
  }

  sanitizeSource(source: EngineeringContextSource): EngineeringContextSource {
    this.assertOpaque(source.sourceId, "sourceId");
    this.assertOpaque(source.ref, "ref");
    this.assertOpaque(source.fullArtifactRef, "fullArtifactRef");
    this.assertOpaque(source.binding.caseId, "source caseId");
    this.assertOpaque(source.binding.ownerId, "source ownerId");
    for (const binding of source.binding.integrationScope) {
      this.assertOpaque(binding.connectionId, "source connectionId");
    }
    if (source.connection !== undefined) {
      this.assertOpaque(source.connection.connectionId, "source connectionId");
    }
    if (source.toolName !== undefined) this.assertOpaque(source.toolName, "source toolName");

    const safeContent = this.redactText(source.content);
    return {
      ...source,
      content:
        source.sourceType === "DIFF_EXCERPT" || source.sourceType === "LOG_EXCERPT"
          ? clipArtifact(
              safeContent,
              CONTEXT_ARTIFACT_INLINE_BYTES,
              source.fullArtifactRef,
              source.digest,
            )
          : safeContent,
      freshness: this.redactText(source.freshness),
      inclusionReason: this.redactText(source.inclusionReason),
    };
  }
}

export function clipArtifact(
  redactedContent: string,
  maxBytes: number,
  fullRef: string,
  digest: string,
): string {
  if (
    containsSecretShape(fullRef) ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,511}$/.test(fullRef) ||
    fullRef.includes("..") ||
    !/^sha256:[0-9a-f]{64}$/.test(digest)
  ) {
    throw new ContextRedactionError("artifact marker reference or digest");
  }
  if (utf8ByteLength(redactedContent) <= maxBytes) return redactedContent;
  const marker = `\n[TRUNCATED full_ref=${fullRef} digest=${digest}]`;
  const markerBytes = utf8ByteLength(marker);
  if (markerBytes >= maxBytes) throw new RangeError("Artifact clip budget cannot fit marker");
  const points = Array.from(redactedContent);
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = points.slice(0, middle).join("");
    if (utf8ByteLength(candidate) + markerBytes <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${best}${marker}`;
}
