/**
 * Server-owned agent configuration (RA-032).
 *
 * The model a role runs on is chosen by the operator, never by the model (AGENTS.md §4), and is
 * resolved at run dispatch — not fixed in a process env var. `resolveModelId` reads `model_id`
 * from the `agent_config` table, and falls back to env (`BEDROCK_MODEL_ID`, then `RA_MODEL_ID`)
 * only as a bootstrap default when nothing is configured.
 */
import type { Queryable } from "../client.js";
import { translatePgError } from "../client.js";

export const MODEL_ID_KEY = "model_id";

/**
 * Bootstrap default. Uses the `us.` INFERENCE PROFILE id: verified live (2026-08-24) that the bare
 * `anthropic.claude-sonnet-4-5-...` id fails on-demand with a Bedrock ValidationException
 * ("isn't supported ... Retry with the ID or ARN of an inference profile"). The profile id works.
 */
export const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

export class AgentConfigRepository {
  public async get(q: Queryable, key: string): Promise<string | null> {
    const r = await q.query<{ value: string }>(`SELECT value FROM agent_config WHERE key = $1`, [
      key,
    ]);
    return r.rows[0]?.value ?? null;
  }

  /** Upsert a server-owned config value. */
  public async set(q: Queryable, key: string, value: string): Promise<void> {
    try {
      await q.query(
        `INSERT INTO agent_config (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value],
      );
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }
}

type Env = Record<string, string | undefined>;

/**
 * Resolve the model id: DB config first, then env bootstrap (`BEDROCK_MODEL_ID` or `RA_MODEL_ID`),
 * then the built-in default. So a deployment can change the model at runtime by setting the DB row,
 * with no restart and no code change.
 */
export async function resolveModelId(q: Queryable, env: Env = process.env): Promise<string> {
  const fromDb = await new AgentConfigRepository().get(q, MODEL_ID_KEY);
  if (fromDb !== null && fromDb.trim() !== "") return fromDb.trim();
  const fromEnv = (env.BEDROCK_MODEL_ID ?? env.RA_MODEL_ID)?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_MODEL_ID;
}
