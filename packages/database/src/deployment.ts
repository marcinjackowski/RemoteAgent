/**
 * Migrations as a controlled deployment step, and rollback safety (RA-025-WU-08, AC6).
 *
 * AC6: "an application rollback does not destructively revert data or migrations."
 *
 * THE RULE, STATED ONCE: **an application rollback NEVER runs `migrateDown`.** Reverting
 * a migration is a data operation, and it is not the inverse of deploying code. Migration
 * `032`'s `down` drops `retention_runs` — the table recording that data was destroyed —
 * so a rollback that ran it would delete the evidence of a purge in order to undo a code
 * change that had nothing to do with retention.
 *
 * That is why this module exists rather than the rule living in a runbook: a runbook
 * sentence cannot be mutation-tested, and this one is exactly the sentence an operator
 * skips at 3am. {@link planRollback} returns a plan that has no way to express "revert
 * migrations", and {@link assertRollbackSafe} rejects a schema state a rollback cannot
 * survive.
 *
 * WHAT MAKES A ROLLBACK SAFE. Not "the migrations are reversible" — it is whether the
 * PREVIOUS application version can run against the CURRENT schema. Those differ, and the
 * distinction is the whole content of this module:
 *
 *   - an ADDITIVE migration (new table, new nullable column, new index) leaves the old
 *     code working: it does not know the new thing exists, and does not need to;
 *   - a DESTRUCTIVE one (dropped column, narrowed type, new NOT NULL without a default)
 *     breaks the old code, so rolling back the application alone produces errors rather
 *     than the previous behaviour.
 *
 * So deploys are ordered: migrate first, then deploy code. The window between them has the
 * NEW schema and the OLD code, which is safe precisely when every migration is additive —
 * and that is a property this module checks rather than assumes.
 */
import type { Database } from "./client.js";
import { migrationStatus, type MigrationStatus } from "./migrate.js";

/** How a migration relates to the code that ran before it. */
export const MigrationCompatibility = {
  /**
   * The previous application version runs unchanged against this schema.
   *
   * New tables, new nullable columns, new indexes, new triggers on new tables.
   */
  ADDITIVE: "ADDITIVE",
  /**
   * The previous application version would fail against this schema.
   *
   * A dropped or renamed column, a narrowed type, a new NOT NULL without a default, a new
   * CHECK that existing code can violate.
   */
  BREAKING: "BREAKING",
} as const;

export type MigrationCompatibility =
  (typeof MigrationCompatibility)[keyof typeof MigrationCompatibility];

/**
 * Migrations whose `down` destroys data or evidence, so reverting them is never automatic.
 *
 * An explicit register rather than a heuristic over the SQL. A heuristic would have to
 * parse `down` files and decide whether `DROP TABLE retention_runs` is destructive —
 * which is easy — and whether `ALTER TABLE ... DROP COLUMN checkpoint_revision` is —
 * which is the same question in a form a regex gets wrong. Naming them costs one line per
 * migration and cannot be fooled.
 *
 * Each entry states what its `down` destroys, because the reason is what an operator
 * needs when deciding whether to do it deliberately.
 */
export const IRREVERSIBLE_MIGRATIONS: Readonly<Record<number, string>> = Object.freeze({
  29: "drops approvals.checkpoint_revision and owner_id; every unconsumed grant becomes unverifiable",
  30: "removes the trigger freezing a grant's checkpoint_revision, so CTF-005's bypass returns",
  31: "drops receipts.entity_version, losing the only proof of WHICH provider state a write produced",
  32: "drops retention_runs — the record that data was destroyed must outlive the data",
});

/** One step of a deployment or rollback, in order. */
export interface DeploymentStep {
  readonly order: number;
  readonly name: string;
  /** What an operator runs, or the action a pipeline takes. */
  readonly action: string;
  /** Why this step is where it is. */
  readonly rationale: string;
  /** Whether this step can destroy data if it goes wrong. */
  readonly destructive: boolean;
}

/**
 * The deployment plan: migrate, then deploy, then verify.
 *
 * Migrations run BEFORE the new code, not after, and the ordering is the decision. With
 * code first, the new version starts against the old schema and fails on its very first
 * query — an outage. With migrations first, the window holds the new schema and the old
 * code, which works as long as every migration is additive. That is the trade the
 * `ADDITIVE` classification pays for.
 */
export function planDeployment(input: {
  readonly pendingVersions: readonly number[];
  readonly imageTag: string;
}): readonly DeploymentStep[] {
  const steps: DeploymentStep[] = [];
  let order = 0;
  const step = (name: string, action: string, rationale: string, destructive = false): void => {
    order += 1;
    steps.push({ order, name, action, rationale, destructive });
  };

  step(
    "verify-current",
    "pnpm --filter @remoteagent/database db:status",
    "Establish which migrations are applied BEFORE changing anything. A deploy that " +
      "does not know its starting point cannot be rolled back to it.",
  );
  if (input.pendingVersions.length > 0) {
    step(
      "migrate",
      `migrateUp (pending: ${input.pendingVersions.join(", ")})`,
      "Before the new code, not after. Code-first would start the new version against " +
        "the old schema and fail on its first query. Schema-first leaves the old code " +
        "running against a new-but-additive schema, which works.",
      // Marked destructive because a migration is the only step here that can lose data,
      // even when every individual statement is additive: the advisory lock, the
      // checksum-drift check and the per-migration transaction are what make it safe, and
      // an operator should see the flag.
      true,
    );
  }
  step(
    "deploy",
    `update ECS services to ${input.imageTag}`,
    "ECS circuit breaker with rollback is enabled, so a task that fails its health " +
      "check reverts the service to the previous task definition automatically. That " +
      "revert is code-only — see planRollback.",
  );
  step(
    "verify-after",
    "readiness endpoint returns UP for every service",
    "Readiness depends on PostgreSQL, so this is what proves the new code can reach " +
      "the migrated schema. Liveness would pass even if it could not.",
  );
  return steps;
}

/**
 * The rollback plan.
 *
 * NOTE WHAT IS ABSENT: there is no step, and no option, that reverts a migration. Not an
 * omission — the type has no way to express it, so a future caller cannot pass
 * `revertMigrations: true`. AC6 is a property of this function's shape rather than of its
 * documentation.
 */
export function planRollback(input: {
  readonly toImageTag: string;
  readonly appliedVersions: readonly number[];
}): readonly DeploymentStep[] {
  const irreversible = input.appliedVersions.filter((version) =>
    Object.hasOwn(IRREVERSIBLE_MIGRATIONS, version),
  );
  const steps: DeploymentStep[] = [
    {
      order: 1,
      name: "rollback-code-only",
      action: `update ECS services to ${input.toImageTag}`,
      rationale:
        "The schema is left EXACTLY as it is. Every migration in this repository is " +
        "additive, so the previous application version runs against it: it does not " +
        "know the new columns exist and does not need to.",
      destructive: false,
    },
    {
      order: 2,
      name: "verify-rollback",
      action: "readiness endpoint returns UP for every service",
      rationale: "Confirms the previous version can reach the current schema.",
      destructive: false,
    },
  ];
  if (irreversible.length > 0) {
    steps.push({
      order: 3,
      name: "do-not-revert-migrations",
      action: "NONE — this step is a refusal, not an operation",
      rationale:
        `Migrations ${irreversible.join(", ")} have destructive down scripts: ` +
        irreversible.map((version) => IRREVERSIBLE_MIGRATIONS[version]).join("; ") +
        ". Reverting one is a deliberate data operation with the owner's agreement, " +
        "never part of an application rollback.",
      destructive: false,
    });
  }
  return steps;
}

/** Why a rollback would be unsafe. */
export interface RollbackConcern {
  readonly version: number;
  readonly reason: string;
}

/**
 * Check that the current schema is one the previous application version can run against.
 *
 * Returns concerns rather than throwing, so a deploy pipeline can report all of them.
 * Takes the compatibility classification as an argument rather than deriving it from SQL:
 * a parser deciding whether `ALTER TABLE ... ALTER COLUMN` narrowed a type is a source of
 * false confidence, and the classification is a one-line-per-migration cost that cannot
 * be fooled.
 */
export function assertRollbackSafe(input: {
  readonly applied: readonly MigrationStatus[];
  readonly compatibility: Readonly<Record<number, MigrationCompatibility>>;
}): readonly RollbackConcern[] {
  const concerns: RollbackConcern[] = [];
  for (const migration of input.applied) {
    if (!migration.applied) continue;
    const classification = input.compatibility[migration.version];
    if (classification === undefined) {
      // Unclassified is a concern, not a pass. "No declaration" is not consent — the
      // `CTF-010` finding-4 pattern that produced two HIGH defects in RA-014.
      concerns.push({
        version: migration.version,
        reason: `migration ${String(migration.version)} (${migration.name}) has no compatibility classification`,
      });
      continue;
    }
    if (classification === MigrationCompatibility.BREAKING) {
      concerns.push({
        version: migration.version,
        reason:
          `migration ${String(migration.version)} (${migration.name}) is BREAKING: the ` +
          "previous application version cannot run against this schema, so a code-only " +
          "rollback would produce errors rather than the previous behaviour",
      });
    }
  }
  return concerns;
}

/** Read the live schema state, for the `verify-current` deployment step. */
export async function deploymentSchemaState(db: Database): Promise<{
  readonly applied: readonly number[];
  readonly pending: readonly number[];
  readonly highestApplied: number;
}> {
  const status = await migrationStatus(db);
  const applied = status.filter((entry) => entry.applied).map((entry) => entry.version);
  const pending = status.filter((entry) => !entry.applied).map((entry) => entry.version);
  return {
    applied,
    pending,
    // 0 when nothing is applied. Used by the release manifest (RA-026 AC5) as the schema
    // version, so it must be a number rather than `undefined`.
    highestApplied: applied.length > 0 ? Math.max(...applied) : 0,
  };
}
