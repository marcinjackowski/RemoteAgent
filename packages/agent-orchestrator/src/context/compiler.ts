import {
  CURRENT_SCHEMA_VERSION,
  engineeringContextManifest,
  engineeringStage,
  isoTimestamp,
  type EngineeringContextManifest,
} from "@remoteagent/contracts";

import { utf8ByteLength } from "./budget.js";
import { buildContext } from "./builder.js";
import { ContextOutputBoundary } from "./redaction.js";
import {
  assertEngineeringContextSourcePolicy,
  canonicalIntegrationScope,
  engineeringContextRenderKind,
  engineeringContextSourcePolicy,
} from "./source-policy.js";
import type {
  CompiledEngineeringContext,
  ContextFragment,
  EngineeringContextCompileInput,
  EngineeringContextSource,
} from "./types.js";

export class EngineeringContextCompilerError extends Error {
  constructor(
    message: string,
    readonly code: "CONTEXT_STAGE_SOURCE_FORBIDDEN" | "CONTEXT_SOURCE_IDENTITY_VIOLATION",
  ) {
    super(message);
    this.name = "EngineeringContextCompilerError";
  }
}

const externallyScopedKinds = new Set(["entity", "thread_excerpt", "receipt"]);

function toFragment(source: EngineeringContextSource): ContextFragment {
  const kind = engineeringContextRenderKind[source.sourceType];
  const scoped = externallyScopedKinds.has(kind);
  return {
    kind,
    content: source.content,
    provenance: { origin: source.origin, reference: source.sourceId },
    trust: source.trust,
    selection: source.selection,
    ...(scoped
      ? {
          scope: {
            caseId: source.binding.caseId,
            ownerId: source.binding.ownerId,
            ...(source.connection === undefined
              ? {}
              : {
                  provider: source.connection.provider,
                  connectionId: source.connection.connectionId,
                }),
          },
        }
      : {}),
    ...(source.toolName === undefined ? {} : { toolName: source.toolName }),
  };
}

function assertSourceIdentity(source: EngineeringContextSource): void {
  if (source.sourceId.trim().length === 0 || source.sourceId.length > 512) {
    throw new EngineeringContextCompilerError(
      "Context source ID must be a non-empty bounded identifier",
      "CONTEXT_SOURCE_IDENTITY_VIOLATION",
    );
  }
  if (utf8ByteLength(source.content) === 0) {
    throw new EngineeringContextCompilerError(
      "Context source content must not be empty",
      "CONTEXT_SOURCE_IDENTITY_VIOLATION",
    );
  }
  if (
    !isoTimestamp.safeParse(source.observedAt).success ||
    new Date(source.observedAt).toISOString() !== source.observedAt
  ) {
    throw new EngineeringContextCompilerError(
      "Context source timestamp must be canonical UTC ISO-8601",
      "CONTEXT_SOURCE_IDENTITY_VIOLATION",
    );
  }
}

function freezeToolNames(toolNames: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const toolName of toolNames) {
    if (toolName.trim().length === 0 || toolName.length > 512 || unique.has(toolName)) {
      throw new EngineeringContextCompilerError(
        "Tool allowlist must contain unique non-empty bounded identifiers",
        "CONTEXT_SOURCE_IDENTITY_VIOLATION",
      );
    }
    unique.add(toolName);
  }
  return Object.freeze([...unique].sort());
}

/**
 * Compile one fresh stage packet through the existing context selection path.
 * Source content is opaque data: stage, authority and scope come only from
 * server-owned parameters and registry data.
 */
export function compileEngineeringContext(
  input: EngineeringContextCompileInput,
): CompiledEngineeringContext {
  const stage = engineeringStage.parse(input.stage);
  const outputBoundary = new ContextOutputBoundary(input.knownSecrets);
  outputBoundary.sanitizeAuthority(input.authority);
  const safeSources = input.sources.map((source) => outputBoundary.sanitizeSource(source));
  const allowedSourceTypes = engineeringContextSourcePolicy[stage];
  const integrationScope = canonicalIntegrationScope(input.authority.integrationScope);
  const toolNames = freezeToolNames(input.authority.toolNames);
  let latestOwnerSources = 0;

  for (const source of safeSources) {
    assertSourceIdentity(source);
    assertEngineeringContextSourcePolicy(input.authority, source);
    if (!allowedSourceTypes.includes(source.sourceType)) {
      throw new EngineeringContextCompilerError(
        `Context source type is not allowed for stage ${stage}`,
        "CONTEXT_STAGE_SOURCE_FORBIDDEN",
      );
    }
    if (source.selection.class === "LATEST_OWNER" && ++latestOwnerSources > 1) {
      throw new EngineeringContextCompilerError(
        "Context may contain at most one latest-owner steering source",
        "CONTEXT_SOURCE_IDENTITY_VIOLATION",
      );
    }
  }

  const context = buildContext({
    scope: {
      caseId: input.authority.caseId,
      ownerId: input.authority.ownerId,
      connections: integrationScope,
      toolNames,
    },
    budgetBytes: input.budgetBytes,
    fragments: safeSources.map(toFragment),
  });
  const sourcesById = new Map(safeSources.map((source) => [source.sourceId, source]));
  const manifestSources = context.fragments.map(({ fragment, bytes }) => {
    const source = sourcesById.get(fragment.provenance.reference);
    if (source === undefined) {
      throw new EngineeringContextCompilerError(
        "Selected context has no durable source descriptor",
        "CONTEXT_SOURCE_IDENTITY_VIOLATION",
      );
    }
    return {
      source_id: source.sourceId,
      kind: source.layer,
      ref: source.ref,
      revision: source.revision,
      observed_at: source.observedAt,
      digest: source.digest,
      trust: source.trust,
      freshness: source.freshness,
      inclusion_reason: source.inclusionReason,
      byte_budget: bytes,
      full_artifact_ref: source.fullArtifactRef,
    };
  });
  const manifest: EngineeringContextManifest = engineeringContextManifest.parse({
    schema_version: CURRENT_SCHEMA_VERSION,
    artifact_kind: "ContextManifest",
    case_id: input.authority.caseId,
    run_id: input.authority.runId,
    revision: input.authority.checkpointRevision,
    authority: "SERVER_OWNED",
    sources: manifestSources,
    total_byte_budget: input.budgetBytes,
  });

  return {
    stage,
    authority: Object.freeze({
      kind: "SERVER_OWNED",
      caseId: input.authority.caseId,
      ownerId: input.authority.ownerId,
      runId: input.authority.runId,
      checkpointRevision: input.authority.checkpointRevision,
      integrationScope,
      toolNames,
    }),
    manifest,
    context,
  };
}
