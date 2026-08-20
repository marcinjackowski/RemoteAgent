import { caseCheckpoint, type CaseCheckpoint } from "@remoteagent/contracts";
import { SecretRedactor } from "@remoteagent/observability";

export const CHECKPOINT_RENDER_MAX_LENGTH = 65_536;

export const CheckpointRenderErrorCode = {
  INVALID_CHECKPOINT: "INVALID_CHECKPOINT",
} as const;

export type CheckpointRenderErrorCode =
  (typeof CheckpointRenderErrorCode)[keyof typeof CheckpointRenderErrorCode];

export class CheckpointRenderError extends Error {
  public constructor(
    message: string,
    public readonly code: CheckpointRenderErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CheckpointRenderError";
  }
}

const redactor = new SecretRedactor();

function text(value: string): string {
  return redactor
    .redactString(value)
    .replace(/[\r\n]+/g, " ⏎ ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}[\]()#+.!|>~])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

// Keep mention-like markup inert without preserving a Discord-resolvable token.
function safeText(value: string): string {
  return text(value);
}

function section(title: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`## ${title}`, ...values.map((value) => `- ${safeText(value)}`), ""];
}

function line(label: string, value: string): string {
  return `- **${label}:** ${safeText(value)}`;
}

function render(checkpoint: CaseCheckpoint): string {
  const lines: string[] = [
    `# Case checkpoint: ${safeText(checkpoint.case_id)}`,
    "",
    line("Revision", String(checkpoint.revision)),
    line("Schema version", String(checkpoint.schema_version)),
    line("Goal", checkpoint.goal),
    line("Phase", checkpoint.current_phase),
    line("Summary trust", checkpoint.summary.trust),
    line("Summary", checkpoint.summary.value),
    line("Plan revision", String(checkpoint.plan_revision)),
    "",
  ];
  lines.push(...section("Completed work", checkpoint.completed_work));
  lines.push(...section("Decisions", checkpoint.decisions));
  lines.push(...section("Assumptions", checkpoint.assumptions));
  if (checkpoint.evidence.length > 0) {
    lines.push(
      "## Evidence",
      ...checkpoint.evidence.map(
        (item) =>
          `- **${safeText(item.kind)}:** ${safeText(item.reference)}${item.summary === undefined ? "" : ` — ${safeText(item.summary)}`}`,
      ),
      "",
    );
  }
  lines.push(...section("Open questions", checkpoint.open_questions));
  lines.push(...section("Next actions", checkpoint.next_actions));
  lines.push(...section("Blockers", checkpoint.blockers));
  lines.push(...section("Pending approvals", checkpoint.pending_approvals));

  const workspace = checkpoint.workspace_state;
  lines.push(
    "## Workspace",
    line("Tree digest", workspace.tree_digest ?? "none"),
    line("Base SHA", workspace.base_sha ?? "none"),
    "",
  );
  const branch = checkpoint.branch_state;
  lines.push(
    "## Branch",
    line("Name", branch.branch_name ?? "none"),
    line("Ahead", String(branch.ahead)),
    line("Behind", String(branch.behind)),
    "",
  );
  if (checkpoint.test_runs.length > 0) {
    lines.push(
      "## Tests",
      ...checkpoint.test_runs.map(
        (test) =>
          `- **${safeText(test.command)}** — exit ${test.exit_code}; ${safeText(test.summary)} (${safeText(test.ran_at)})`,
      ),
      "",
    );
  }
  lines.push(...section("Snapshot changes", checkpoint.snapshot_changes));
  lines.push(...section("Review findings", checkpoint.review_findings));
  if (
    checkpoint.merge_request_state.mr_ref !== null ||
    checkpoint.merge_request_state.status !== null
  ) {
    lines.push(
      "## Merge request",
      line("Reference", checkpoint.merge_request_state.mr_ref ?? "none"),
      line("Status", checkpoint.merge_request_state.status ?? "none"),
      "",
    );
  }
  if (checkpoint.external_state_versions.length > 0) {
    lines.push(
      "## External state versions",
      ...checkpoint.external_state_versions.map(
        (item) => `- ${safeText(item.entity_ref)}: ${safeText(item.version)}`,
      ),
      "",
    );
  }
  if (checkpoint.last_event_id !== null) lines.push(line("Last event", checkpoint.last_event_id));
  if (checkpoint.last_run_id !== null) lines.push(line("Last run", checkpoint.last_run_id));
  lines.push(line("Updated at", checkpoint.updated_at));
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderCheckpointMarkdown(input: unknown): string {
  const parsed = caseCheckpoint.safeParse(input);
  if (!parsed.success) {
    throw new CheckpointRenderError(
      "Checkpoint does not satisfy the CaseCheckpoint contract",
      CheckpointRenderErrorCode.INVALID_CHECKPOINT,
    );
  }
  const output = render(parsed.data);
  if (output.length <= CHECKPOINT_RENDER_MAX_LENGTH) return output;
  const marker = "\n… (truncated)";
  return output.slice(0, CHECKPOINT_RENDER_MAX_LENGTH - marker.length) + marker;
}
