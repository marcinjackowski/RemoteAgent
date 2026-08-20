import type { Queryable, Transaction } from "../client.js";
import * as z from "zod";

const id = z.string().trim().min(1).max(512);
const registrationInput = z.strictObject({
  registrationId: id,
  ownerId: id,
  connectionId: id,
  callbackUrl: z.string().url().max(2048),
  configDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum([
    "ABSENT",
    "REGISTERING",
    "ACTIVE",
    "RENEWAL_DUE",
    "RENEWING",
    "RECONCILING",
    "EXPIRED",
    "FAILED",
  ]),
  generation: z.int().min(1),
  externalRegistrationId: id.nullable().optional(),
  expiresAt: z.date().nullable().optional(),
  renewAfter: z.date().nullable().optional(),
  lastErrorCode: z.string().min(1).max(128).nullable().optional(),
  terminalAlertGeneration: z.int().min(1).nullable().optional(),
});
export type JiraWebhookRegistrationStatus = z.infer<typeof registrationInput>["status"];
export interface JiraWebhookRegistrationRow {
  registration_id: string;
  owner_id: string;
  connection_id: string;
  provider: "jira";
  external_registration_id: string | null;
  callback_url: string;
  config_digest: string;
  status: JiraWebhookRegistrationStatus;
  generation: number;
  expires_at: Date | null;
  renew_after: Date | null;
  last_error_code: string | null;
  terminal_alert_generation: number | null;
  created_at: Date;
  updated_at: Date;
}
const columns =
  "registration_id, owner_id, connection_id, provider, external_registration_id, callback_url, config_digest, status, generation, expires_at, renew_after, last_error_code, terminal_alert_generation, created_at, updated_at";
export class JiraWebhookRegistrationRepository {
  public async findByRegistrationId(
    q: Queryable,
    registrationId: string,
  ): Promise<JiraWebhookRegistrationRow | null> {
    const valid = id.safeParse(registrationId);
    if (!valid.success) throw new Error("invalid jira registration id");
    const result = await q.query<JiraWebhookRegistrationRow>(
      `SELECT ${columns} FROM jira_webhook_registrations WHERE registration_id=$1`,
      [valid.data],
    );
    return result.rows[0] ?? null;
  }
  public async findScoped(
    q: Queryable,
    ownerId: string,
    connectionId: string,
  ): Promise<JiraWebhookRegistrationRow | null> {
    const valid = z
      .strictObject({ ownerId: id, connectionId: id })
      .safeParse({ ownerId, connectionId });
    if (!valid.success) throw new Error("invalid jira registration scope");
    const result = await q.query<JiraWebhookRegistrationRow>(
      `SELECT ${columns} FROM jira_webhook_registrations WHERE owner_id=$1 AND connection_id=$2 AND provider='jira'`,
      [valid.data.ownerId, valid.data.connectionId],
    );
    return result.rows[0] ?? null;
  }
  public async upsert(tx: Transaction, input: unknown): Promise<JiraWebhookRegistrationRow> {
    const valid = registrationInput.safeParse(input);
    if (!valid.success) throw new Error("invalid jira registration");
    const v = valid.data;
    const result = await tx.query<JiraWebhookRegistrationRow>(
      `INSERT INTO jira_webhook_registrations (${columns}) VALUES ($1,$2,$3,'jira',$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now()) ON CONFLICT (owner_id,connection_id,provider) DO UPDATE SET external_registration_id=EXCLUDED.external_registration_id, callback_url=EXCLUDED.callback_url, config_digest=EXCLUDED.config_digest, status=EXCLUDED.status, generation=EXCLUDED.generation, expires_at=EXCLUDED.expires_at, renew_after=EXCLUDED.renew_after, last_error_code=EXCLUDED.last_error_code, terminal_alert_generation=EXCLUDED.terminal_alert_generation RETURNING ${columns}`,
      [
        v.registrationId,
        v.ownerId,
        v.connectionId,
        v.externalRegistrationId ?? null,
        v.callbackUrl,
        v.configDigest,
        v.status,
        v.generation,
        v.expiresAt ?? null,
        v.renewAfter ?? null,
        v.lastErrorCode ?? null,
        v.terminalAlertGeneration ?? null,
      ],
    );
    return result.rows[0]!;
  }
  public async markRenewing(
    tx: Transaction,
    ownerId: string,
    connectionId: string,
    now: Date,
  ): Promise<JiraWebhookRegistrationRow | null> {
    const valid = z
      .strictObject({ ownerId: id, connectionId: id })
      .safeParse({ ownerId, connectionId });
    if (!valid.success) throw new Error("invalid jira registration scope");
    const result = await tx.query<JiraWebhookRegistrationRow>(
      `UPDATE jira_webhook_registrations SET status='RENEWING', updated_at=now() WHERE owner_id=$1 AND connection_id=$2 AND provider='jira' AND status IN ('ACTIVE','RENEWAL_DUE') AND renew_after <= $3 RETURNING ${columns}`,
      [valid.data.ownerId, valid.data.connectionId, now],
    );
    return result.rows[0] ?? null;
  }
  public async markActive(
    tx: Transaction,
    registrationId: string,
    generation: number,
    externalId: string,
    expiresAt: Date,
    renewAfter: Date,
  ): Promise<JiraWebhookRegistrationRow> {
    const valid = z
      .strictObject({
        registrationId: id,
        generation: z.int().min(1),
        externalId: id,
        expiresAt: z.date(),
        renewAfter: z.date(),
      })
      .safeParse({ registrationId, generation, externalId, expiresAt, renewAfter });
    if (!valid.success) throw new Error("invalid jira active registration");
    const result = await tx.query<JiraWebhookRegistrationRow>(
      `UPDATE jira_webhook_registrations SET status='ACTIVE', external_registration_id=$3, expires_at=$4, renew_after=$5, last_error_code=NULL, updated_at=now() WHERE registration_id=$1 AND generation=$2 RETURNING ${columns}`,
      [
        valid.data.registrationId,
        valid.data.generation,
        valid.data.externalId,
        valid.data.expiresAt,
        valid.data.renewAfter,
      ],
    );
    if (!result.rows[0]) throw new Error("stale jira registration generation");
    return result.rows[0];
  }
  public async markReconciling(
    tx: Transaction,
    registrationId: string,
    generation: number,
  ): Promise<void> {
    const valid = z
      .strictObject({ registrationId: id, generation: z.int().min(1) })
      .safeParse({ registrationId, generation });
    if (!valid.success) throw new Error("invalid jira registration generation");
    const result = await tx.query(
      `UPDATE jira_webhook_registrations SET status='RECONCILING', updated_at=now() WHERE registration_id=$1 AND generation=$2`,
      [valid.data.registrationId, valid.data.generation],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("stale jira registration generation");
  }
  public async markRegistering(
    tx: Transaction,
    registrationId: string,
    generation: number,
  ): Promise<void> {
    const result = await tx.query(
      `UPDATE jira_webhook_registrations SET status='REGISTERING', updated_at=now() WHERE registration_id=$1 AND generation=$2`,
      [registrationId, generation],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("stale jira registration generation");
  }
  public async markTerminalFailed(
    tx: Transaction,
    registrationId: string,
    generation: number,
    errorCode: string,
  ): Promise<boolean> {
    const valid = z
      .strictObject({
        registrationId: id,
        generation: z.int().min(1),
        errorCode: z.string().trim().min(1).max(128),
      })
      .safeParse({ registrationId, generation, errorCode });
    if (!valid.success) throw new Error("invalid jira terminal failure");
    const result = await tx.query(
      `UPDATE jira_webhook_registrations SET status='FAILED', last_error_code=$3, terminal_alert_generation=$2, updated_at=now() WHERE registration_id=$1 AND generation=$2 AND (terminal_alert_generation IS NULL OR terminal_alert_generation <> $2)`,
      [valid.data.registrationId, valid.data.generation, valid.data.errorCode],
    );
    if ((result.rowCount ?? 0) === 1) return true;
    const current = await this.findByRegistrationId(tx, valid.data.registrationId);
    if (!current || current.generation !== valid.data.generation)
      throw new Error("stale jira registration generation");
    return false;
  }
}
