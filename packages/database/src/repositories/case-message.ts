/**
 * Case conversation log (RA-031).
 *
 * The `case_messages` table has existed since migration 003 (RA-003) — OWNER/AGENT/SYSTEM roles,
 * a `TRUSTED`/`UNTRUSTED_DATA` trust marker, append-only via `ra_deny_mutation` — but had no
 * repository, so nothing ever wrote or read it. RA-031 gives it one: an owner reply in a case
 * thread is appended here as `OWNER` + `UNTRUSTED_DATA`, and the context assembler reads recent
 * rows as a `thread_excerpt` fragment so the next run sees it. Append-only: there is no update or
 * delete method, and the DB trigger enforces it.
 */
import * as z from "zod";

import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";

export type CaseMessageRole = "OWNER" | "AGENT" | "SYSTEM";
export type CaseMessageTrust = "TRUSTED" | "UNTRUSTED_DATA";

export interface NewCaseMessage {
  readonly messageId: string;
  readonly caseId: string;
  readonly role: CaseMessageRole;
  readonly trust: CaseMessageTrust;
  readonly body: string;
}

export interface CaseMessageRow {
  readonly message_id: string;
  readonly case_id: string;
  readonly role: CaseMessageRole;
  readonly trust: CaseMessageTrust;
  readonly body: string;
  readonly created_at: Date;
}

const newMessageSchema = z.strictObject({
  messageId: z.string().trim().min(1).max(512),
  caseId: z.string().trim().min(1).max(512),
  role: z.enum(["OWNER", "AGENT", "SYSTEM"]),
  trust: z.enum(["TRUSTED", "UNTRUSTED_DATA"]),
  body: z.string().max(65_536),
});

export class CaseMessageRepository {
  /**
   * Append a message. Takes a {@link Transaction} (never the auto-commit pool) so a caller can
   * record the message and its downstream work (a PENDING unit + `case.resume`) in one atomic
   * boundary. Idempotent on `message_id`: a replayed delivery is a no-op, never a duplicate or a
   * mutation of the immutable row.
   */
  public async append(tx: Transaction, input: NewCaseMessage): Promise<void> {
    const parsed = newMessageSchema.parse(input);
    try {
      await tx.query(
        `INSERT INTO case_messages (message_id, case_id, role, trust, body)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id) DO NOTHING`,
        [parsed.messageId, parsed.caseId, parsed.role, parsed.trust, parsed.body],
      );
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /** Most recent messages for a case, oldest-first within the returned window (for context). */
  public async listRecent(q: Queryable, caseId: string, limit = 20): Promise<CaseMessageRow[]> {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = await q.query<CaseMessageRow>(
      `SELECT message_id, case_id, role, trust, body, created_at
       FROM (
         SELECT * FROM case_messages WHERE case_id = $1 ORDER BY created_at DESC, message_id DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC, message_id ASC`,
      [caseId, bounded],
    );
    return rows.rows;
  }
}
