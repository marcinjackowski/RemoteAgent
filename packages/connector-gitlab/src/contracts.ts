/**
 * GitLab connector contracts: project allowlist, webhook envelope, MR intent.
 *
 * Contracts only — no HTTP, no `child_process`, no filesystem. Names are prefixed
 * `gitlab*` / `GitLab*` or otherwise unique; the export-intersection test guards
 * the barrel, because ESM silently drops an ambiguous name and RA-014 showed the
 * sharper version of that hazard (two same-named schemas, the laxer one winning).
 *
 * Three properties are structural.
 *
 * **Criterion 1: a project outside the allowlist can be neither read nor written.**
 * {@link GitLabProjectAllowlist} resolves a project to a {@link GitLabProjectRef}
 * and there is no other constructor for that type. Every read and write API in this
 * package demands a `GitLabProjectRef`, so an un-allowlisted project cannot be
 * *named* in a call, let alone reached. The allowlist is not consulted by
 * convention; it is the only way to obtain the argument.
 *
 * **Criterion 3: the token never travels.** No contract here has a field for a
 * credential, and {@link gitlabRemote} refuses any URL carrying userinfo — the
 * `https://oauth2:TOKEN@host/path` shape that leaks a token into `git remote -v`,
 * into error text and into command output. Credentials reach Git through an
 * out-of-band mechanism in `./push.ts`, never through a URL in a contract.
 *
 * **Criterion 6: a draft MR carries real evidence.** {@link gitlabMergeRequestIntent}
 * requires test receipts, a review readiness value and an explicit
 * `unresolved_risks` list. A `READY` review with unresolved risks is representable
 * on purpose — risks are disclosed, not hidden — but evidence itself cannot be
 * omitted.
 */
import { idString, sha256Digest, valueObject, versionedContract } from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on webhook body size, in bytes. */
export const MAX_GITLAB_WEBHOOK_BYTES = 1_048_576;

/** How old a webhook may be before it is refused as a replay, in milliseconds. */
export const GITLAB_WEBHOOK_MAX_AGE_MS = 300_000;

/** Raised when a GitLab request cannot be honoured safely. */
export class GitLabConnectorError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "GitLabConnectorError";
    this.code = code;
  }
}

/** The project is not on the server-owned allowlist. */
export const GITLAB_PROJECT_NOT_ALLOWED = "PROJECT_NOT_ALLOWED";

/** The webhook signature did not verify. */
export const GITLAB_SIGNATURE_INVALID = "SIGNATURE_INVALID";

/** The webhook is older than the freshness window, or was already seen. */
export const GITLAB_REPLAY_REJECTED = "REPLAY_REJECTED";

/** A remote URL carried credentials. */
export const GITLAB_CREDENTIAL_IN_URL = "CREDENTIAL_IN_URL";

/** Remote writes are disabled for this scope. */
export const GITLAB_WRITES_DISABLED = "WRITES_DISABLED";

/**
 * A GitLab remote URL, with credentials structurally excluded.
 *
 * The refinements are the interesting part. A URL like
 * `https://oauth2:glpat-xxxx@gitlab.com/acme/repo.git` is accepted by every URL
 * parser and by Git itself, and it leaks the token into `git remote -v`, into
 * `git` error messages, and into any log that records the command. Refusing
 * userinfo at the contract boundary means such a URL cannot be stored, passed or
 * printed anywhere in this package.
 */
export const gitlabRemote = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "ssh:";
    } catch {
      // `git@host:path` SCP syntax has no scheme and no place for a password.
      return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/u.test(value);
    }
  }, "remote must be https, ssh or SCP syntax")
  .refine((value) => {
    if (!value.includes("://")) return !value.includes(":") || !value.includes("@:");
    try {
      const url = new URL(value);
      // Either half of userinfo is a credential channel.
      return url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "remote must not embed credentials");

/**
 * An allowlisted project. Obtainable ONLY from {@link GitLabProjectAllowlist}.
 *
 * The brand is what makes criterion 1 structural: every API in this package takes a
 * `GitLabProjectRef`, and the only producer consults the allowlist, so there is no
 * call shape that can name a project the server did not permit.
 */
declare const allowlisted: unique symbol;

export type GitLabProjectRef = Readonly<{
  readonly [allowlisted]: true;
  project_id: number;
  path_with_namespace: string;
  remote: string;
  /** Whether this project permits remote writes. Default is off. */
  writes_enabled: boolean;
}>;

/** One entry of the server-owned project allowlist. */
export const gitlabProjectEntry = valueObject({
  project_id: z.int().positive(),
  path_with_namespace: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u, "invalid project path"),
  remote: gitlabRemote,
  /**
   * Remote writes are DISABLED by default (criterion: "real writes disabled by
   * default outside a configured sandbox project"). Enabling is a per-project,
   * server-side decision; nothing a model sends can flip it.
   */
  writes_enabled: z.boolean().default(false),
});

export type GitLabProjectEntry = z.infer<typeof gitlabProjectEntry>;

/**
 * The project allowlist.
 *
 * Resolution is by exact `project_id` or exact `path_with_namespace`. No prefix
 * match, no glob, no case-insensitive fallback: `acme/repo-staging` must not be
 * reachable because `acme/repo` is allowed, and a prefix rule is exactly how that
 * happens.
 */
export class GitLabProjectAllowlist {
  readonly #byId = new Map<number, GitLabProjectEntry>();
  readonly #byPath = new Map<string, GitLabProjectEntry>();

  public constructor(entries: readonly GitLabProjectEntry[]) {
    for (const raw of entries) {
      const entry = gitlabProjectEntry.parse(raw);
      this.#byId.set(entry.project_id, entry);
      this.#byPath.set(entry.path_with_namespace, entry);
    }
  }

  /** Every allowlisted path, for diagnostics. Never includes a credential. */
  public get paths(): readonly string[] {
    return Object.freeze([...this.#byPath.keys()].sort());
  }

  /**
   * Resolve a project, or throw. The ONLY producer of {@link GitLabProjectRef}.
   *
   * Throws rather than returning null so an un-allowlisted project cannot be
   * silently skipped by a caller that forgot to check the result.
   */
  public resolve(identifier: number | string): GitLabProjectRef {
    const entry =
      typeof identifier === "number" ? this.#byId.get(identifier) : this.#byPath.get(identifier);
    if (entry === undefined) {
      // The identifier is echoed deliberately: it is server-side configuration data,
      // not a credential, and a silent refusal here is very hard to debug.
      throw new GitLabConnectorError(
        GITLAB_PROJECT_NOT_ALLOWED,
        `project not on the allowlist: ${String(identifier)}`,
      );
    }
    return Object.freeze({
      project_id: entry.project_id,
      path_with_namespace: entry.path_with_namespace,
      remote: entry.remote,
      writes_enabled: entry.writes_enabled,
    }) as GitLabProjectRef;
  }

  /** Whether an identifier is allowlisted, without throwing. */
  public permits(identifier: number | string): boolean {
    return typeof identifier === "number"
      ? this.#byId.has(identifier)
      : this.#byPath.has(identifier);
  }
}

/** Closed set of GitLab webhook kinds this connector understands. */
export const GitLabEventKind = {
  MERGE_REQUEST: "MERGE_REQUEST",
  ISSUE: "ISSUE",
  NOTE: "NOTE",
  PUSH: "PUSH",
  PIPELINE: "PIPELINE",
  JOB: "JOB",
} as const;

export type GitLabEventKind = (typeof GitLabEventKind)[keyof typeof GitLabEventKind];

export const gitlabEventKind = z.enum([
  GitLabEventKind.MERGE_REQUEST,
  GitLabEventKind.ISSUE,
  GitLabEventKind.NOTE,
  GitLabEventKind.PUSH,
  GitLabEventKind.PIPELINE,
  GitLabEventKind.JOB,
]);

/**
 * A verified, normalized webhook event.
 *
 * `delivery_id` is the idempotency key and `observed_at_ms` the freshness anchor.
 * Both are required rather than optional, because an event that cannot be
 * deduplicated or aged is an event that can be replayed (criterion 5).
 */
export const gitlabEvent = versionedContract({
  delivery_id: idString,
  kind: gitlabEventKind,
  project_id: z.int().positive(),
  /** Digest of the raw body, so the stored payload is verifiable. */
  payload_digest: sha256Digest,
  observed_at_ms: z.int().nonnegative(),
  /** Commit SHA the event concerns, when it concerns one. */
  commit_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/iu)
    .nullable(),
  /** Source branch, for correlating back to a case. */
  branch_name: z.string().max(255).nullable(),
  /** Pipeline or job status, for `PIPELINE`/`JOB`. */
  status: z.string().max(64).nullable(),
});

export type GitLabEvent = z.infer<typeof gitlabEvent>;

/**
 * Everything needed to open or update a draft merge request.
 *
 * Criterion 6 lives in the required fields. `test_receipts` and
 * `review_readiness` cannot be omitted, so an MR cannot be opened while staying
 * silent about whether anything was verified or reviewed. `unresolved_risks` is
 * required but may be empty — an empty list is a claim ("none known") rather than
 * an absence, which is the distinction that makes disclosure meaningful.
 */
export const gitlabMergeRequestIntent = versionedContract({
  case_id: idString,
  source_branch: z.string().min(1).max(255),
  target_branch: z.string().min(1).max(255),
  title: z.string().min(1).max(255),
  /** Task summary and the decisions taken. */
  task_summary: z.string().min(1).max(8192),
  /** `receipt_digest` of the `TestRun`s backing this change. */
  test_receipts: z.array(sha256Digest).min(1).max(128),
  /** Review outcome, from RA-015. */
  review_readiness: z.enum(["READY", "CHANGES_REQUIRED", "ESCALATED"]),
  /** Known risks that remain. Empty means "none known", not "not considered". */
  unresolved_risks: z.array(z.string().max(1024)).max(64),
  /** Head commit the MR describes. */
  head_sha: z.string().regex(/^[0-9a-f]{40}$/iu),
});

export type GitLabMergeRequestIntent = z.infer<typeof gitlabMergeRequestIntent>;

/** A merge request as it exists on the remote. */
export const gitlabMergeRequestRecord = versionedContract({
  merge_request_iid: z.int().positive(),
  project_id: z.int().positive(),
  source_branch: z.string().min(1).max(255),
  target_branch: z.string().min(1).max(255),
  draft: z.boolean(),
  web_url: gitlabRemote,
  /** Whether this call created the MR or found an existing one. */
  created: z.boolean(),
});

export type GitLabMergeRequestRecord = z.infer<typeof gitlabMergeRequestRecord>;
