/**
 * Scheduler task: enqueue `jira.reconcile` jobs for configured projects (RA-029-WU-04).
 *
 * Respects the scheduler contract (`scheduler.ts`): a task SCANS for due work and ENQUEUES a
 * job — it never calls a provider. The reconciliation REST read runs in the worker under a
 * lease (`apps/agent-worker/src/jira-reconcile.ts`).
 *
 * DEDUPE, like the renewal scan. If a reconcile job for a project is already PENDING, LEASED or
 * RECONCILING, another is not enqueued — otherwise a reconcile slower than the tick interval
 * would pile up a backlog of duplicate scans. Correctness does not depend on it (the reconciler
 * is idempotent on its watermark), but backlog control does.
 */
import { JobStore, JobType, type Database } from "@remoteagent/database";

import type { SchedulerTask } from "./scheduler.js";

export interface JiraReconcileProject {
  readonly ownerId: string;
  readonly connectionId: string;
  readonly projectKey: string;
}

type Env = Record<string, string | undefined>;

/**
 * Parse the reconcile projects from the environment. Single-owner: one project via
 * `JIRA_PROJECT_KEY` (owner/connection default to match the worker's `jira-auth`). Absent
 * `JIRA_PROJECT_KEY` = no projects, so the scheduler registers no reconcile task.
 */
export function jiraReconcileProjectsFromEnv(env: Env = process.env): JiraReconcileProject[] {
  const projectKey = env.JIRA_PROJECT_KEY?.trim();
  if (projectKey === undefined || projectKey === "") return [];
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(projectKey)) {
    throw new Error(`JIRA_PROJECT_KEY must match ^[A-Z][A-Z0-9_]{0,127}$, got ${projectKey}`);
  }
  return [
    {
      ownerId: env.JIRA_OWNER_ID?.trim() || "owner-local",
      connectionId: env.JIRA_CONNECTION_ID?.trim() || "connection-local-jira",
      projectKey,
    },
  ];
}

export function createJiraReconcileTask(input: {
  readonly db: Database;
  readonly jobs: JobStore;
  readonly projects: readonly JiraReconcileProject[];
}): SchedulerTask {
  return {
    name: "jira.reconcile",
    run: async (): Promise<void> => {
      for (const project of input.projects) {
        const existing = await input.db.query(
          `SELECT job_id FROM jobs
             WHERE job_type = $1 AND status IN ('PENDING','LEASED','RECONCILING')
               AND payload->>'connectionId' = $2 AND payload->>'projectKey' = $3`,
          [JobType.JIRA_RECONCILE, project.connectionId, project.projectKey],
        );
        if (existing.rows.length > 0) continue;
        await input.jobs.enqueue(input.db, {
          jobType: JobType.JIRA_RECONCILE,
          payload: {
            ownerId: project.ownerId,
            connectionId: project.connectionId,
            projectKey: project.projectKey,
          },
          caseId: null,
          // No case: serialize per connection+project so two reconciles never run concurrently.
          serializationKey: `jira.reconcile:${project.connectionId}:${project.projectKey}`,
          provider: "jira",
        });
      }
    },
  };
}
