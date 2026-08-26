/** Code-owned cross-fence engineering recovery queue (RA-047). */
import {
  canonicalDigest,
  engineeringArtifact,
  engineeringArtifactDigest,
  engineeringRecoveryPlanV1,
  engineeringRecoveryPlanV1Digest,
  isEngineeringArtifactKindAllowedForStage,
} from "@remoteagent/contracts";
import type { EngineeringArtifact, EngineeringRecoveryPlanV1 } from "@remoteagent/contracts";
import * as z from "zod";

import type { Database, Queryable, Transaction } from "../client.js";
import { ContractViolationError, EngineeringControlStateError } from "../errors.js";
import { JobType } from "../queue/dispatch.js";
import type { JobLease, JobRow } from "../queue/job-store.js";
import { leaseTimeSql, type LeaseTimeSql } from "../queue/lease-time.js";
import type { Clock, IdGenerator, LeaseTimeMode } from "../queue/runtime.js";
import type {
  EngineeringControlArtifactRevisionRow,
  EngineeringControlOperationRow,
} from "./engineering-control-plane.js";

const CLAIM_ADVISORY_LOCK_KEY = 0x52_41_30_30_34n;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const identifier = z.string().trim().min(1).max(512);
const repairStageInput = z
  .strictObject({
    planDigest: digest,
    operationId: identifier,
    artifactKey: z.string().trim().min(1).max(512),
    artifact: z.unknown(),
  })
  .readonly();
const repairObservationInput = z
  .strictObject({
    planDigest: digest,
    operationId: identifier,
    completionId: identifier,
  })
  .readonly();

export const engineeringRecoveryJobPayload = z
  .strictObject({
    reason: z.literal("engineering_recovery"),
    recoveryId: identifier,
    sourceJobId: identifier,
    sourceFencingToken: z.number().int().positive(),
    caseId: identifier,
    workUnitId: identifier,
    runId: identifier,
    checkpointRevision: z.number().int().nonnegative(),
  })
  .readonly();

export type EngineeringRecoveryJobPayload = z.infer<typeof engineeringRecoveryJobPayload>;

export interface EngineeringRecoveryRow {
  readonly schema_version: 1;
  readonly recovery_id: string;
  readonly root_recovery_id: string;
  readonly parent_recovery_id: string | null;
  readonly source_job_id: string;
  readonly source_fencing_token: string;
  readonly recovery_job_id: string;
  readonly proposal_id: string;
  readonly approval_id: string;
  readonly case_id: string;
  readonly owner_id: string;
  readonly work_unit_id: string;
  readonly run_id: string;
  readonly checkpoint_revision: number;
  readonly repository_id: string;
  readonly source_payload_digest: string;
  readonly workflow_deadline_at: Date;
  readonly source_operation_id: string | null;
  readonly source_intent_id: string | null;
  readonly source_stage: string | null;
  readonly source_stage_attempt: number | null;
  readonly source_effect_class:
    "READ_ONLY" | "MODEL_CALL" | "COMMAND" | "MUTATING_SIDE_EFFECT" | null;
  readonly source_input_digest: string | null;
  readonly source_config_digest: string | null;
  readonly source_schema_digest: string | null;
  readonly source_scope_digest: string | null;
  readonly source_deadline_at: Date | null;
  readonly status:
    "PENDING" | "LEASED" | "RECOVERY_PENDING" | "CONTINUED" | "AMBIGUOUS" | "BLOCKED" | "CANCELLED";
  readonly last_recovery_fencing_token: string;
  readonly continuation_fencing_token: string | null;
  readonly plan: EngineeringRecoveryPlanV1 | null;
  readonly plan_digest: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface EngineeringRecoveryLease {
  readonly recovery: EngineeringRecoveryRow;
  readonly job: JobLease;
}

export interface EngineeringContinuationLease {
  readonly recovery: EngineeringRecoveryRow;
  readonly job: JobLease;
}

export interface EngineeringRecoveryMaterialization {
  readonly recoveries: readonly EngineeringRecoveryRow[];
  readonly succeededSourceJobIds: readonly string[];
}

export interface EngineeringRecoveryRepairResult {
  readonly artifact: EngineeringControlArtifactRevisionRow;
  readonly completionId: string;
  readonly completionObserved: true;
}

export type EngineeringRecoveryTerminalStatus = "AMBIGUOUS" | "BLOCKED" | "CANCELLED";

const JOB_COLUMNS = `
  job_id, case_id, job_type, status, payload, provider, serialization_key,
  lease_owner, lease_expires_at, fencing_token, attempts, max_attempts,
  backoff_base_ms, backoff_cap_ms, available_at, leased_at, last_heartbeat_at,
  last_error, dead_lettered_at, dlq_reason, finished_at, created_at, updated_at`;
const JOB_COLUMNS_J = JOB_COLUMNS.replace(/(\w+)/g, "j.$1");

function asLease(row: JobRow, owner: string, nowMs: number, leaseMs: number): JobLease {
  return {
    jobId: row.job_id,
    caseId: row.case_id,
    jobType: row.job_type,
    payload: row.payload,
    provider: row.provider,
    serializationKey: row.serialization_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAtMs: row.lease_expires_at?.getTime() ?? nowMs + leaseMs,
    leaseOwner: owner,
  };
}

function parsePlanDigest(value: unknown): string {
  const parsed = digest.safeParse(value);
  if (!parsed.success) throw new ContractViolationError("invalid engineering recovery plan digest");
  return parsed.data;
}

export class EngineeringRecoveryRepository {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #lt: LeaseTimeSql;

  public constructor(runtime: { clock: Clock; ids: IdGenerator; leaseTime?: LeaseTimeMode }) {
    this.#clock = runtime.clock;
    this.#ids = runtime.ids;
    this.#lt = leaseTimeSql(runtime.leaseTime ?? "db");
  }

  /**
   * Park expired, exact RA-046 writer jobs before generic reap. A durable outer
   * run completion reconstructs queue success; every unfinished run gets exactly
   * one case-less recovery job for the expired source fence.
   */
  public async materializeExpired(
    db: Database,
    input: { readonly workflowDeadlineMs: number; readonly limit?: number },
  ): Promise<EngineeringRecoveryMaterialization> {
    if (!Number.isSafeInteger(input.workflowDeadlineMs) || input.workflowDeadlineMs < 1) {
      throw new RangeError("workflowDeadlineMs must be a positive safe integer");
    }
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be positive");
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const sources = await tx.query<
        JobRow & {
          proposal_id: string;
          approval_id: string;
          owner_id: string;
          work_unit_id: string;
          run_id: string;
          checkpoint_revision: number;
          repository_id: string;
          run_created_at: Date;
          completion_id: string | null;
          operation_id: string | null;
          intent_id: string | null;
          stage: string | null;
          stage_attempt: number | null;
          effect_class: EngineeringRecoveryRow["source_effect_class"];
          input_digest: string | null;
          config_digest: string | null;
          schema_digest: string | null;
          integration_scope_digest: string | null;
          deadline_at: Date | null;
        }
      >(
        `SELECT ${JOB_COLUMNS_J},
                p.proposal_id, p.approval_id, p.owner_id, p.work_unit_id, p.run_id,
                p.checkpoint_revision, p.repository_id, r.created_at AS run_created_at,
                rc.completion_id,
                latest.operation_id, latest.intent_id, latest.stage, latest.stage_attempt,
                latest.effect_class, latest.input_digest, latest.config_digest,
                latest.schema_digest, latest.integration_scope_digest, latest.deadline_at
           FROM jobs j
           JOIN engineering_write_proposals p
             ON p.job_id=j.job_id AND p.case_id=j.case_id AND p.status='GRANTED'
           JOIN work_units w
             ON w.work_unit_id=p.work_unit_id AND w.case_id=p.case_id AND w.run_id=p.run_id
           JOIN agent_runs r
             ON r.run_id=p.run_id AND r.work_unit_id=p.work_unit_id
            AND r.case_id=p.case_id AND r.owner_id=p.owner_id
            AND r.checkpoint_revision=p.checkpoint_revision
           LEFT JOIN run_completions rc
             ON rc.run_id=p.run_id AND rc.case_id=p.case_id
           LEFT JOIN LATERAL (
             SELECT o.operation_id, o.intent_id, o.stage, o.stage_attempt, o.effect_class,
                    o.input_digest, o.config_digest, o.schema_digest,
                    o.integration_scope_digest, o.deadline_at
              FROM engineering_operations o
              JOIN job_intents i
                ON i.intent_id=o.intent_id AND i.job_id=o.job_id
               AND i.fencing_token=j.fencing_token
              WHERE o.job_id=j.job_id AND o.run_id=p.run_id
                AND o.operation_kind LIKE 'engineering.stage.%'
              ORDER BY o.recorded_at DESC, o.operation_id DESC
              LIMIT 1
           ) latest ON true
          WHERE j.status='LEASED' AND j.job_type=$2
            AND j.payload->>'reason'='engineering_approval'
            AND j.lease_expires_at <= ${this.#lt.now(1)}
            AND NOT EXISTS (
              SELECT 1 FROM engineering_recoveries existing
               WHERE existing.source_job_id=j.job_id
                 AND existing.source_fencing_token=j.fencing_token)
          ORDER BY j.lease_expires_at, j.job_id
          FOR UPDATE OF j SKIP LOCKED
          LIMIT $3`,
        [nowMs, JobType.AGENT_IMPLEMENTER, limit],
      );

      const recoveries: EngineeringRecoveryRow[] = [];
      const succeededSourceJobIds: string[] = [];
      for (const row of sources.rows) {
        this.#assertSourcePayload(row, {
          caseId: row.case_id,
          workUnitId: row.work_unit_id,
          runId: row.run_id,
          checkpointRevision: row.checkpoint_revision,
          repoId: row.repository_id,
          approvalId: row.approval_id,
          proposalId: row.proposal_id,
        });
        await this.#recordSourceAttempt(
          tx,
          row,
          row.completion_id === null ? "LEASE_LOST" : "SUCCEEDED",
          nowMs,
        );
        if (row.completion_id !== null) {
          const completed = await tx.query(
            `UPDATE jobs SET status='SUCCEEDED', lease_owner=NULL, lease_expires_at=NULL,
                             finished_at=to_timestamp($2/1000.0), last_error=NULL
              WHERE job_id=$1 AND status='LEASED' AND fencing_token=$3`,
            [row.job_id, nowMs, row.fencing_token],
          );
          if (completed.rowCount !== 1) {
            throw new EngineeringControlStateError("completed source reconstruction raced");
          }
          succeededSourceJobIds.push(row.job_id);
          continue;
        }

        const parked = await tx.query(
          `UPDATE jobs SET status='RECONCILING', lease_owner=NULL, lease_expires_at=NULL,
                           last_error='engineering lease expired before exact outer run completion'
            WHERE job_id=$1 AND status='LEASED' AND fencing_token=$2`,
          [row.job_id, row.fencing_token],
        );
        if (parked.rowCount !== 1) throw new EngineeringControlStateError("source park raced");

        const previous = await tx.query<{
          recovery_id: string;
          root_recovery_id: string;
        }>(
          `SELECT recovery_id,root_recovery_id FROM engineering_recoveries
            WHERE source_job_id=$1 ORDER BY created_at DESC,recovery_id DESC LIMIT 1`,
          [row.job_id],
        );
        const recoveryId = this.#ids.next("eng-recovery");
        const recoveryJobId = this.#ids.next("job");
        const recoveryPayload: EngineeringRecoveryJobPayload = {
          reason: "engineering_recovery",
          recoveryId,
          sourceJobId: row.job_id,
          sourceFencingToken: Number(row.fencing_token),
          caseId: row.case_id!,
          workUnitId: row.work_unit_id,
          runId: row.run_id,
          checkpointRevision: row.checkpoint_revision,
        };
        await tx.query(
          `INSERT INTO jobs (
             job_id,case_id,job_type,status,payload,provider,serialization_key,
             attempts,max_attempts,backoff_base_ms,backoff_cap_ms,available_at,
             created_at,updated_at)
           VALUES ($1,NULL,$2,'PENDING',$3::jsonb,NULL,$4,0,10,1000,3600000,
                   ${this.#lt.scheduleBase(5)},to_timestamp($5/1000.0),to_timestamp($5/1000.0))`,
          [
            recoveryJobId,
            JobType.AGENT_ENGINEERING_RECOVERY,
            JSON.stringify(recoveryPayload),
            `engineering-recovery:${recoveryId}`,
            nowMs,
          ],
        );
        const workflowDeadline =
          row.deadline_at ?? new Date(row.run_created_at.getTime() + input.workflowDeadlineMs);
        const parent = previous.rows[0] ?? null;
        const inserted = await tx.query<EngineeringRecoveryRow>(
          `INSERT INTO engineering_recoveries (
             recovery_id,root_recovery_id,parent_recovery_id,
             source_job_id,source_fencing_token,recovery_job_id,
             proposal_id,approval_id,case_id,owner_id,work_unit_id,run_id,
             checkpoint_revision,repository_id,source_payload_digest,workflow_deadline_at,
             source_operation_id,source_intent_id,source_stage,source_stage_attempt,
             source_effect_class,source_input_digest,source_config_digest,
             source_schema_digest,source_scope_digest,source_deadline_at,
             created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
                   to_timestamp($27/1000.0),to_timestamp($27/1000.0))
           RETURNING *`,
          [
            recoveryId,
            parent?.root_recovery_id ?? recoveryId,
            parent?.recovery_id ?? null,
            row.job_id,
            row.fencing_token,
            recoveryJobId,
            row.proposal_id,
            row.approval_id,
            row.case_id,
            row.owner_id,
            row.work_unit_id,
            row.run_id,
            row.checkpoint_revision,
            row.repository_id,
            canonicalDigest(row.payload),
            workflowDeadline,
            row.operation_id,
            row.intent_id,
            row.stage,
            row.stage_attempt,
            row.effect_class,
            row.input_digest,
            row.config_digest,
            row.schema_digest,
            row.integration_scope_digest,
            row.deadline_at,
            nowMs,
          ],
        );
        await this.#event(tx, inserted.rows[0]!, "ENQUEUED", null, null, {
          recovery_job_id: recoveryJobId,
          source_job_id: row.job_id,
          source_fencing_token: Number(row.fencing_token),
        });
        recoveries.push(inserted.rows[0]!);
      }
      return { recoveries, succeededSourceJobIds };
    });
  }

  public async claimRecovery(
    db: Database,
    input: { owner: string; leaseMs?: number },
  ): Promise<EngineeringRecoveryLease | null> {
    const owner = identifier.parse(input.owner);
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("invalid leaseMs");
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const claimed = await tx.query<JobRow>(
        `WITH candidate AS (
           SELECT j.job_id FROM jobs j
           JOIN engineering_recoveries r ON r.recovery_job_id=j.job_id
            WHERE j.status='PENDING' AND j.job_type=$2 AND r.status='PENDING'
              AND j.available_at <= ${this.#lt.now(1)}
            ORDER BY j.available_at,j.created_at,j.job_id
            FOR UPDATE OF j SKIP LOCKED LIMIT 1
         )
         UPDATE jobs j SET status='LEASED',lease_owner=$3,
                lease_expires_at=${this.#lt.deadline(1, 4)},
                leased_at=to_timestamp($1/1000.0),last_heartbeat_at=to_timestamp($1/1000.0),
                fencing_token=j.fencing_token+1,attempts=j.attempts+1
           FROM candidate c WHERE j.job_id=c.job_id
         RETURNING ${JOB_COLUMNS_J}`,
        [nowMs, JobType.AGENT_ENGINEERING_RECOVERY, owner, leaseMs],
      );
      const job = claimed.rows[0];
      if (job === undefined) return null;
      const recovery = await tx.query<EngineeringRecoveryRow>(
        `UPDATE engineering_recoveries
            SET status='LEASED',last_recovery_fencing_token=$2,
                updated_at=to_timestamp($3/1000.0)
          WHERE recovery_job_id=$1 AND status='PENDING'
            AND last_recovery_fencing_token < $2
          RETURNING *`,
        [job.job_id, job.fencing_token, nowMs],
      );
      if (recovery.rowCount !== 1) throw new EngineeringControlStateError("recovery claim raced");
      await this.#event(tx, recovery.rows[0]!, "CLAIMED", job.job_id, Number(job.fencing_token), {
        recovery_job_id: job.job_id,
      });
      return { recovery: recovery.rows[0]!, job: asLease(job, owner, nowMs, leaseMs) };
    });
  }

  /** Keep the case-less recovery job current while stage-specific read-only recovery runs. */
  public async heartbeatRecovery(
    db: Database,
    lease: EngineeringRecoveryLease,
    extendMs = 30_000,
  ): Promise<void> {
    if (!Number.isSafeInteger(extendMs) || extendMs < 1) throw new RangeError("invalid extendMs");
    const nowMs = this.#clock.now();
    await db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const current = await this.#assertRecoveryLease(tx, lease);
      const updated = await tx.query(
        `UPDATE jobs SET lease_expires_at=${this.#lt.deadline(2, 3)},
                         last_heartbeat_at=${this.#lt.now(2)}
          WHERE job_id=$1 AND status='LEASED' AND lease_owner=$4 AND fencing_token=$5
            AND lease_expires_at > ${this.#lt.now(2)}`,
        [current.recovery_job_id, nowMs, extendMs, lease.job.leaseOwner, lease.job.fencingToken],
      );
      if (updated.rowCount !== 1) {
        throw new EngineeringControlStateError("engineering recovery heartbeat lost its lease");
      }
    });
  }

  /** Fresh read fence used only by recovery observation adapters; it grants no writer authority. */
  public async assertCurrentRecovery(q: Queryable, lease: EngineeringRecoveryLease): Promise<void> {
    const nowMs = this.#clock.now();
    const current = await q.query(
      `SELECT 1 FROM engineering_recoveries r JOIN jobs j ON j.job_id=r.recovery_job_id
        WHERE r.recovery_id=$1 AND r.status='LEASED'
          AND j.job_id=$2 AND j.status='LEASED' AND j.lease_owner=$3
          AND j.fencing_token=$4 AND j.lease_expires_at > ${this.#lt.now(5)}`,
      [
        lease.recovery.recovery_id,
        lease.job.jobId,
        lease.job.leaseOwner,
        lease.job.fencingToken,
        nowMs,
      ],
    );
    if (current.rowCount !== 1) {
      throw new EngineeringControlStateError("engineering recovery lease is stale");
    }
  }

  /** Requeue only an expired code-owned recovery lease; generic reap never sees it. */
  public async reapExpiredRecovery(db: Database, limit = 100): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be positive");
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const expired = await tx.query<{ recovery_id: string; recovery_job_id: string }>(
        `SELECT r.recovery_id,r.recovery_job_id
           FROM engineering_recoveries r JOIN jobs j ON j.job_id=r.recovery_job_id
          WHERE r.status='LEASED' AND j.status='LEASED'
            AND j.lease_expires_at <= ${this.#lt.now(1)}
          ORDER BY j.lease_expires_at,r.recovery_id
          FOR UPDATE OF j,r SKIP LOCKED LIMIT $2`,
        [nowMs, limit],
      );
      for (const row of expired.rows) {
        await tx.query(
          `UPDATE jobs SET status='PENDING',lease_owner=NULL,lease_expires_at=NULL,
                           available_at=${this.#lt.scheduleBase(2)},
                           last_error='engineering recovery lease expired'
            WHERE job_id=$1 AND status='LEASED'`,
          [row.recovery_job_id, nowMs],
        );
        await tx.query(
          `UPDATE engineering_recoveries
              SET status='PENDING',plan=NULL,plan_digest=NULL,updated_at=to_timestamp($2/1000.0)
            WHERE recovery_id=$1 AND status='LEASED'`,
          [row.recovery_id, nowMs],
        );
      }
      return expired.rows.map((row) => row.recovery_id);
    });
  }

  /** Bind one strict server-owned plan to the current recovery fence. */
  public async bindPlan(
    db: Database,
    lease: EngineeringRecoveryLease,
    rawPlan: unknown,
  ): Promise<Readonly<{ plan: EngineeringRecoveryPlanV1; planDigest: string }>> {
    const plan = engineeringRecoveryPlanV1.parse(rawPlan);
    const planDigest = engineeringRecoveryPlanV1Digest(plan);
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const recovery = await this.#assertRecoveryLease(tx, lease);
      this.#assertPlanAuthority(recovery, lease, plan);
      if (recovery.plan !== null || recovery.plan_digest !== null) {
        if (
          recovery.plan_digest !== planDigest ||
          recovery.plan === null ||
          engineeringRecoveryPlanV1Digest(recovery.plan) !== planDigest
        ) {
          throw new EngineeringControlStateError("engineering recovery plan is already bound");
        }
        return { plan, planDigest };
      }
      const updated = await tx.query<EngineeringRecoveryRow>(
        `UPDATE engineering_recoveries SET plan=$2::jsonb,plan_digest=$3,
                updated_at=to_timestamp($4/1000.0)
          WHERE recovery_id=$1 AND status='LEASED' AND plan IS NULL AND plan_digest IS NULL
          RETURNING *`,
        [recovery.recovery_id, JSON.stringify(plan), planDigest, nowMs],
      );
      if (updated.rowCount !== 1)
        throw new EngineeringControlStateError("engineering recovery plan bind raced");
      await this.#event(
        tx,
        updated.rows[0]!,
        "CLASSIFIED",
        lease.job.jobId,
        lease.job.fencingToken,
        {
          plan_digest: planDigest,
          classification: plan.classification,
          evidence_digest: plan.evidence_digest,
          budget_reservation: plan.budget_reservation,
        },
      );
      return { plan, planDigest };
    });
  }

  /**
   * Converge an exact old operation to artifact + SUCCEEDED completion + observation.
   * This boundary is recovery-lease fenced and never dispatches a model, command, or Git write.
   */
  public async repairStageDurability(
    db: Database,
    lease: EngineeringRecoveryLease,
    rawInput: unknown,
  ): Promise<EngineeringRecoveryRepairResult> {
    const input = repairStageInput.parse(rawInput);
    const artifact = engineeringArtifact.parse(input.artifact);
    const artifactDigest = engineeringArtifactDigest(artifact);
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const recovery = await this.#assertRecoveryLease(tx, lease);
      const plan = this.#assertBoundPlan(recovery, input.planDigest);
      if (
        ![
          "REPAIR_ARTIFACT_COMPLETION",
          "REPAIR_COMPLETION",
          "REPAIR_OBSERVATION",
          "RECOVER_GATE_RECEIPTS",
          "OBSERVE_LOCAL_COMMIT",
        ].includes(plan.classification)
      ) {
        throw new EngineeringControlStateError(
          "engineering recovery classification cannot repair stage durability",
        );
      }
      if (
        recovery.source_operation_id === null ||
        recovery.source_operation_id !== input.operationId ||
        plan.operation?.operation_id !== input.operationId
      ) {
        throw new EngineeringControlStateError(
          "engineering recovery repair operation is not exact",
        );
      }
      const operation = await this.#sourceOperation(tx, recovery);
      const started = await tx.query(
        `SELECT event_id FROM engineering_stage_events
          WHERE operation_id=$1 AND event_type='STARTED' FOR SHARE`,
        [operation.operation_id],
      );
      if (started.rowCount !== 1) {
        throw new EngineeringControlStateError("engineering recovery repair has no STARTED marker");
      }
      if (
        artifact.case_id !== operation.case_id ||
        artifact.run_id !== operation.run_id ||
        artifact.revision !== operation.checkpoint_revision ||
        !isEngineeringArtifactKindAllowedForStage(operation.stage, artifact.artifact_kind)
      ) {
        throw new EngineeringControlStateError(
          "recovery artifact crosses its operation case, run, checkpoint, or stage kind",
        );
      }

      const artifactRevisionId = this.#ids.next("eng-artifact-repair");
      const insertedArtifact = await tx.query<EngineeringControlArtifactRevisionRow>(
        `INSERT INTO engineering_artifact_revisions (
           artifact_revision_id,artifact_key,revision,artifact_kind,payload,payload_digest,
           operation_id,intent_id,job_id,case_id,owner_id,run_id,stage,stage_attempt,
           checkpoint_revision,recorded_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 to_timestamp($16/1000.0))
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          artifactRevisionId,
          input.artifactKey,
          artifact.revision,
          artifact.artifact_kind,
          JSON.stringify(artifact),
          artifactDigest,
          operation.operation_id,
          operation.intent_id,
          operation.job_id,
          operation.case_id,
          operation.owner_id,
          operation.run_id,
          operation.stage,
          operation.stage_attempt,
          operation.checkpoint_revision,
          nowMs,
        ],
      );
      let durableArtifact = insertedArtifact.rows[0];
      if (durableArtifact === undefined) {
        const existing = await tx.query<EngineeringControlArtifactRevisionRow>(
          `SELECT * FROM engineering_artifact_revisions
            WHERE run_id=$1 AND artifact_key=$2 AND revision=$3 FOR SHARE`,
          [operation.run_id, input.artifactKey, artifact.revision],
        );
        durableArtifact = existing.rows[0];
      }
      if (!this.#artifactMatches(durableArtifact, operation, artifact, artifactDigest)) {
        throw new EngineeringControlStateError("engineering recovery artifact conflicts");
      }
      await this.#stageEvent(
        tx,
        operation,
        "ARTIFACT_RECORDED",
        durableArtifact.artifact_revision_id,
        null,
        {
          artifact_revision_id: durableArtifact.artifact_revision_id,
          payload_digest: durableArtifact.payload_digest,
        },
      );
      await this.#repairEventOnce(tx, recovery, lease, "ARTIFACT_REPAIRED", {
        artifact_revision_id: durableArtifact.artifact_revision_id,
        artifact_digest: durableArtifact.payload_digest,
      });

      const receipt = {
        artifact_revision_id: durableArtifact.artifact_revision_id,
        artifact_digest: durableArtifact.payload_digest,
      };
      const completionCandidate = this.#ids.next("eng-completion-repair");
      await tx.query(
        `INSERT INTO job_completions (
           completion_id,intent_id,job_id,outcome,receipt,recorded_at)
         VALUES ($1,$2,$3,'SUCCEEDED',$4::jsonb,to_timestamp($5/1000.0))
         ON CONFLICT (intent_id) DO NOTHING`,
        [
          completionCandidate,
          operation.intent_id,
          operation.job_id,
          JSON.stringify(receipt),
          nowMs,
        ],
      );
      const completion = await tx.query<{
        completion_id: string;
        outcome: string;
        receipt: unknown;
      }>(
        `SELECT completion_id,outcome,receipt FROM job_completions
          WHERE intent_id=$1 AND job_id=$2 FOR SHARE`,
        [operation.intent_id, operation.job_id],
      );
      const durableCompletion = completion.rows[0];
      if (
        durableCompletion === undefined ||
        durableCompletion.outcome !== "SUCCEEDED" ||
        canonicalDigest(durableCompletion.receipt) !== canonicalDigest(receipt)
      ) {
        throw new EngineeringControlStateError("engineering recovery completion conflicts");
      }
      await this.#repairEventOnce(tx, recovery, lease, "COMPLETION_REPAIRED", {
        completion_id: durableCompletion.completion_id,
        artifact_revision_id: durableArtifact.artifact_revision_id,
      });
      await this.#stageEvent(
        tx,
        operation,
        "COMPLETION_OBSERVED",
        null,
        durableCompletion.completion_id,
        { completion_id: durableCompletion.completion_id, outcome: "SUCCEEDED" },
      );
      await this.#repairEventOnce(tx, recovery, lease, "OBSERVATION_REPAIRED", {
        completion_id: durableCompletion.completion_id,
      });
      return {
        artifact: durableArtifact,
        completionId: durableCompletion.completion_id,
        completionObserved: true,
      };
    });
  }

  /** Observe one exact completed inner gate operation; never creates a completion or dispatches. */
  public async repairOperationObservation(
    db: Database,
    lease: EngineeringRecoveryLease,
    rawInput: unknown,
  ): Promise<void> {
    const input = repairObservationInput.parse(rawInput);
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const recovery = await this.#assertRecoveryLease(tx, lease);
      const plan = this.#assertBoundPlan(recovery, input.planDigest);
      if (
        plan.classification !== "RECOVER_GATE_RECEIPTS" ||
        recovery.source_stage !== "GATE_EXECUTION"
      ) {
        throw new EngineeringControlStateError("inner observation is not a gate recovery plan");
      }
      const operation = await tx.query<EngineeringControlOperationRow>(
        `SELECT o.* FROM engineering_operations o
          WHERE o.operation_id=$1 AND o.job_id=$2 AND o.case_id=$3 AND o.owner_id=$4
            AND o.run_id=$5 AND o.stage='GATE_EXECUTION' AND o.stage_attempt=$6
            AND o.checkpoint_revision=$7 AND o.effect_class='COMMAND'
          FOR SHARE`,
        [
          input.operationId,
          recovery.source_job_id,
          recovery.case_id,
          recovery.owner_id,
          recovery.run_id,
          recovery.source_stage_attempt,
          recovery.checkpoint_revision,
        ],
      );
      const exact = operation.rows[0];
      if (exact === undefined) {
        throw new EngineeringControlStateError("inner gate operation crosses recovery authority");
      }
      const completion = await tx.query<{ completion_id: string; outcome: string }>(
        `SELECT completion_id,outcome FROM job_completions
          WHERE completion_id=$1 AND intent_id=$2 AND job_id=$3 FOR SHARE`,
        [input.completionId, exact.intent_id, exact.job_id],
      );
      if (completion.rows[0]?.outcome !== "SUCCEEDED") {
        throw new EngineeringControlStateError("inner gate completion is not exact SUCCEEDED");
      }
      await this.#stageEvent(tx, exact, "COMPLETION_OBSERVED", null, input.completionId, {
        completion_id: input.completionId,
        outcome: "SUCCEEDED",
      });
      await this.#repairEventOnce(tx, recovery, lease, "OBSERVATION_REPAIRED", {
        operation_id: input.operationId,
        completion_id: input.completionId,
      });
    });
  }

  /** Persist an exact fail-closed recovery classification without exposing the source job. */
  public async terminateRecovery(
    db: Database,
    lease: EngineeringRecoveryLease,
    rawInput: unknown,
  ): Promise<EngineeringRecoveryRow> {
    const input = z
      .union([
        z.string(),
        z
          .object({
            planDigest: z.string(),
            terminal: z.enum(["AMBIGUOUS", "BLOCKED", "CANCELLED"]),
          })
          .strict(),
      ])
      .parse(rawInput);
    const planDigest = parsePlanDigest(typeof input === "string" ? input : input.planDigest);
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const recovery = await this.#assertRecoveryLease(tx, lease);
      const plan = this.#assertBoundPlan(recovery, planDigest);
      const status: EngineeringRecoveryTerminalStatus =
        typeof input === "string"
          ? (plan.classification as EngineeringRecoveryTerminalStatus)
          : input.terminal;
      const directTerminal =
        plan.classification === "AMBIGUOUS" ||
        plan.classification === "BLOCKED" ||
        plan.classification === "CANCELLED";
      const observationFailedClosed =
        typeof input !== "string" &&
        input.terminal === "AMBIGUOUS" &&
        (plan.classification === "RECOVER_GATE_RECEIPTS" ||
          plan.classification === "OBSERVE_LOCAL_COMMIT");
      if (!directTerminal && !observationFailedClosed) {
        throw new EngineeringControlStateError("engineering recovery plan is not terminal");
      }
      if (directTerminal && status !== plan.classification) {
        throw new EngineeringControlStateError("engineering recovery terminal status conflicts");
      }
      const recoveryJob = await tx.query(
        `UPDATE jobs SET status='SUCCEEDED',finished_at=to_timestamp($2/1000.0),
                         lease_owner=NULL,lease_expires_at=NULL,last_error=NULL
          WHERE job_id=$1 AND status='LEASED' AND lease_owner=$3 AND fencing_token=$4
            AND lease_expires_at > ${this.#lt.now(5)}`,
        [lease.job.jobId, nowMs, lease.job.leaseOwner, lease.job.fencingToken, nowMs],
      );
      if (recoveryJob.rowCount !== 1) {
        throw new EngineeringControlStateError("recovery job lease became stale");
      }
      const updated = await tx.query<EngineeringRecoveryRow>(
        `UPDATE engineering_recoveries SET status=$2,updated_at=to_timestamp($4/1000.0)
          WHERE recovery_id=$1 AND status='LEASED' AND plan_digest=$3
          RETURNING *`,
        [recovery.recovery_id, status, planDigest, nowMs],
      );
      if (updated.rowCount !== 1) {
        throw new EngineeringControlStateError("engineering recovery terminal transition raced");
      }
      await this.#event(
        tx,
        updated.rows[0]!,
        "TERMINATED",
        lease.job.jobId,
        lease.job.fencingToken,
        { plan_digest: planDigest, status },
      );
      return updated.rows[0]!;
    });
  }

  /** Publish a classified plan and expose the original writer only to dedicated claim. */
  public async publishContinuation(
    db: Database,
    lease: EngineeringRecoveryLease,
    rawPlanDigest: unknown,
  ): Promise<EngineeringRecoveryRow> {
    const planDigest = parsePlanDigest(rawPlanDigest);
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const recovery = await this.#assertRecoveryLease(tx, lease);
      if (recovery.plan_digest !== planDigest) {
        throw new EngineeringControlStateError("continuation plan is not bound to recovery");
      }
      const source = await tx.query(
        `UPDATE jobs SET status='RECOVERY_PENDING',available_at=to_timestamp($3/1000.0),
                         last_error=NULL
          WHERE job_id=$1 AND status='RECONCILING' AND fencing_token=$2`,
        [recovery.source_job_id, recovery.source_fencing_token, nowMs],
      );
      if (source.rowCount !== 1)
        throw new EngineeringControlStateError("source is not recoverable");
      const recoveryJob = await tx.query(
        `UPDATE jobs SET status='SUCCEEDED',finished_at=to_timestamp($2/1000.0),
                         lease_owner=NULL,lease_expires_at=NULL,last_error=NULL
          WHERE job_id=$1 AND status='LEASED' AND lease_owner=$3 AND fencing_token=$4
            AND lease_expires_at > ${this.#lt.now(5)}`,
        [lease.job.jobId, nowMs, lease.job.leaseOwner, lease.job.fencingToken, nowMs],
      );
      if (recoveryJob.rowCount !== 1)
        throw new EngineeringControlStateError("recovery job lease became stale");
      const updated = await tx.query<EngineeringRecoveryRow>(
        `UPDATE engineering_recoveries SET status='RECOVERY_PENDING',
                updated_at=to_timestamp($3/1000.0)
          WHERE recovery_id=$1 AND status='LEASED' AND plan_digest=$2
          RETURNING *`,
        [recovery.recovery_id, planDigest, nowMs],
      );
      await this.#event(
        tx,
        updated.rows[0]!,
        "CONTINUATION_ENQUEUED",
        lease.job.jobId,
        lease.job.fencingToken,
        { plan_digest: planDigest, source_job_id: recovery.source_job_id },
      );
      return updated.rows[0]!;
    });
  }

  public async claimContinuation(
    db: Database,
    input: { owner: string; leaseMs?: number },
  ): Promise<EngineeringContinuationLease | null> {
    const owner = identifier.parse(input.owner);
    const leaseMs = input.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError("invalid leaseMs");
    const nowMs = this.#clock.now();
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const claimed = await tx.query<JobRow>(
        `WITH candidate AS (
           SELECT j.job_id FROM jobs j
           JOIN engineering_recoveries r ON r.source_job_id=j.job_id
            WHERE j.status='RECOVERY_PENDING' AND j.job_type=$2
              AND r.status='RECOVERY_PENDING' AND j.available_at <= ${this.#lt.now(1)}
            ORDER BY j.available_at,r.created_at,r.recovery_id
            FOR UPDATE OF j SKIP LOCKED LIMIT 1
         )
         UPDATE jobs j SET status='LEASED',lease_owner=$3,
                lease_expires_at=${this.#lt.deadline(1, 4)},
                leased_at=to_timestamp($1/1000.0),last_heartbeat_at=to_timestamp($1/1000.0),
                fencing_token=j.fencing_token+1,attempts=j.attempts+1
           FROM candidate c WHERE j.job_id=c.job_id
         RETURNING ${JOB_COLUMNS_J}`,
        [nowMs, JobType.AGENT_IMPLEMENTER, owner, leaseMs],
      );
      const job = claimed.rows[0];
      if (job === undefined) return null;
      const recovery = await tx.query<EngineeringRecoveryRow>(
        `UPDATE engineering_recoveries
            SET status='CONTINUED',continuation_fencing_token=$2,
                updated_at=to_timestamp($3/1000.0)
          WHERE source_job_id=$1 AND status='RECOVERY_PENDING'
          RETURNING *`,
        [job.job_id, job.fencing_token, nowMs],
      );
      if (recovery.rowCount !== 1)
        throw new EngineeringControlStateError("continuation claim raced");
      await this.#event(
        tx,
        recovery.rows[0]!,
        "CONTINUATION_CLAIMED",
        job.job_id,
        Number(job.fencing_token),
        {
          source_job_id: job.job_id,
          continuation_fencing_token: Number(job.fencing_token),
        },
      );
      return { recovery: recovery.rows[0]!, job: asLease(job, owner, nowMs, leaseMs) };
    });
  }

  /** Verify that a current implementer lease came only from the dedicated continuation claim. */
  public async findContinuationForLease(
    q: Queryable,
    lease: JobLease,
  ): Promise<EngineeringRecoveryRow | null> {
    const result = await q.query<EngineeringRecoveryRow>(
      `SELECT r.* FROM engineering_recoveries r JOIN jobs j ON j.job_id=r.source_job_id
        WHERE r.source_job_id=$1 AND r.status='CONTINUED'
          AND r.continuation_fencing_token=$2
          AND j.status='LEASED' AND j.lease_owner=$3 AND j.fencing_token=$2
          AND j.lease_expires_at > ${this.#lt.now(4)}
        ORDER BY r.created_at DESC,r.recovery_id DESC LIMIT 1`,
      [lease.jobId, lease.fencingToken, lease.leaseOwner, this.#clock.now()],
    );
    const recovery = result.rows[0] ?? null;
    if (recovery !== null) this.#assertBoundPlan(recovery, recovery.plan_digest ?? "");
    return recovery;
  }

  /**
   * A continuation handler failure is never routed through generic bounded retry. Expire the
   * exact continuation fence; the coordinator immediately materializes the next recovery link.
   */
  public async expireFailedContinuation(
    db: Database,
    lease: JobLease,
    error: string,
  ): Promise<void> {
    const nowMs = this.#clock.now();
    await db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const recovery = await tx.query<{ recovery_id: string }>(
        `SELECT recovery_id FROM engineering_recoveries
          WHERE source_job_id=$1 AND status='CONTINUED' AND continuation_fencing_token=$2
          FOR UPDATE`,
        [lease.jobId, lease.fencingToken],
      );
      if (recovery.rowCount !== 1) {
        throw new EngineeringControlStateError("failed continuation is not exact");
      }
      const updated = await tx.query(
        `UPDATE jobs SET lease_expires_at=to_timestamp(($2-1)/1000.0),last_error=$3
          WHERE job_id=$1 AND status='LEASED' AND lease_owner=$4 AND fencing_token=$5
            AND lease_expires_at > ${this.#lt.now(2)}`,
        [lease.jobId, nowMs, error.slice(0, 2048), lease.leaseOwner, lease.fencingToken],
      );
      if (updated.rowCount !== 1) {
        throw new EngineeringControlStateError("failed continuation lease became stale");
      }
    });
  }

  public async findById(q: Queryable, recoveryId: string): Promise<EngineeringRecoveryRow | null> {
    const result = await q.query<EngineeringRecoveryRow>(
      "SELECT * FROM engineering_recoveries WHERE recovery_id=$1",
      [identifier.parse(recoveryId)],
    );
    return result.rows[0] ?? null;
  }

  #assertSourcePayload(row: JobRow, expected: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(expected)) {
      if (row.payload[key] !== value) {
        throw new EngineeringControlStateError(
          `engineering recovery source payload mismatch at ${key}`,
        );
      }
    }
  }

  #assertBoundPlan(
    recovery: EngineeringRecoveryRow,
    planDigest: string,
  ): EngineeringRecoveryPlanV1 {
    if (
      recovery.plan === null ||
      recovery.plan_digest !== planDigest ||
      engineeringRecoveryPlanV1Digest(recovery.plan) !== planDigest
    ) {
      throw new EngineeringControlStateError("engineering recovery plan is not durably bound");
    }
    return engineeringRecoveryPlanV1.parse(recovery.plan);
  }

  async #sourceOperation(
    tx: Transaction,
    recovery: EngineeringRecoveryRow,
  ): Promise<EngineeringControlOperationRow> {
    const result = await tx.query<EngineeringControlOperationRow>(
      `SELECT o.* FROM engineering_operations o
        WHERE o.operation_id=$1 AND o.intent_id=$2 AND o.job_id=$3
          AND o.case_id=$4 AND o.owner_id=$5 AND o.run_id=$6
          AND o.stage=$7 AND o.stage_attempt=$8 AND o.checkpoint_revision=$9
          AND o.effect_class=$10 AND o.integration_scope_digest=$11
          AND o.input_digest=$12 AND o.config_digest=$13 AND o.schema_digest=$14
          AND o.deadline_at=$15
        FOR SHARE`,
      [
        recovery.source_operation_id,
        recovery.source_intent_id,
        recovery.source_job_id,
        recovery.case_id,
        recovery.owner_id,
        recovery.run_id,
        recovery.source_stage,
        recovery.source_stage_attempt,
        recovery.checkpoint_revision,
        recovery.source_effect_class,
        recovery.source_scope_digest,
        recovery.source_input_digest,
        recovery.source_config_digest,
        recovery.source_schema_digest,
        recovery.source_deadline_at,
      ],
    );
    const operation = result.rows[0];
    if (operation === undefined) {
      throw new EngineeringControlStateError("engineering recovery source operation disappeared");
    }
    return operation;
  }

  #artifactMatches(
    row: EngineeringControlArtifactRevisionRow | undefined,
    operation: EngineeringControlOperationRow,
    artifact: EngineeringArtifact,
    artifactDigest: string,
  ): row is EngineeringControlArtifactRevisionRow {
    return (
      row !== undefined &&
      row.payload_digest === artifactDigest &&
      canonicalDigest(row.payload) === canonicalDigest(artifact) &&
      row.artifact_kind === artifact.artifact_kind &&
      row.operation_id === operation.operation_id &&
      row.intent_id === operation.intent_id &&
      row.job_id === operation.job_id &&
      row.case_id === operation.case_id &&
      row.owner_id === operation.owner_id &&
      row.run_id === operation.run_id &&
      row.stage === operation.stage &&
      row.stage_attempt === operation.stage_attempt &&
      row.checkpoint_revision === operation.checkpoint_revision
    );
  }

  async #stageEvent(
    tx: Transaction,
    operation: EngineeringControlOperationRow,
    eventType: "ARTIFACT_RECORDED" | "COMPLETION_OBSERVED",
    artifactRevisionId: string | null,
    completionId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const payloadDigest = canonicalDigest(payload);
    await tx.query(
      `INSERT INTO engineering_stage_events (
         event_id,event_sequence,event_type,operation_id,intent_id,job_id,case_id,owner_id,
         run_id,stage,stage_attempt,checkpoint_revision,artifact_revision_id,completion_id,
         payload,payload_digest,recorded_at)
       VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,
               to_timestamp($16/1000.0))
       ON CONFLICT DO NOTHING`,
      [
        this.#ids.next("eng-event-repair"),
        eventType,
        operation.operation_id,
        operation.intent_id,
        operation.job_id,
        operation.case_id,
        operation.owner_id,
        operation.run_id,
        operation.stage,
        operation.stage_attempt,
        operation.checkpoint_revision,
        artifactRevisionId,
        completionId,
        JSON.stringify(payload),
        payloadDigest,
        this.#clock.now(),
      ],
    );
    const event = await tx.query<{
      payload_digest: string;
      artifact_revision_id: string | null;
      completion_id: string | null;
    }>(
      `SELECT payload_digest,artifact_revision_id,completion_id
         FROM engineering_stage_events
        WHERE operation_id=$1 AND event_type=$2
          AND (($2='ARTIFACT_RECORDED' AND artifact_revision_id=$3)
            OR ($2='COMPLETION_OBSERVED' AND completion_id=$4))
        FOR SHARE`,
      [operation.operation_id, eventType, artifactRevisionId, completionId],
    );
    const durable = event.rows[0];
    if (
      durable === undefined ||
      durable.payload_digest !== payloadDigest ||
      durable.artifact_revision_id !== artifactRevisionId ||
      durable.completion_id !== completionId
    ) {
      throw new EngineeringControlStateError("engineering recovery stage event conflicts");
    }
  }

  async #repairEventOnce(
    tx: Transaction,
    recovery: EngineeringRecoveryRow,
    lease: EngineeringRecoveryLease,
    eventType: "ARTIFACT_REPAIRED" | "COMPLETION_REPAIRED" | "OBSERVATION_REPAIRED",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const payloadDigest = canonicalDigest(payload);
    const existing = await tx.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM engineering_recovery_events
        WHERE recovery_id=$1 AND event_type=$2 AND payload_digest=$3 FOR SHARE`,
      [recovery.recovery_id, eventType, payloadDigest],
    );
    if (existing.rows[0] !== undefined) {
      return;
    }
    await this.#event(tx, recovery, eventType, lease.job.jobId, lease.job.fencingToken, payload);
  }

  #assertPlanAuthority(
    recovery: EngineeringRecoveryRow,
    lease: EngineeringRecoveryLease,
    plan: EngineeringRecoveryPlanV1,
  ): void {
    const identityMatches =
      plan.recovery_id === recovery.recovery_id &&
      plan.root_recovery_id === recovery.root_recovery_id &&
      plan.source_job_id === recovery.source_job_id &&
      plan.source_fencing_token === Number(recovery.source_fencing_token) &&
      plan.recovery_job_id === recovery.recovery_job_id &&
      plan.recovery_fencing_token === lease.job.fencingToken &&
      plan.case_id === recovery.case_id &&
      plan.owner_id === recovery.owner_id &&
      plan.work_unit_id === recovery.work_unit_id &&
      plan.run_id === recovery.run_id &&
      plan.checkpoint_revision === recovery.checkpoint_revision &&
      plan.repository_id === recovery.repository_id &&
      new Date(plan.workflow_deadline_at).getTime() === recovery.workflow_deadline_at.getTime();
    if (!identityMatches) {
      throw new EngineeringControlStateError("engineering recovery plan crosses authority");
    }
    if (recovery.source_operation_id === null) {
      if (plan.operation !== null) {
        throw new EngineeringControlStateError("engineering recovery plan invents an operation");
      }
      return;
    }
    if (
      plan.operation === null ||
      plan.operation.operation_id !== recovery.source_operation_id ||
      plan.operation.intent_id !== recovery.source_intent_id ||
      plan.operation.stage !== recovery.source_stage ||
      plan.operation.stage_attempt !== recovery.source_stage_attempt ||
      plan.operation.effect_class !== recovery.source_effect_class ||
      plan.operation.input_digest !== recovery.source_input_digest ||
      plan.operation.config_digest !== recovery.source_config_digest ||
      plan.operation.schema_digest !== recovery.source_schema_digest ||
      plan.operation.scope_digest !== recovery.source_scope_digest ||
      new Date(plan.operation.deadline_at).getTime() !== recovery.source_deadline_at?.getTime()
    ) {
      throw new EngineeringControlStateError("engineering recovery plan operation is not exact");
    }
  }

  async #assertRecoveryLease(
    tx: Transaction,
    lease: EngineeringRecoveryLease,
  ): Promise<EngineeringRecoveryRow> {
    const result = await tx.query<EngineeringRecoveryRow>(
      `SELECT r.* FROM engineering_recoveries r
       JOIN jobs j ON j.job_id=r.recovery_job_id
        WHERE r.recovery_id=$1 AND r.status='LEASED'
          AND r.recovery_job_id=$2 AND r.last_recovery_fencing_token=$3
          AND j.status='LEASED' AND j.lease_owner=$4 AND j.fencing_token=$3
          AND j.lease_expires_at > ${this.#lt.now(5)}
          AND j.payload IS NOT DISTINCT FROM $6::jsonb
        FOR UPDATE OF r,j`,
      [
        lease.recovery.recovery_id,
        lease.job.jobId,
        lease.job.fencingToken,
        lease.job.leaseOwner,
        this.#clock.now(),
        JSON.stringify(lease.job.payload),
      ],
    );
    if (result.rowCount !== 1)
      throw new EngineeringControlStateError("stale engineering recovery lease");
    return result.rows[0]!;
  }

  async #recordSourceAttempt(
    tx: Transaction,
    row: JobRow,
    outcome: "LEASE_LOST" | "SUCCEEDED",
    nowMs: number,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO job_attempts (
         job_id,attempt_number,lease_owner,fencing_token,outcome,error,started_at,finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7/1000.0),to_timestamp($7/1000.0))
       ON CONFLICT (job_id,attempt_number) DO NOTHING`,
      [
        row.job_id,
        row.attempts,
        row.lease_owner ?? "unknown",
        row.fencing_token,
        outcome,
        outcome === "SUCCEEDED" ? null : "engineering recovery coordinator parked expired lease",
        nowMs,
      ],
    );
  }

  async #event(
    tx: Transaction,
    recovery: EngineeringRecoveryRow,
    eventType: string,
    authorityJobId: string | null,
    authorityFencingToken: number | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO engineering_recovery_events (
         event_id,recovery_id,event_type,authority_job_id,authority_fencing_token,
         payload,payload_digest,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,to_timestamp($8/1000.0))`,
      [
        this.#ids.next("eng-recovery-event"),
        recovery.recovery_id,
        eventType,
        authorityJobId,
        authorityFencingToken,
        JSON.stringify(payload),
        canonicalDigest(payload),
        this.#clock.now(),
      ],
    );
  }
}
