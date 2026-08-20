/**
 * GitLab webhook ingress: verify, age-check, deduplicate, normalize.
 *
 * **Criterion 5: a replayed or stale webhook is refused and audited.** Three
 * independent gates, in this order, and the order matters:
 *
 * 1. **signature**, compared with `timingSafeEqual`. GitLab sends a shared secret in
 *    `X-Gitlab-Token`; a plain `===` on a secret is a timing oracle, and comparing
 *    lengths first leaks length. Both operands are hashed to a fixed width before
 *    comparison so even the length is not observable;
 * 2. **freshness**, against {@link GITLAB_WEBHOOK_MAX_AGE_MS}. Signature alone does
 *    not stop replay: a captured body keeps its valid signature forever;
 * 3. **delivery id**, against a seen-set. Freshness alone does not stop replay
 *    either — an attacker can replay within the window — so the id is the exactly-once
 *    key.
 *
 * Verification precedes everything else because an unverified body is attacker-
 * controlled input: parsing it first would mean acting on unauthenticated data, and
 * *recording* it first would let anyone fill the audit log.
 *
 * Every refusal returns an audit record rather than only throwing. A rejected replay
 * that leaves no trace is indistinguishable from a webhook that never arrived, which
 * defeats the "and audited" half of the criterion.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { canonicalDigest } from "@remoteagent/contracts";

import {
  GITLAB_REPLAY_REJECTED,
  GITLAB_SIGNATURE_INVALID,
  GITLAB_WEBHOOK_MAX_AGE_MS,
  GitLabConnectorError,
  GitLabEventKind,
  MAX_GITLAB_WEBHOOK_BYTES,
  gitlabEvent,
} from "./contracts.js";
import type { GitLabEvent, GitLabProjectAllowlist } from "./contracts.js";

/** Outcome of one ingress attempt, accepted or not. */
export type GitLabIngressAudit = Readonly<{
  accepted: boolean;
  /** Stable reason code when refused; `null` when accepted. */
  refusal_code: string | null;
  delivery_id: string;
  payload_digest: string;
  observed_at_ms: number;
}>;

export type GitLabIngressResult = Readonly<{
  audit: GitLabIngressAudit;
  /** The normalized event; `null` when the request was refused. */
  event: GitLabEvent | null;
}>;

/** Records every attempt, accepted or refused. Injected so it is testable. */
export type GitLabAuditSink = (audit: GitLabIngressAudit) => void;

/** Remembers delivery ids. A real deployment backs this with the database. */
export interface GitLabDeliveryLog {
  /** True when this id was newly recorded; false when it was already present. */
  recordIfAbsent(deliveryId: string): Promise<boolean>;
}

/** In-memory delivery log for tests and single-process use. */
export class InMemoryGitLabDeliveryLog implements GitLabDeliveryLog {
  readonly #seen = new Set<string>();

  public async recordIfAbsent(deliveryId: string): Promise<boolean> {
    if (this.#seen.has(deliveryId)) return false;
    this.#seen.add(deliveryId);
    return true;
  }
}

export type GitLabWebhookRequest = Readonly<{
  /** Raw body bytes. Verified before being parsed. */
  body: Uint8Array;
  /** `X-Gitlab-Token`. */
  token: string | null | undefined;
  /** `X-Gitlab-Event`. */
  eventHeader: string | null | undefined;
  /** Unique delivery identifier from the request. */
  deliveryId: string | null | undefined;
  /** Sender-declared send time, in epoch milliseconds. */
  sentAtMs: number | null | undefined;
}>;

export type GitLabWebhookOptions = Readonly<{
  /** Expected shared secret. Never logged and never returned. */
  secret: string;
  allowlist: GitLabProjectAllowlist;
  deliveryLog: GitLabDeliveryLog;
  audit?: GitLabAuditSink;
  /** Injected clock so the freshness window is deterministic in tests. */
  now?: () => number;
  maxAgeMs?: number;
}>;

/**
 * Constant-time secret comparison over fixed-width digests.
 *
 * Hashing first is deliberate: `timingSafeEqual` throws on length mismatch, so
 * passing raw secrets would both leak length and require a length branch. Digests
 * are always 32 bytes, so exactly one comparison happens regardless of input.
 */
function secretMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Map a GitLab event header to the closed kind set. */
function classify(header: string): GitLabEventKind | null {
  switch (header.trim().toLowerCase()) {
    case "merge request hook":
      return GitLabEventKind.MERGE_REQUEST;
    case "issue hook":
      return GitLabEventKind.ISSUE;
    case "note hook":
      return GitLabEventKind.NOTE;
    case "push hook":
      return GitLabEventKind.PUSH;
    case "pipeline hook":
      return GitLabEventKind.PIPELINE;
    case "job hook":
      return GitLabEventKind.JOB;
    default:
      return null;
  }
}

/** Shape of the fields this connector reads out of a GitLab payload. */
type RawPayload = Readonly<{
  project?: { id?: unknown };
  object_attributes?: {
    source_branch?: unknown;
    last_commit?: { id?: unknown };
    sha?: unknown;
    status?: unknown;
    ref?: unknown;
  };
  ref?: unknown;
  after?: unknown;
  checkout_sha?: unknown;
  sha?: unknown;
  status?: unknown;
  build_status?: unknown;
}>;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asSha(value: unknown): string | null {
  const candidate = asString(value);
  return candidate !== null && /^[0-9a-f]{40}$/iu.test(candidate) ? candidate.toLowerCase() : null;
}

/** Strip `refs/heads/` so a push ref correlates with a branch name. */
function branchOf(payload: RawPayload): string | null {
  const direct = asString(payload.object_attributes?.source_branch);
  if (direct !== null) return direct;
  const ref = asString(payload.ref) ?? asString(payload.object_attributes?.ref);
  return ref === null ? null : ref.replace(/^refs\/heads\//u, "");
}

/**
 * Verify and normalize one webhook delivery.
 *
 * Returns an audit record in every case. Throws only for a malformed request that
 * cannot even be audited — a missing delivery id, since there would be nothing to
 * key the audit on.
 */
export async function ingestGitLabWebhook(
  request: GitLabWebhookRequest,
  options: GitLabWebhookOptions,
): Promise<GitLabIngressResult> {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxAgeMs ?? GITLAB_WEBHOOK_MAX_AGE_MS;
  const observedAtMs = now();
  const deliveryId = asString(request.deliveryId);
  if (deliveryId === null) {
    throw new GitLabConnectorError(GITLAB_REPLAY_REJECTED, "delivery id is required");
  }

  const payloadDigest = canonicalDigest(Buffer.from(request.body).toString("base64"));
  const refuse = (code: string): GitLabIngressResult => {
    const audit: GitLabIngressAudit = Object.freeze({
      accepted: false,
      refusal_code: code,
      delivery_id: deliveryId,
      payload_digest: payloadDigest,
      observed_at_ms: observedAtMs,
    });
    // Audited even when refused: a silently dropped replay is indistinguishable
    // from a webhook that never arrived.
    options.audit?.(audit);
    return Object.freeze({ audit, event: null });
  };

  if (request.body.byteLength > MAX_GITLAB_WEBHOOK_BYTES) {
    return refuse("BODY_TOO_LARGE");
  }

  // Gate 1: signature. Before parsing, because an unverified body is attacker input.
  const token = asString(request.token);
  if (token === null || !secretMatches(token, options.secret)) {
    return refuse(GITLAB_SIGNATURE_INVALID);
  }

  // Gate 2: freshness. A captured body keeps its valid signature forever, so the
  // signature alone cannot stop a replay.
  const sentAtMs = typeof request.sentAtMs === "number" ? request.sentAtMs : null;
  if (sentAtMs === null || Math.abs(observedAtMs - sentAtMs) > maxAge) {
    return refuse(GITLAB_REPLAY_REJECTED);
  }

  // Gate 3: exactly-once. Freshness alone does not stop a replay INSIDE the window.
  if (!(await options.deliveryLog.recordIfAbsent(deliveryId))) {
    return refuse(GITLAB_REPLAY_REJECTED);
  }

  const kind = classify(asString(request.eventHeader) ?? "");
  if (kind === null) return refuse("EVENT_NOT_SUPPORTED");

  let payload: RawPayload;
  try {
    payload = JSON.parse(Buffer.from(request.body).toString("utf8")) as RawPayload;
  } catch {
    return refuse("PAYLOAD_MALFORMED");
  }

  const projectId = typeof payload.project?.id === "number" ? payload.project.id : null;
  if (projectId === null) return refuse("PROJECT_MISSING");
  // Criterion 1 applies to inbound events too: an event about a project we do not
  // permit is refused rather than correlated into a case.
  if (!options.allowlist.permits(projectId)) return refuse("PROJECT_NOT_ALLOWED");

  const event = gitlabEvent.parse({
    schema_version: 1,
    delivery_id: deliveryId,
    kind,
    project_id: projectId,
    payload_digest: payloadDigest,
    observed_at_ms: observedAtMs,
    commit_sha:
      asSha(payload.object_attributes?.last_commit?.id) ??
      asSha(payload.object_attributes?.sha) ??
      asSha(payload.checkout_sha) ??
      asSha(payload.after) ??
      asSha(payload.sha),
    branch_name: branchOf(payload),
    status:
      asString(payload.object_attributes?.status) ??
      asString(payload.status) ??
      asString(payload.build_status),
  });

  const audit: GitLabIngressAudit = Object.freeze({
    accepted: true,
    refusal_code: null,
    delivery_id: deliveryId,
    payload_digest: payloadDigest,
    observed_at_ms: observedAtMs,
  });
  options.audit?.(audit);
  return Object.freeze({ audit, event });
}
