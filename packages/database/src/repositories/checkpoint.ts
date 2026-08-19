/**
 * Checkpoint repository with optimistic concurrency / compare-and-set (RA-003).
 *
 * The JSON checkpoint is the source of truth (Master Plan §5.3). Each revision
 * is immutable (append-only) and identified by UNIQUE(case_id, revision). To
 * advance a case from revision `expectedRevision` to `expectedRevision + 1`,
 * {@link CheckpointRepository.append} atomically:
 *   1. bumps `cases.checkpoint_revision` only if it still equals the expected
 *      value, and
 *   2. inserts the new immutable checkpoint row.
 * If another writer already advanced the case, step 1 updates zero rows (or the
 * insert hits the unique constraint) and a {@link CheckpointConflictError} is
 * raised — so two updates of the same revision can never both win
 * (RA-003 acceptance criterion 3).
 *
 * Atomicity is guaranteed by the type system: `append` accepts a branded
 * {@link Transaction}, not a plain {@link Queryable}/{@link Database}. The only
 * way to obtain a {@link Transaction} is {@link Database.withTransaction}, which
 * owns the BEGIN/COMMIT/ROLLBACK boundary. This makes the AUDIT-01 HIGH-02
 * hazard — calling `append` with the auto-commit pool and leaving the revision
 * bumped after a failed insert — a compile-time error.
 */
import type { CaseCheckpoint } from "@remoteagent/contracts";

import type { Queryable, Transaction } from "../client.js";
import { CheckpointConflictError, translatePgError } from "../client.js";
import { PersistenceError, UniqueViolationError } from "../errors.js";

export interface CheckpointRow {
  case_id: string;
  revision: number;
  checkpoint: CaseCheckpoint;
  last_event_id: string | null;
  last_run_id: string | null;
  created_at: Date;
}

export interface AppendCheckpoint {
  caseId: string;
  /** The revision the caller believes the case is currently at. */
  expectedRevision: number;
  checkpoint: CaseCheckpoint;
  lastEventId?: string | null;
  lastRunId?: string | null;
}

export class CheckpointRepository {
  /**
   * Append a new checkpoint revision using compare-and-set. The parameter type
   * is a branded {@link Transaction}, so this cannot be called with the
   * auto-commit pool: the CAS bump and the immutable insert always share one
   * atomic boundary opened by {@link Database.withTransaction}.
   *
   * @throws {CheckpointConflictError} if the case is no longer at
   *   `expectedRevision` (a concurrent writer won).
   * @throws {PersistenceError} if the payload's `case_id`/`revision` do not
   *   match the row being written (a caller/serialization bug).
   */
  public async append(tx: Transaction, input: AppendCheckpoint): Promise<CheckpointRow> {
    const nextRevision = input.expectedRevision + 1;

    // Guard: the JSON payload must describe exactly the row being written, so a
    // checkpoint blob can never disagree with its own (case_id, revision).
    if (input.checkpoint.case_id !== input.caseId) {
      throw new PersistenceError(
        `Checkpoint payload case_id "${input.checkpoint.case_id}" does not match ` +
          `target case "${input.caseId}"`,
      );
    }
    if (input.checkpoint.revision !== nextRevision) {
      throw new PersistenceError(
        `Checkpoint payload revision ${input.checkpoint.revision} does not match ` +
          `target revision ${nextRevision}`,
      );
    }

    // Step 1: CAS on the case row. Only succeeds if nobody advanced the case.
    const bumped = await tx.query<{ checkpoint_revision: number }>(
      `UPDATE cases
         SET checkpoint_revision = $2
       WHERE case_id = $1 AND checkpoint_revision = $3
       RETURNING checkpoint_revision`,
      [input.caseId, nextRevision, input.expectedRevision],
    );

    if (bumped.rows.length === 0) {
      // Either the case does not exist or the revision moved. Report the current
      // revision (if any) so the caller can reload and retry.
      const current = await tx.query<{ checkpoint_revision: number }>(
        `SELECT checkpoint_revision FROM cases WHERE case_id = $1`,
        [input.caseId],
      );
      const actual = current.rows[0]?.checkpoint_revision ?? null;
      throw new CheckpointConflictError(input.caseId, input.expectedRevision, actual);
    }

    // Step 2: insert the immutable checkpoint row. The unique (case_id, revision)
    // primary key is a second guard against a racing writer. owner_id is derived
    // from the case (never supplied by the caller) and pinned to it by the
    // (case_id, owner_id) FK, so last_event_id can only reference an event of the
    // case's own owner.
    try {
      const inserted = await tx.query<CheckpointRow>(
        `INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_event_id, last_run_id)
         VALUES ($1, (SELECT owner_id FROM cases WHERE case_id = $1), $2, $3::jsonb, $4, $5)
         RETURNING case_id, revision, checkpoint, last_event_id, last_run_id, created_at`,
        [
          input.caseId,
          nextRevision,
          JSON.stringify(input.checkpoint),
          input.lastEventId ?? null,
          input.lastRunId ?? null,
        ],
      );
      return inserted.rows[0]!;
    } catch (error) {
      const translated = translatePgError(error);
      if (translated instanceof UniqueViolationError) {
        // A concurrent writer inserted this revision first. Surface as a
        // checkpoint conflict for uniform handling by callers.
        throw new CheckpointConflictError(input.caseId, input.expectedRevision, nextRevision);
      }
      throw translated ?? error;
    }
  }

  public async latest(q: Queryable, caseId: string): Promise<CheckpointRow | null> {
    const result = await q.query<CheckpointRow>(
      `SELECT case_id, revision, checkpoint, last_event_id, last_run_id, created_at
       FROM case_checkpoints
       WHERE case_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [caseId],
    );
    return result.rows[0] ?? null;
  }

  public async atRevision(
    q: Queryable,
    caseId: string,
    revision: number,
  ): Promise<CheckpointRow | null> {
    const result = await q.query<CheckpointRow>(
      `SELECT case_id, revision, checkpoint, last_event_id, last_run_id, created_at
       FROM case_checkpoints
       WHERE case_id = $1 AND revision = $2`,
      [caseId, revision],
    );
    return result.rows[0] ?? null;
  }
}
