/**
 * Tests for the GitLab connector: allowlist, webhook ingress and draft MRs.
 *
 * The GitLab API and the pusher are fakes, as the task's required verification
 * specifies ("fake GitLab API/webhook contract tests"), but they are *recording*
 * fakes: they capture every argument they were called with, so the assertions are
 * about what would actually have gone over the wire — including whether a token ever
 * appeared in a URL. A fake that only returned canned values would prove nothing
 * about credential handling.
 *
 * What each block proves:
 *
 *   1. **AC1 — an un-allowlisted project cannot be read or written.** Resolution is
 *      refused, and the branded type means such a project cannot even be passed;
 *   2. **AC2 — retrying push/create-MR makes no duplicate.** The publisher is run
 *      twice and the fake's create-call count is asserted, which is the only
 *      assertion that actually excludes a second MR;
 *   3. **AC3 — the token never leaks.** Swept across the remote URL, the recorded
 *      push arguments, the returned output, and error text from a failing push;
 *   4. **AC4 — a pipeline event updates the right case and SHA.** Parsed from real
 *      GitLab payload shapes for pipeline, job and push;
 *   5. **AC5 — replay and stale timestamps are refused AND audited.** Each gate is
 *      driven separately, and the audit sink is asserted, because a silent drop
 *      defeats the "audited" half;
 *   6. **AC6 — the draft MR carries real evidence.** Description content is
 *      asserted, and an intent without receipts is unrepresentable.
 */
import { describe, expect, it } from "vitest";

import {
  GITLAB_CREDENTIAL_IN_URL,
  GITLAB_PROJECT_NOT_ALLOWED,
  GITLAB_REPLAY_REJECTED,
  GITLAB_SIGNATURE_INVALID,
  GITLAB_WRITES_DISABLED,
  GitLabConnectorError,
  GitLabEventKind,
  GitLabMergeRequestPublisher,
  GitLabProjectAllowlist,
  InMemoryGitLabDeliveryLog,
  assertNoCredentialInUrl,
  gitlabMergeRequestIntent,
  gitlabRemote,
  ingestGitLabWebhook,
  redactGitLabOutput,
  renderMergeRequestDescription,
} from "../src/index.js";
import type {
  BranchPusher,
  CredentialBroker,
  GitLabApi,
  GitLabIngressAudit,
  GitLabMergeRequestIntent,
  GitLabMergeRequestRecord,
} from "../src/index.js";

const SECRET = "webhook-shared-secret-xyz";
const TOKEN = "glpat-SECRETTOKENVALUE1234";
const SHA = "a".repeat(40);
const RECEIPT = `sha256:${"d".repeat(64)}`;

const ALLOWED = {
  project_id: 42,
  path_with_namespace: "acme/repo",
  remote: "https://gitlab.example.com/acme/repo.git",
};

function allowlist(writesEnabled = false) {
  return new GitLabProjectAllowlist([{ ...ALLOWED, writes_enabled: writesEnabled }]);
}

/** A broker that hands the token to a callback and never exposes it. */
function broker(): CredentialBroker {
  return {
    use: async (_scope, fn) => fn(TOKEN),
    redactionLiterals: () => [TOKEN],
  };
}

/** Recording fake: captures every argument so leaks are assertable. */
function fakeApi(overrides: Partial<GitLabApi> = {}) {
  const calls = { find: 0, create: 0, update: 0 };
  const seen: Record<string, unknown>[] = [];
  let stored: GitLabMergeRequestRecord | null = null;

  const api: GitLabApi = {
    findMergeRequests: async (input) => {
      calls.find += 1;
      seen.push({ ...input });
      return stored === null ? [] : [stored];
    },
    createMergeRequest: async (input) => {
      calls.create += 1;
      seen.push({ ...input });
      stored = {
        schema_version: 1,
        merge_request_iid: 7,
        project_id: input.projectId,
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        draft: true,
        web_url: "https://gitlab.example.com/acme/repo/-/merge_requests/7",
        created: true,
      };
      return stored;
    },
    updateMergeRequest: async (input) => {
      calls.update += 1;
      seen.push({ ...input });
      return { ...(stored as GitLabMergeRequestRecord), created: false };
    },
    ...overrides,
  };
  return { api, calls, seen };
}

function fakePusher(overrides: Partial<BranchPusher> = {}) {
  const seen: Record<string, unknown>[] = [];
  const pusher: BranchPusher = {
    push: async (input) => {
      seen.push({ ...input });
      return { stdout: "Everything up-to-date", stderr: "" };
    },
    ...overrides,
  };
  return { pusher, seen };
}

function intent(overrides: Partial<GitLabMergeRequestIntent> = {}): GitLabMergeRequestIntent {
  return gitlabMergeRequestIntent.parse({
    schema_version: 1,
    case_id: "case-1",
    source_branch: "agent/login-abc12345",
    target_branch: "main",
    title: "Harden authorization",
    task_summary: "Restore strict equality in the authorization guard.",
    test_receipts: [RECEIPT],
    review_readiness: "READY",
    unresolved_risks: [],
    head_sha: SHA,
    ...overrides,
  });
}

/** Build a signed, fresh webhook request for a given payload. */
function webhookRequest(
  payload: unknown,
  overrides: Partial<Parameters<typeof ingestGitLabWebhook>[0]> = {},
) {
  return {
    body: new TextEncoder().encode(JSON.stringify(payload)),
    token: SECRET,
    eventHeader: "Pipeline Hook",
    deliveryId: "delivery-1",
    sentAtMs: 1_000_000,
    ...overrides,
  };
}

const NOW = 1_000_000;

describe("gitlab connector", () => {
  describe("AC1: a project outside the allowlist cannot be read or written", () => {
    it("refuses to resolve an un-allowlisted project by id or path", () => {
      const list = allowlist();
      for (const identifier of [999, "evil/repo"]) {
        try {
          list.resolve(identifier);
          throw new Error(`expected a refusal for ${String(identifier)}`);
        } catch (error) {
          expect((error as { code?: string }).code).toBe(GITLAB_PROJECT_NOT_ALLOWED);
        }
      }
    });

    it("does not allow a prefix or case variant to slip through", () => {
      const list = allowlist();
      // `acme/repo-staging` must not be reachable because `acme/repo` is allowed.
      for (const near of ["acme/repo-staging", "acme/repo/sub", "ACME/REPO", "acme/rep"]) {
        expect(list.permits(near), near).toBe(false);
      }
      expect(list.permits("acme/repo")).toBe(true);
      expect(list.permits(42)).toBe(true);
    });

    it("refuses an inbound event about an un-allowlisted project", async () => {
      const audits: GitLabIngressAudit[] = [];
      const result = await ingestGitLabWebhook(
        webhookRequest({ project: { id: 999 }, object_attributes: { status: "success" } }),
        {
          secret: SECRET,
          allowlist: allowlist(),
          deliveryLog: new InMemoryGitLabDeliveryLog(),
          audit: (audit) => audits.push(audit),
          now: () => NOW,
        },
      );

      expect(result.event).toBeNull();
      expect(result.audit.refusal_code).toBe("PROJECT_NOT_ALLOWED");
      expect(audits).toHaveLength(1);
    });

    it("exposes allowlisted paths without any credential", () => {
      expect(allowlist().paths).toEqual(["acme/repo"]);
      expect(JSON.stringify(allowlist().paths)).not.toContain(TOKEN);
    });
  });

  describe("AC2: retrying push or create-MR makes no duplicate", () => {
    it("creates once, then updates on retry", async () => {
      const { api, calls } = fakeApi();
      const { pusher } = fakePusher();
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });
      const project = allowlist(true).resolve(42);

      const first = await publisher.publish(project, intent());
      expect(first.mergeRequest.created).toBe(true);

      const second = await publisher.publish(project, intent());
      expect(second.mergeRequest.created).toBe(false);
      expect(second.mergeRequest.merge_request_iid).toBe(first.mergeRequest.merge_request_iid);

      // The decisive assertion: exactly ONE create call reached the API.
      expect(calls.create).toBe(1);
      expect(calls.update).toBe(1);
    });

    it("establishes idempotency against the REMOTE, not local state", async () => {
      const { api, calls } = fakeApi();
      const { pusher } = fakePusher();
      const project = allowlist(true).resolve(42);

      // A brand-new publisher, as after a process restart. A local "created" flag
      // would be gone; the remote lookup still finds the MR.
      await new GitLabMergeRequestPublisher({ api, pusher, broker: broker() }).publish(
        project,
        intent(),
      );
      const afterRestart = await new GitLabMergeRequestPublisher({
        api,
        pusher,
        broker: broker(),
      }).publish(project, intent());

      expect(afterRestart.mergeRequest.created).toBe(false);
      expect(calls.create).toBe(1);
    });

    it("titles the MR as a draft exactly once", async () => {
      const { api, seen } = fakeApi();
      const { pusher } = fakePusher();
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      await publisher.publish(allowlist(true).resolve(42), intent({ title: "Draft: already" }));
      const created = seen.find((call) => typeof call["title"] === "string");
      expect(created?.["title"]).toBe("Draft: already");
    });

    it("refuses to write to a project without writes enabled", async () => {
      const { api, calls } = fakeApi();
      const { pusher, seen } = fakePusher();
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      // Writes are OFF by default, so the default allowlist entry cannot be pushed to.
      try {
        await publisher.publish(allowlist(false).resolve(42), intent());
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(GitLabConnectorError);
        expect((error as { code?: string }).code).toBe(GITLAB_WRITES_DISABLED);
      }
      // Nothing was pushed and nothing was created: refused before any side effect.
      expect(seen).toHaveLength(0);
      expect(calls.create).toBe(0);
    });
  });

  describe("AC3: the token never reaches a URL, output or error", () => {
    it("refuses a remote URL that embeds credentials", () => {
      for (const bad of [
        `https://oauth2:${TOKEN}@gitlab.example.com/acme/repo.git`,
        `https://${TOKEN}@gitlab.example.com/acme/repo.git`,
        "https://user:pass@gitlab.example.com/acme/repo.git",
      ]) {
        expect(gitlabRemote.safeParse(bad).success, bad).toBe(false);
        try {
          assertNoCredentialInUrl(bad);
          throw new Error(`expected a refusal for ${bad}`);
        } catch (error) {
          expect((error as { code?: string }).code).toBe(GITLAB_CREDENTIAL_IN_URL);
        }
      }
      expect(gitlabRemote.safeParse(ALLOWED.remote).success).toBe(true);
      expect(gitlabRemote.safeParse("git@gitlab.example.com:acme/repo.git").success).toBe(true);
    });

    it("never puts the token in the URL handed to the pusher", async () => {
      const { api } = fakeApi();
      const { pusher, seen } = fakePusher();
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      await publisher.publish(allowlist(true).resolve(42), intent());

      const call = seen[0];
      // The token is passed as its OWN argument, never spliced into the remote.
      expect(String(call?.["remote"])).not.toContain(TOKEN);
      expect(String(call?.["remote"])).toBe(ALLOWED.remote);
      expect(call?.["token"]).toBe(TOKEN);
    });

    it("redacts the token from push output that would be shown to a model", async () => {
      const { api } = fakeApi();
      const { pusher } = fakePusher({
        push: async () => ({
          stdout: `remote: pushed via https://oauth2:${TOKEN}@gitlab.example.com`,
          stderr: `warning: token ${TOKEN} used`,
        }),
      });
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      const result = await publisher.publish(allowlist(true).resolve(42), intent());
      expect(result.pushOutput).not.toContain(TOKEN);
    });

    it("redacts the token from a FAILING push's error message", async () => {
      const { api } = fakeApi();
      const { pusher } = fakePusher({
        push: async () => {
          // Git really does put the remote URL in its error text.
          throw new Error(`fatal: unable to access 'https://oauth2:${TOKEN}@gitlab.example.com/'`);
        },
      });
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      await expect(publisher.publish(allowlist(true).resolve(42), intent())).rejects.toThrow(
        GitLabConnectorError,
      );

      try {
        await publisher.publish(allowlist(true).resolve(42), intent());
      } catch (error) {
        expect((error as Error).message).not.toContain(TOKEN);
      }
    });

    it("redacts host paths and provider tokens generally", () => {
      const redacted = redactGitLabOutput(
        `${TOKEN} at /Users/victim/.ssh/id_rsa and AKIAIOSFODNN7EXAMPLE`,
        broker(),
      );
      expect(redacted).not.toContain(TOKEN);
      expect(redacted).not.toContain("/Users/victim");
      expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("keeps the token out of every returned value", async () => {
      const { api } = fakeApi();
      const { pusher } = fakePusher();
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      const result = await publisher.publish(allowlist(true).resolve(42), intent());
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });

  describe("AC4: a pipeline event updates the right case and commit SHA", () => {
    const options = () => ({
      secret: SECRET,
      allowlist: allowlist(),
      deliveryLog: new InMemoryGitLabDeliveryLog(),
      now: () => NOW,
    });

    it("extracts the SHA, branch and status from a pipeline payload", async () => {
      const result = await ingestGitLabWebhook(
        webhookRequest({
          project: { id: 42 },
          object_attributes: {
            sha: SHA,
            ref: "refs/heads/agent/login-abc12345",
            status: "success",
          },
        }),
        options(),
      );

      expect(result.event?.kind).toBe(GitLabEventKind.PIPELINE);
      expect(result.event?.commit_sha).toBe(SHA);
      expect(result.event?.branch_name).toBe("agent/login-abc12345");
      expect(result.event?.status).toBe("success");
      expect(result.event?.project_id).toBe(42);
    });

    it("extracts a job event's SHA and status", async () => {
      const result = await ingestGitLabWebhook(
        webhookRequest(
          { project: { id: 42 }, sha: SHA, ref: "agent/x", build_status: "failed" },
          { eventHeader: "Job Hook", deliveryId: "delivery-job" },
        ),
        options(),
      );

      expect(result.event?.kind).toBe(GitLabEventKind.JOB);
      expect(result.event?.commit_sha).toBe(SHA);
      expect(result.event?.status).toBe("failed");
    });

    it("extracts a push event's checkout SHA and strips refs/heads/", async () => {
      const result = await ingestGitLabWebhook(
        webhookRequest(
          { project: { id: 42 }, checkout_sha: SHA, ref: "refs/heads/agent/login-abc12345" },
          { eventHeader: "Push Hook", deliveryId: "delivery-push" },
        ),
        options(),
      );

      expect(result.event?.kind).toBe(GitLabEventKind.PUSH);
      expect(result.event?.commit_sha).toBe(SHA);
      expect(result.event?.branch_name).toBe("agent/login-abc12345");
    });

    it("uses the merge request's last_commit SHA", async () => {
      const result = await ingestGitLabWebhook(
        webhookRequest(
          {
            project: { id: 42 },
            object_attributes: { source_branch: "agent/x", last_commit: { id: SHA } },
          },
          { eventHeader: "Merge Request Hook", deliveryId: "delivery-mr" },
        ),
        options(),
      );

      expect(result.event?.kind).toBe(GitLabEventKind.MERGE_REQUEST);
      expect(result.event?.commit_sha).toBe(SHA);
    });

    it("refuses an unsupported event kind", async () => {
      const result = await ingestGitLabWebhook(
        webhookRequest({ project: { id: 42 } }, { eventHeader: "Wiki Page Hook" }),
        options(),
      );
      expect(result.event).toBeNull();
      expect(result.audit.refusal_code).toBe("EVENT_NOT_SUPPORTED");
    });
  });

  describe("AC5: replay and stale timestamps are refused and audited", () => {
    function harness() {
      const audits: GitLabIngressAudit[] = [];
      return {
        audits,
        options: {
          secret: SECRET,
          allowlist: allowlist(),
          deliveryLog: new InMemoryGitLabDeliveryLog(),
          audit: (audit: GitLabIngressAudit) => audits.push(audit),
          now: () => NOW,
        },
      };
    }

    const payload = { project: { id: 42 }, object_attributes: { sha: SHA, status: "success" } };

    it("refuses a wrong or missing signature", async () => {
      for (const token of [null, "", "wrong-secret", `${SECRET}x`]) {
        const { audits, options } = harness();
        const result = await ingestGitLabWebhook(webhookRequest(payload, { token }), options);
        expect(result.event, String(token)).toBeNull();
        expect(result.audit.refusal_code).toBe(GITLAB_SIGNATURE_INVALID);
        expect(audits).toHaveLength(1);
      }
    });

    it("refuses a stale timestamp outside the freshness window", async () => {
      const { audits, options } = harness();
      const result = await ingestGitLabWebhook(
        webhookRequest(payload, { sentAtMs: NOW - 600_000 }),
        options,
      );

      expect(result.event).toBeNull();
      expect(result.audit.refusal_code).toBe(GITLAB_REPLAY_REJECTED);
      expect(audits[0]?.accepted).toBe(false);
    });

    it("refuses a future timestamp too", async () => {
      const { options } = harness();
      const result = await ingestGitLabWebhook(
        webhookRequest(payload, { sentAtMs: NOW + 600_000 }),
        options,
      );
      // A clock far ahead is as suspect as one far behind.
      expect(result.audit.refusal_code).toBe(GITLAB_REPLAY_REJECTED);
    });

    it("refuses a replayed delivery id INSIDE the freshness window", async () => {
      const { audits, options } = harness();
      const first = await ingestGitLabWebhook(webhookRequest(payload), options);
      expect(first.event).not.toBeNull();

      // Same id, same signature, still fresh: only the delivery log stops this.
      const replay = await ingestGitLabWebhook(webhookRequest(payload), options);
      expect(replay.event).toBeNull();
      expect(replay.audit.refusal_code).toBe(GITLAB_REPLAY_REJECTED);
      expect(audits.filter((audit) => audit.accepted)).toHaveLength(1);
    });

    it("audits accepted deliveries as well as refused ones", async () => {
      const { audits, options } = harness();
      await ingestGitLabWebhook(webhookRequest(payload), options);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.accepted).toBe(true);
      expect(audits[0]?.payload_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    });

    it("refuses a request with no delivery id, since it could not be audited", async () => {
      const { options } = harness();
      await expect(
        ingestGitLabWebhook(webhookRequest(payload, { deliveryId: null }), options),
      ).rejects.toThrow(GitLabConnectorError);
    });

    it("refuses an oversized body before parsing it", async () => {
      const { options } = harness();
      const result = await ingestGitLabWebhook(
        { ...webhookRequest(payload), body: new Uint8Array(2_000_000) },
        options,
      );
      expect(result.audit.refusal_code).toBe("BODY_TOO_LARGE");
    });

    it("never records the secret in an audit entry", async () => {
      const { audits, options } = harness();
      await ingestGitLabWebhook(webhookRequest(payload), options);
      expect(JSON.stringify(audits)).not.toContain(SECRET);
    });
  });

  describe("AC6: the draft MR carries real test and review evidence", () => {
    it("renders every evidence section from the intent", () => {
      const description = renderMergeRequestDescription(
        intent({
          unresolved_risks: ["Rate limiting is untested under load."],
          review_readiness: "READY",
        }),
      );

      expect(description).toContain("Restore strict equality");
      expect(description).toContain(RECEIPT);
      expect(description).toContain(SHA);
      expect(description).toContain("READY");
      expect(description).toContain("Rate limiting is untested under load.");
      expect(description).toContain("case-1");
    });

    it("states 'None known' rather than omitting the risks section", () => {
      // An absent section reads as "not considered"; an explicit none is a claim.
      const description = renderMergeRequestDescription(intent({ unresolved_risks: [] }));
      expect(description).toContain("## Unresolved risks");
      expect(description).toContain("None known.");
    });

    it("discloses a non-READY review rather than hiding it", () => {
      const description = renderMergeRequestDescription(intent({ review_readiness: "ESCALATED" }));
      expect(description).toContain("ESCALATED");
    });

    it("cannot express an intent with no test receipts", () => {
      expect(() => intent({ test_receipts: [] })).toThrow();
    });

    it("cannot express an intent with no review readiness or head SHA", () => {
      expect(() => intent({ review_readiness: undefined as never })).toThrow();
      expect(() => intent({ head_sha: "abc" })).toThrow();
    });

    it("sends the rendered description to the API, not a placeholder", async () => {
      const { api, seen } = fakeApi();
      const { pusher } = fakePusher();
      const publisher = new GitLabMergeRequestPublisher({ api, pusher, broker: broker() });

      await publisher.publish(
        allowlist(true).resolve(42),
        intent({ unresolved_risks: ["Needs a load test."] }),
      );

      const created = seen.find((call) => typeof call["description"] === "string");
      expect(String(created?.["description"])).toContain(RECEIPT);
      expect(String(created?.["description"])).toContain("Needs a load test.");
    });
  });

  describe("export surface", () => {
    it("shares no exported name with the packages it builds on", async () => {
      const [own, contracts, tools] = await Promise.all([
        import("../src/index.js"),
        import("@remoteagent/contracts"),
        import("@remoteagent/implementation-tools"),
      ]);
      const foreign = new Set([...Object.keys(contracts), ...Object.keys(tools)]);
      expect(Object.keys(own).filter((name) => foreign.has(name))).toEqual([]);
    });

    it("no longer exports the RA-001 packageName skeleton relic", async () => {
      // One of the six duplicate `packageName` literals recorded in CTF-002.
      const own = await import("../src/index.js");
      expect(Object.keys(own)).not.toContain("packageName");
    });
  });
});
