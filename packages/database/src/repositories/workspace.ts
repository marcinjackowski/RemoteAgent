import type { Queryable } from "../client.js";

export type WorkspaceRow = Readonly<{
  workspace_id: string;
  case_id: string;
  repo: string;
  base_sha: string | null;
  branch_name: string | null;
  tree_digest: string | null;
  status: "ACTIVE" | "ARCHIVED";
}>;

export class WorkspaceMappingConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceMappingConflictError";
  }
}

export class WorkspaceRepository {
  public async find(q: Queryable, workspaceId: string): Promise<WorkspaceRow | null> {
    const result = await q.query<WorkspaceRow>(
      "SELECT workspace_id, case_id, repo, base_sha, branch_name, tree_digest, status FROM workspaces WHERE workspace_id = $1",
      [workspaceId],
    );
    return result.rows[0] ?? null;
  }

  public async recordIntent(
    q: Queryable,
    input: {
      workspaceId: string;
      caseId: string;
      repo: string;
      baseSha: string;
      branchName: string;
    },
  ): Promise<WorkspaceRow> {
    // `ON CONFLICT DO NOTHING` with NO conflict target, deliberately.
    //
    // This table has TWO unique constraints: `workspace_id` (primary key) and
    // `case_id` (at most one active workspace per case, the single-writer
    // invariant). The original `ON CONFLICT (workspace_id)` covered only the first,
    // so a concurrent insert that lost the race on `workspaces_case_id_key` raised an
    // unhandled `23505` instead of being absorbed — it escaped as a raw driver error
    // rather than as `WorkspaceMappingConflictError`.
    //
    // That is the diagnosis of `CTF-012`, the flake this registry recorded as
    // "undiagnosed, could not capture the message" across ~15 runs. Captured at last
    // during the RA-024 gate:
    //
    //     duplicate key value violates unique constraint "workspaces_case_id_key"
    //       at WorkspaceRepository.recordIntent (workspace.ts:39)
    //
    // It reproduced only in a full-repo run because it needs two inserts genuinely
    // in flight, which is why 5/5 solo runs were green.
    //
    // An untargeted `DO NOTHING` is the correct absorber rather than a wider one: the
    // verification below re-reads the row and rejects anything that does not match
    // this exact intent, so a DIFFERENT workspace claiming the same case still fails
    // — `find` returns null for the requested id and the mapping check throws. The
    // insert is allowed to be a no-op; it is never allowed to be an unexamined
    // success.
    await q.query(
      "INSERT INTO workspaces (workspace_id, case_id, repo, base_sha, branch_name, tree_digest) VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT DO NOTHING",
      [input.workspaceId, input.caseId, input.repo, input.baseSha, input.branchName],
    );
    const current = await this.find(q, input.workspaceId);
    if (
      !current ||
      current.case_id !== input.caseId ||
      current.repo !== input.repo ||
      current.base_sha !== input.baseSha ||
      current.branch_name !== input.branchName
    )
      throw new WorkspaceMappingConflictError("Workspace intent conflicts with existing mapping");
    return current;
  }

  public async finalizeDigest(
    q: Queryable,
    mapping: {
      workspaceId: string;
      caseId: string;
      repo: string;
      baseSha: string;
      branchName: string;
    },
    digest: string,
  ): Promise<boolean> {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest))
      throw new WorkspaceMappingConflictError("Invalid workspace digest");
    const result = await q.query(
      "UPDATE workspaces SET tree_digest = $6 WHERE workspace_id = $1 AND case_id = $2 AND repo = $3 AND base_sha = $4 AND branch_name = $5 AND tree_digest IS NULL",
      [
        mapping.workspaceId,
        mapping.caseId,
        mapping.repo,
        mapping.baseSha,
        mapping.branchName,
        digest,
      ],
    );
    return result.rowCount === 1;
  }
}
