/**
 * Remote writes: push a case branch and create-or-update a draft merge request.
 *
 * **Criterion 2: retrying push or create-MR never produces a duplicate.** The MR is
 * addressed by `(project_id, source_branch, target_branch)`, which is the identity
 * GitLab itself enforces for an open MR. So {@link GitLabMergeRequestPublisher.publish}
 * always looks first and creates only on a genuine absence; a retry finds the
 * existing MR and reports `created: false`. Crucially the search runs against the
 * REMOTE rather than a local record — a local "already created" flag is exactly what
 * a crash between the create call and the flag write invalidates.
 *
 * **Criterion 3: the token never reaches the model, command output or a logged URL.**
 * Three separate leak channels, three separate defences:
 *
 * 1. *the remote URL*: `gitlabRemote` refuses userinfo, so the
 *    `https://oauth2:TOKEN@host/repo.git` shape cannot be stored or passed. The token
 *    is supplied to Git through {@link CredentialBroker} as an out-of-band header,
 *    never spliced into the URL;
 * 2. *process output*: {@link redactGitLabOutput} runs over every stdout, stderr and
 *    error message this module emits, using `redactCommandOutput` from
 *    `implementation-tools` plus the known token literal;
 * 3. *the return values*: no type in this module carries a credential field, so
 *    there is nothing for a caller to accidentally log.
 *
 * The broker returns a short-lived value through a callback and never exposes it as a
 * property, so a token cannot be read off an object that happens to be serialized.
 *
 * **Writes are off by default.** {@link GitLabProjectRef.writes_enabled} comes from
 * the server-owned allowlist and defaults to false, so a project must be explicitly
 * configured as a write target. Nothing a model sends can flip it.
 */
import { redactCommandOutput } from "@remoteagent/implementation-tools";

import {
  GITLAB_CREDENTIAL_IN_URL,
  GITLAB_WRITES_DISABLED,
  GitLabConnectorError,
  gitlabMergeRequestIntent,
  gitlabMergeRequestRecord,
} from "./contracts.js";
import type {
  GitLabMergeRequestIntent,
  GitLabMergeRequestRecord,
  GitLabProjectRef,
} from "./contracts.js";

/**
 * Supplies a credential for exactly one operation.
 *
 * `use` hands the value to a callback rather than returning it, so the token has no
 * resting place on an object that could be logged or serialized. The broker is the
 * only component in this package that ever sees it.
 */
export interface CredentialBroker {
  use<T>(scope: { projectId: number }, fn: (token: string) => Promise<T>): Promise<T>;
  /** The literal, for redaction only. Implementations may return `[]`. */
  redactionLiterals(): readonly string[];
}

/** Redact anything this module is about to emit or log. */
export function redactGitLabOutput(value: string, broker: CredentialBroker): string {
  return redactCommandOutput(value, broker.redactionLiterals());
}

/**
 * Assert a URL carries no credentials before it is used or reported.
 *
 * Defence in depth: `gitlabRemote` already refuses userinfo at the contract
 * boundary, but a remote can also arrive from a webhook payload or an API response,
 * and those are not validated by that schema.
 */
export function assertNoCredentialInUrl(url: string): void {
  try {
    const parsed = new URL(url);
    // Userinfo AND the query/fragment. An audit probe showed
    // `?private_token=glpat-...` passing this check: it is a documented GitLab
    // authentication method, so treating only userinfo as "the credential part of a
    // URL" leaves the easier channel open. A clone or web URL needs neither.
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      // The URL itself is deliberately NOT included in the message: it contains the
      // credential this error exists to report.
      throw new GitLabConnectorError(
        GITLAB_CREDENTIAL_IN_URL,
        "remote URL carries credentials, a query string or a fragment",
      );
    }
  } catch (error) {
    if (error instanceof GitLabConnectorError) throw error;
    // Not a parseable absolute URL (SCP syntax); no userinfo field to leak.
  }
}

/** Minimal GitLab REST surface this connector needs. Implemented by a real client. */
export interface GitLabApi {
  /** Open MRs matching the branch pair. Empty when none. */
  findMergeRequests(input: {
    projectId: number;
    sourceBranch: string;
    targetBranch: string;
    token: string;
  }): Promise<readonly GitLabMergeRequestRecord[]>;
  createMergeRequest(input: {
    projectId: number;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    token: string;
  }): Promise<GitLabMergeRequestRecord>;
  updateMergeRequest(input: {
    projectId: number;
    mergeRequestIid: number;
    description: string;
    token: string;
  }): Promise<GitLabMergeRequestRecord>;
}

/** Pushes a branch. Separated so the credential path is testable in isolation. */
export interface BranchPusher {
  /**
   * Push `branch` to the project remote.
   *
   * Receives the token as an argument rather than reading it from the URL, which is
   * what keeps it out of `git remote -v` and out of Git's error text.
   */
  push(input: {
    remote: string;
    branch: string;
    headSha: string;
    token: string;
  }): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Render the MR description from real evidence.
 *
 * Criterion 6. Every section is populated from the intent, and the evidence
 * sections are unconditional: a change with no risks says "None known" rather than
 * omitting the heading, because a missing section reads as "not considered" while an
 * explicit "none" is a claim someone can be held to.
 */
export function renderMergeRequestDescription(
  intent: GitLabMergeRequestIntent,
  broker?: CredentialBroker,
): string {
  /**
   * Redact the prose fields.
   *
   * `task_summary` and `unresolved_risks` are the only model-authored text in this
   * package, and this description is PUBLISHED to a remote where it cannot be
   * unpublished. An audit probe put a token in `task_summary` and watched it reach
   * the rendered output verbatim. Redacting here covers that channel and also the
   * likelier accident: a summary quoting a command whose output contained an
   * absolute host path.
   */
  const safe = (value: string): string =>
    redactCommandOutput(value, broker?.redactionLiterals() ?? []);

  const risks =
    intent.unresolved_risks.length === 0
      ? "None known."
      : intent.unresolved_risks.map((risk) => `- ${safe(risk)}`).join("\n");

  return [
    "## What and why",
    "",
    safe(intent.task_summary),
    "",
    "## Test evidence",
    "",
    `Head commit: \`${intent.head_sha}\``,
    "",
    ...intent.test_receipts.map((receipt) => `- \`${receipt}\``),
    "",
    "## Review",
    "",
    `Readiness: \`${intent.review_readiness}\``,
    "",
    "## Unresolved risks",
    "",
    risks,
    "",
    `_Case \`${intent.case_id}\`. Draft until a human marks it ready._`,
  ].join("\n");
}

export type GitLabPublisherOptions = Readonly<{
  api: GitLabApi;
  pusher: BranchPusher;
  broker: CredentialBroker;
}>;

export type GitLabPublishResult = Readonly<{
  mergeRequest: GitLabMergeRequestRecord;
  /** Redacted push output, safe to log or show a model. */
  pushOutput: string;
}>;

/**
 * Push a branch and create-or-update its draft MR, idempotently.
 */
export class GitLabMergeRequestPublisher {
  readonly #api: GitLabApi;
  readonly #pusher: BranchPusher;
  readonly #broker: CredentialBroker;

  public constructor(options: GitLabPublisherOptions) {
    this.#api = options.api;
    this.#pusher = options.pusher;
    this.#broker = options.broker;
  }

  /**
   * Publish the case branch as a draft MR.
   *
   * The project must be allowlisted — enforced by the type of `project`, which only
   * the allowlist can produce — and must have writes explicitly enabled.
   */
  public async publish(
    project: GitLabProjectRef,
    rawIntent: GitLabMergeRequestIntent,
  ): Promise<GitLabPublishResult> {
    if (!project.writes_enabled) {
      // Off by default: a project is a write target only when the server says so.
      throw new GitLabConnectorError(
        GITLAB_WRITES_DISABLED,
        `remote writes are not enabled for ${project.path_with_namespace}`,
      );
    }
    const intent = gitlabMergeRequestIntent.parse(rawIntent);
    assertNoCredentialInUrl(project.remote);
    const description = renderMergeRequestDescription(intent, this.#broker);

    return this.#broker.use({ projectId: project.project_id }, async (token) => {
      let pushOutput: string;
      try {
        const pushed = await this.#pusher.push({
          remote: project.remote,
          branch: intent.source_branch,
          headSha: intent.head_sha,
          token,
        });
        // Redacted before it is returned, so a caller cannot log a raw stream even
        // by accident.
        pushOutput = redactGitLabOutput(`${pushed.stdout}\n${pushed.stderr}`, this.#broker);
      } catch (error) {
        // Git error text routinely contains the remote URL and sometimes the
        // credential; only a redacted message travels.
        throw new GitLabConnectorError(
          "PUSH_FAILED",
          redactGitLabOutput(error instanceof Error ? error.message : String(error), this.#broker),
        );
      }

      // Look on the REMOTE first. A local "created" flag would be wrong after a
      // crash between the create call and the flag write — the MR would exist while
      // the record said otherwise, and a retry would try to create a second one.
      const existing = await this.#api.findMergeRequests({
        projectId: project.project_id,
        sourceBranch: intent.source_branch,
        targetBranch: intent.target_branch,
        token,
      });

      const found = existing[0];
      const record =
        found === undefined
          ? await this.#api.createMergeRequest({
              projectId: project.project_id,
              sourceBranch: intent.source_branch,
              targetBranch: intent.target_branch,
              title: intent.title.startsWith("Draft:") ? intent.title : `Draft: ${intent.title}`,
              description,
              token,
            })
          : // Already open: refresh the description with current evidence instead of
            // opening a duplicate.
            await this.#api.updateMergeRequest({
              projectId: project.project_id,
              mergeRequestIid: found.merge_request_iid,
              description,
              token,
            });

      const parsed = gitlabMergeRequestRecord.parse({
        ...record,
        created: found === undefined,
      });
      assertNoCredentialInUrl(parsed.web_url);
      return Object.freeze({ mergeRequest: parsed, pushOutput });
    });
  }
}
