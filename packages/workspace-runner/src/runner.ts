import type {
  WorkspaceCreateInput,
  WorkspaceCreateResult,
  WorkspaceDestroyInput,
  WorkspaceDestroyResult,
  WorkspaceResumeInput,
  WorkspaceResumeResult,
  WorkspaceSnapshotInput,
  WorkspaceSnapshotResult,
} from "./types.js";

/**
 * Adapter-neutral workspace lifecycle. No method accepts a filesystem path,
 * repository credential, or model-provided host detail.
 */
export interface WorkspaceRunner {
  create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult>;
  resume(input: WorkspaceResumeInput): Promise<WorkspaceResumeResult>;
  snapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult>;
  destroy(input: WorkspaceDestroyInput): Promise<WorkspaceDestroyResult>;
}
