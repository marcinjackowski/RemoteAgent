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
    await q.query(
      "INSERT INTO workspaces (workspace_id, case_id, repo, base_sha, branch_name, tree_digest) VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT (workspace_id) DO NOTHING",
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
