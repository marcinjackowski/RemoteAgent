import {
  canonicalDigest,
  canonicalJsonStringify,
  caseCheckpoint,
  engineeringArtifact,
  engineeringArtifactDigest,
  idString,
  integrationScope,
  providerSchema,
  TrustLevel,
  type CaseCheckpoint,
  type Provider,
} from "@remoteagent/contracts";
import * as z from "zod";

import type { QueryResultRow, Transaction } from "../client.js";

export type EngineeringContextSnapshotSourceType =
  | "WORK_UNIT_OBJECTIVE"
  | "CASE_MESSAGE"
  | "ISSUE_CONTEXT"
  | "CASE_CHECKPOINT"
  | "MEMORY_UPDATE"
  | "OUTCOME_CONTRACT"
  | "SYSTEM_DESIGN"
  | "PROGRAM_DESIGN"
  | "DESIGN_DECISION"
  | "SLICE_CONTRACT"
  | "EVIDENCE_BUNDLE"
  | "REVIEW_DECISION"
  | "VERIFICATION_DECISION";

export type EngineeringContextSnapshotLayer =
  "RAW_EVIDENCE" | "DURABLE_KNOWLEDGE" | "WORKING_PROJECTION";

export type EngineeringContextSelectionClass =
  "MANDATORY" | "LATEST_OWNER" | "LEXICAL_RELEVANCE" | "PRIORITY" | "RECENCY";

export interface EngineeringContextBindingSnapshot {
  readonly caseId: string;
  readonly ownerId: string;
  readonly integrationScope: readonly {
    readonly provider: Provider;
    readonly connectionId: string;
  }[];
}

export interface EngineeringContextSourceSnapshot {
  readonly sourceId: string;
  readonly sourceType: EngineeringContextSnapshotSourceType;
  readonly layer: EngineeringContextSnapshotLayer;
  readonly content: string;
  readonly origin: "system" | "provider" | "external" | "model";
  readonly trust: typeof TrustLevel.TRUSTED | typeof TrustLevel.UNTRUSTED_DATA;
  readonly ref: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly digest: string;
  readonly freshness: string;
  readonly inclusionReason: string;
  readonly fullArtifactRef: string;
  readonly selection: {
    readonly class: EngineeringContextSelectionClass;
    readonly observedAt: string;
  };
  readonly binding: EngineeringContextBindingSnapshot;
  readonly connection?: {
    readonly provider: Provider;
    readonly connectionId: string;
  };
}

export interface EngineeringContextSnapshot {
  readonly snapshotDigest: string;
  readonly authority: EngineeringContextBindingSnapshot & {
    readonly runId: string;
    readonly workUnitId: string;
    readonly checkpointRevision: number;
    readonly objective: string;
    readonly runCreatedAt: string;
  };
  readonly sources: readonly EngineeringContextSourceSnapshot[];
}

export interface EngineeringContextSnapshotDatabase {
  withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

export class EngineeringContextSnapshotError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "ENGINEERING_CONTEXT_INPUT_INVALID"
      | "ENGINEERING_CONTEXT_SCOPE_MISMATCH"
      | "ENGINEERING_CONTEXT_DATA_INVALID",
  ) {
    super(message);
    this.name = "EngineeringContextSnapshotError";
  }
}

const inputSchema = z.strictObject({
  caseId: idString,
  runId: idString,
  workUnitId: idString,
  recentScanBytes: z
    .int()
    .positive()
    .max(4 * 1024 * 1024),
  relevantScanBytes: z
    .int()
    .positive()
    .max(4 * 1024 * 1024),
});

interface AuthorityRow extends QueryResultRow {
  readonly run_id: string;
  readonly case_id: string;
  readonly owner_id: string;
  readonly work_unit_id: string;
  readonly checkpoint_revision: number;
  readonly run_created_at: Date;
  readonly objective: string;
  readonly work_unit_schema_version: number;
  readonly work_unit_created_at: Date;
  readonly integration_scope: unknown;
  readonly checkpoint: unknown;
  readonly checkpoint_created_at: Date;
}

interface ConnectionRow extends QueryResultRow {
  readonly provider: string;
  readonly connection_id: string;
}

interface MessageRow extends QueryResultRow {
  readonly message_id: string;
  readonly role: string;
  readonly body: string;
  readonly created_at: Date;
}

interface IssueRow extends QueryResultRow {
  readonly event_id: string;
  readonly provider: string;
  readonly connection_id: string;
  readonly issue_key: string;
  readonly entity_id: string;
  readonly external_id: string;
  readonly canonical_digest: string;
  readonly issue_body: unknown;
  readonly created_at: Date;
}

interface ArtifactRow extends QueryResultRow {
  readonly artifact_revision_id: string;
  readonly artifact_key: string;
  readonly revision: number;
  readonly artifact_kind: string;
  readonly payload: unknown;
  readonly payload_digest: string;
  readonly recorded_at: Date;
}

const artifactSourceType = Object.freeze({
  OutcomeContract: "OUTCOME_CONTRACT",
  SystemDesign: "SYSTEM_DESIGN",
  ProgramDesign: "PROGRAM_DESIGN",
  DesignDecision: "DESIGN_DECISION",
  SliceContract: "SLICE_CONTRACT",
  EvidenceBundle: "EVIDENCE_BUNDLE",
  ReviewDecision: "REVIEW_DECISION",
  VerificationDecision: "VERIFICATION_DECISION",
  MemoryUpdate: "MEMORY_UPDATE",
} as const);

const artifactLayer: Readonly<
  Record<keyof typeof artifactSourceType, EngineeringContextSnapshotLayer>
> = Object.freeze({
  OutcomeContract: "DURABLE_KNOWLEDGE",
  SystemDesign: "DURABLE_KNOWLEDGE",
  ProgramDesign: "DURABLE_KNOWLEDGE",
  DesignDecision: "DURABLE_KNOWLEDGE",
  SliceContract: "DURABLE_KNOWLEDGE",
  EvidenceBundle: "RAW_EVIDENCE",
  ReviewDecision: "DURABLE_KNOWLEDGE",
  VerificationDecision: "DURABLE_KNOWLEDGE",
  MemoryUpdate: "WORKING_PROJECTION",
});

function dataError(): never {
  throw new EngineeringContextSnapshotError(
    "Persisted engineering context is internally inconsistent",
    "ENGINEERING_CONTEXT_DATA_INVALID",
  );
}

function freezeBinding(
  caseId: string,
  ownerId: string,
  scope: readonly { provider: Provider; connectionId: string }[],
): EngineeringContextBindingSnapshot {
  return Object.freeze({
    caseId,
    ownerId,
    integrationScope: Object.freeze(
      scope.map((entry) =>
        Object.freeze({ provider: entry.provider, connectionId: entry.connectionId }),
      ),
    ),
  });
}

function relevanceTerms(objective: string, checkpoint: CaseCheckpoint): readonly string[] {
  const terms = new Set<string>();
  const durableInputs = [objective, ...checkpoint.open_questions];
  for (const input of durableInputs) {
    for (const match of input.toLowerCase().matchAll(/[\p{L}\p{N}_]{3,64}/gu)) {
      terms.add(match[0]);
      if (terms.size === 64) return Object.freeze([...terms]);
    }
  }
  return Object.freeze([...terms]);
}

function source(
  value: EngineeringContextSourceSnapshot,
): Readonly<EngineeringContextSourceSnapshot> {
  return Object.freeze({
    ...value,
    selection: Object.freeze({ ...value.selection }),
  });
}

function messageSource(
  row: MessageRow,
  binding: EngineeringContextBindingSnapshot,
  selectionClass: Extract<
    EngineeringContextSelectionClass,
    "LATEST_OWNER" | "LEXICAL_RELEVANCE" | "RECENCY"
  >,
): EngineeringContextSourceSnapshot {
  const contentValue = {
    body: row.body,
    created_at: row.created_at.toISOString(),
    role: row.role,
  };
  const ref = `case-message:${row.message_id}`;
  return source({
    sourceId: ref,
    sourceType: "CASE_MESSAGE",
    layer: "RAW_EVIDENCE",
    content: canonicalJsonStringify(contentValue),
    origin: "external",
    trust: TrustLevel.UNTRUSTED_DATA,
    ref,
    revision: 0,
    observedAt: row.created_at.toISOString(),
    digest: canonicalDigest(contentValue),
    freshness: "created no later than the pinned run cutoff",
    inclusionReason: "bounded recent or durable-objective lexical lane",
    fullArtifactRef: ref,
    selection: { class: selectionClass, observedAt: row.created_at.toISOString() },
    binding,
  });
}

function compareMessageRows(left: MessageRow, right: MessageRow): number {
  const byTime = left.created_at.getTime() - right.created_at.getTime();
  if (byTime !== 0) return byTime;
  if (left.message_id < right.message_id) return -1;
  if (left.message_id > right.message_id) return 1;
  return 0;
}

/** Reads a fresh, authority-pinned source snapshot without accepting scope from callers. */
export class EngineeringContextRepository {
  public async readSnapshot(
    db: EngineeringContextSnapshotDatabase,
    rawInput: unknown,
  ): Promise<EngineeringContextSnapshot> {
    const parsed = inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new EngineeringContextSnapshotError(
        "Invalid engineering context snapshot request",
        "ENGINEERING_CONTEXT_INPUT_INVALID",
      );
    }

    return db.withTransaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const authorityResult = await tx.query<AuthorityRow>(
        `SELECT r.run_id, r.case_id, r.owner_id, r.work_unit_id, r.checkpoint_revision,
                r.created_at AS run_created_at, w.objective,
                w.schema_version AS work_unit_schema_version,
                w.created_at AS work_unit_created_at, c.integration_scope,
                cp.checkpoint, cp.created_at AS checkpoint_created_at
           FROM agent_runs r
           JOIN work_units w
             ON w.run_id = r.run_id
            AND w.work_unit_id = r.work_unit_id
            AND w.case_id = r.case_id
           JOIN cases c
             ON c.case_id = r.case_id
            AND c.owner_id = r.owner_id
           JOIN case_checkpoints cp
             ON cp.case_id = r.case_id
            AND cp.owner_id = r.owner_id
            AND cp.revision = r.checkpoint_revision
          WHERE r.case_id = $1 AND r.run_id = $2 AND w.work_unit_id = $3`,
        [parsed.data.caseId, parsed.data.runId, parsed.data.workUnitId],
      );
      const authority = authorityResult.rows[0];
      if (!authority) {
        throw new EngineeringContextSnapshotError(
          "Engineering context binding does not exist",
          "ENGINEERING_CONTEXT_SCOPE_MISMATCH",
        );
      }

      const checkpointResult = caseCheckpoint.safeParse(authority.checkpoint);
      const scopeResult = integrationScope.safeParse(authority.integration_scope);
      if (
        !checkpointResult.success ||
        !scopeResult.success ||
        checkpointResult.data.case_id !== authority.case_id ||
        checkpointResult.data.revision !== authority.checkpoint_revision
      ) {
        dataError();
      }

      const connectionResult = await tx.query<ConnectionRow>(
        `SELECT cc.provider, cc.connection_id
           FROM case_connections cc
           JOIN connections con
             ON con.connection_id = cc.connection_id
            AND con.owner_id = cc.owner_id
            AND con.provider = cc.provider
          WHERE cc.case_id = $1 AND cc.owner_id = $2
          ORDER BY cc.provider ASC, cc.connection_id ASC`,
        [authority.case_id, authority.owner_id],
      );
      const connections = connectionResult.rows.map((row) => {
        const provider = providerSchema.safeParse(row.provider);
        if (!provider.success) dataError();
        return { provider: provider.data, connectionId: row.connection_id };
      });
      const scopeConnectionIds = [...scopeResult.data.connection_ids].sort();
      const normalizedConnectionIds = connections.map(({ connectionId }) => connectionId).sort();
      const scopeProviders = [...new Set(scopeResult.data.providers)].sort();
      const normalizedProviders = [...new Set(connections.map(({ provider }) => provider))].sort();
      if (
        scopeConnectionIds.length !== normalizedConnectionIds.length ||
        scopeConnectionIds.some((id, index) => id !== normalizedConnectionIds[index]) ||
        scopeProviders.length !== normalizedProviders.length ||
        scopeProviders.some((provider, index) => provider !== normalizedProviders[index])
      ) {
        dataError();
      }

      const binding = freezeBinding(authority.case_id, authority.owner_id, connections);
      const sources: EngineeringContextSourceSnapshot[] = [];
      const objectiveRef = `work-unit:${authority.work_unit_id}:objective`;
      sources.push(
        source({
          sourceId: objectiveRef,
          sourceType: "WORK_UNIT_OBJECTIVE",
          layer: "DURABLE_KNOWLEDGE",
          content: authority.objective,
          origin: "system",
          trust: TrustLevel.TRUSTED,
          ref: objectiveRef,
          revision: authority.work_unit_schema_version,
          observedAt: authority.work_unit_created_at.toISOString(),
          digest: canonicalDigest({ objective: authority.objective }),
          freshness: "bound to the exact durable work unit",
          inclusionReason: "mandatory task objective",
          fullArtifactRef: objectiveRef,
          selection: {
            class: "MANDATORY",
            observedAt: authority.work_unit_created_at.toISOString(),
          },
          binding,
        }),
      );
      const checkpointRef = `case-checkpoint:${authority.case_id}:${authority.checkpoint_revision}`;
      sources.push(
        source({
          sourceId: checkpointRef,
          sourceType: "CASE_CHECKPOINT",
          layer: "WORKING_PROJECTION",
          content: canonicalJsonStringify(checkpointResult.data),
          origin: "model",
          trust: TrustLevel.UNTRUSTED_DATA,
          ref: checkpointRef,
          revision: authority.checkpoint_revision,
          observedAt: authority.checkpoint_created_at.toISOString(),
          digest: canonicalDigest(checkpointResult.data),
          freshness: "pinned by agent_runs.checkpoint_revision",
          inclusionReason: "mandatory working projection",
          fullArtifactRef: checkpointRef,
          selection: {
            class: "MANDATORY",
            observedAt: authority.checkpoint_created_at.toISOString(),
          },
          binding,
        }),
      );

      const issues = await tx.query<IssueRow>(
        `SELECT DISTINCT ON (j.entity_id)
                j.event_id, j.provider, j.connection_id, j.issue_key, j.entity_id,
                e.external_id, j.canonical_digest,
                o.payload ->> 'body' AS issue_body, j.created_at
           FROM jira_projection_receipts j
           JOIN external_entities e
             ON e.entity_id = j.entity_id
            AND e.case_id = j.case_id
            AND e.owner_id = j.owner_id
            AND e.connection_id = j.connection_id
            AND e.provider = j.provider
            AND e.kind = j.kind
            AND e.external_id = j.issue_key
           JOIN outbox o
             ON o.outbox_id = j.outbox_id
            AND o.aggregate_id = j.case_id
            AND o.created_at <= $3
           JOIN case_connections cc
             ON cc.case_id = j.case_id
            AND cc.owner_id = j.owner_id
            AND cc.connection_id = j.connection_id
            AND cc.provider = j.provider
          WHERE j.case_id = $1 AND j.owner_id = $2 AND j.created_at <= $3
          ORDER BY j.entity_id ASC, j.created_at DESC, j.event_id DESC`,
        [authority.case_id, authority.owner_id, authority.run_created_at],
      );
      for (const row of issues.rows) {
        const provider = providerSchema.safeParse(row.provider);
        const issueBody = z
          .string()
          .max(1024 * 1024)
          .safeParse(row.issue_body);
        if (!provider.success || !issueBody.success) dataError();
        const contentValue = {
          body: issueBody.data,
          entity_id: row.entity_id,
          external_id: row.external_id,
          issue_key: row.issue_key,
        };
        const ref = `jira-receipt:${row.event_id}`;
        sources.push(
          source({
            sourceId: ref,
            sourceType: "ISSUE_CONTEXT",
            layer: "RAW_EVIDENCE",
            content: canonicalJsonStringify(contentValue),
            origin: "provider",
            trust: TrustLevel.UNTRUSTED_DATA,
            ref,
            revision: 0,
            observedAt: row.created_at.toISOString(),
            digest: row.canonical_digest,
            freshness: "latest durable provider receipt before the run cutoff",
            inclusionReason: "exact case connection receipt",
            fullArtifactRef: ref,
            selection: { class: "PRIORITY", observedAt: row.created_at.toISOString() },
            binding,
            connection: Object.freeze({
              provider: provider.data,
              connectionId: row.connection_id,
            }),
          }),
        );
      }

      const artifacts = await tx.query<ArtifactRow>(
        `SELECT ar.artifact_revision_id, ar.artifact_key, ar.revision,
                ar.artifact_kind, ar.payload, ar.payload_digest, ar.recorded_at
           FROM engineering_artifact_revisions ar
           JOIN engineering_operations op
             ON op.operation_id = ar.operation_id
            AND op.intent_id = ar.intent_id
            AND op.job_id = ar.job_id
            AND op.case_id = ar.case_id
            AND op.owner_id = ar.owner_id
            AND op.run_id = ar.run_id
            AND op.stage = ar.stage
            AND op.stage_attempt = ar.stage_attempt
            AND op.checkpoint_revision = ar.checkpoint_revision
          WHERE ar.case_id = $1 AND ar.owner_id = $2 AND ar.run_id = $3
          ORDER BY ar.recorded_at ASC, ar.artifact_revision_id ASC`,
        [authority.case_id, authority.owner_id, authority.run_id],
      );
      for (const row of artifacts.rows) {
        const parsedArtifact = engineeringArtifact.safeParse(row.payload);
        if (!parsedArtifact.success || !(row.artifact_kind in artifactSourceType)) dataError();
        const kind = row.artifact_kind as keyof typeof artifactSourceType;
        if (
          parsedArtifact.data.artifact_kind !== row.artifact_kind ||
          parsedArtifact.data.case_id !== authority.case_id ||
          parsedArtifact.data.run_id !== authority.run_id ||
          parsedArtifact.data.revision !== row.revision ||
          engineeringArtifactDigest(parsedArtifact.data) !== row.payload_digest
        ) {
          dataError();
        }
        const ref = `engineering-artifact:${row.artifact_revision_id}`;
        sources.push(
          source({
            sourceId: ref,
            sourceType: artifactSourceType[kind],
            layer: artifactLayer[kind],
            content: canonicalJsonStringify(parsedArtifact.data),
            origin: "model",
            trust: TrustLevel.UNTRUSTED_DATA,
            ref,
            revision: row.revision,
            observedAt: row.recorded_at.toISOString(),
            digest: row.payload_digest,
            freshness: "exact durable revision for the current run",
            inclusionReason: "validated engineering artifact",
            fullArtifactRef: ref,
            selection: { class: "PRIORITY", observedAt: row.recorded_at.toISOString() },
            binding,
          }),
        );
      }

      const messageProjection = `message_id, role, body, created_at`;
      const recent = await tx.query<MessageRow>(
        `WITH measured AS (
           SELECT ${messageProjection},
                  octet_length(jsonb_build_object(
                    'body', body,
                    'created_at', created_at,
                    'role', role
                  )::text) AS source_bytes
             FROM case_messages
            WHERE case_id = $1 AND created_at <= $2
         ), accumulated AS (
           SELECT measured.*,
                  sum(source_bytes) OVER (
                    ORDER BY created_at DESC, message_id COLLATE "C" DESC
                  ) AS cumulative_bytes
             FROM measured
         )
         SELECT ${messageProjection}
           FROM accumulated
          WHERE cumulative_bytes <= $3
          ORDER BY created_at DESC, message_id COLLATE "C" DESC`,
        [authority.case_id, authority.run_created_at, parsed.data.recentScanBytes],
      );

      const latestOwner = await tx.query<MessageRow>(
        `SELECT ${messageProjection}
           FROM case_messages
          WHERE case_id = $1 AND role = 'OWNER' AND created_at <= $2
          ORDER BY created_at DESC, message_id COLLATE "C" DESC
          LIMIT 1`,
        [authority.case_id, authority.run_created_at],
      );

      const terms = relevanceTerms(authority.objective, checkpointResult.data);
      let relevantRows: MessageRow[] = [];
      if (terms.length > 0) {
        const relevant = await tx.query<MessageRow>(
          `WITH query AS (
             SELECT to_tsquery('simple', $3) AS value
           ), measured AS (
             SELECT ${messageProjection},
                    ts_rank_cd(to_tsvector('simple', body), query.value) AS relevance,
                    octet_length(jsonb_build_object(
                      'body', body,
                      'created_at', created_at,
                      'role', role
                    )::text) AS source_bytes
               FROM case_messages, query
              WHERE case_id = $1
                AND created_at <= $2
                AND to_tsvector('simple', body) @@ query.value
           ), accumulated AS (
             SELECT measured.*,
                    sum(source_bytes) OVER (
                      ORDER BY relevance DESC, created_at DESC, message_id COLLATE "C" DESC
                    ) AS cumulative_bytes
               FROM measured
           )
           SELECT ${messageProjection}
             FROM accumulated
            WHERE cumulative_bytes <= $4
            ORDER BY relevance DESC, created_at DESC, message_id COLLATE "C" DESC`,
          [
            authority.case_id,
            authority.run_created_at,
            terms.map((term) => `${term}:*`).join(" | "),
            parsed.data.relevantScanBytes,
          ],
        );
        relevantRows = relevant.rows;
      }

      const selectedMessages = new Map<
        string,
        {
          readonly row: MessageRow;
          readonly selectionClass: Extract<
            EngineeringContextSelectionClass,
            "LATEST_OWNER" | "LEXICAL_RELEVANCE" | "RECENCY"
          >;
        }
      >();
      for (const row of recent.rows) {
        selectedMessages.set(row.message_id, { row, selectionClass: "RECENCY" });
      }
      for (const row of relevantRows) {
        selectedMessages.set(row.message_id, { row, selectionClass: "LEXICAL_RELEVANCE" });
      }
      for (const row of latestOwner.rows) {
        selectedMessages.set(row.message_id, { row, selectionClass: "LATEST_OWNER" });
      }
      for (const selected of [...selectedMessages.values()].sort((left, right) =>
        compareMessageRows(left.row, right.row),
      )) {
        sources.push(messageSource(selected.row, binding, selected.selectionClass));
      }

      const snapshotAuthority = Object.freeze({
        ...binding,
        runId: authority.run_id,
        workUnitId: authority.work_unit_id,
        checkpointRevision: authority.checkpoint_revision,
        objective: authority.objective,
        runCreatedAt: authority.run_created_at.toISOString(),
      });
      return Object.freeze({
        snapshotDigest: canonicalDigest({
          authority: snapshotAuthority,
          sources: sources.map(({ sourceId, digest, revision, observedAt, selection }) => ({
            sourceId,
            digest,
            revision,
            observedAt,
            selection,
          })),
        }),
        authority: snapshotAuthority,
        sources: Object.freeze(sources),
      });
    });
  }
}
