import { describe, expect, it } from "vitest";
import { JiraRestClient, JiraRestError } from "../src/rest/client.js";
import { requestJira } from "../src/rest/transport.js";

const issue = {
  id: "1",
  key: "PROJ-1",
  fields: {
    project: { key: "PROJ" },
    summary: "safe",
    labels: [],
    updated: "2026-01-01T00:00:00.000Z",
  },
};
function client(response: unknown, status = 200) {
  return new JiraRestClient({
    origin: "https://jira.example",
    allowedOrigins: ["https://jira.example"],
    getAccessToken: async () => new TextEncoder().encode("secret"),
    transport: async (request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toContain("/rest/api/3/");
      return {
        status,
        headers: {},
        finalUrl: request.url,
        redirected: false,
        json: async () => response,
      };
    },
  });
}
describe("Jira REST client", () => {
  it("gets allowlisted issue fields", async () =>
    expect((await client(issue).getIssue("PROJ-1")).key).toBe("PROJ-1"));
  it("normalizes search provider text as untrusted wrappers", async () => {
    const result = await client({
      issues: [{ ...issue, fields: { ...issue.fields, status: { name: "Open" } } }],
      isLast: true,
    }).searchJql("project=PROJ", 1, 1);
    expect(result[0]?.fields.summary).toEqual({ trust: "UNTRUSTED_DATA", value: "safe" });
    expect(result[0]?.fields.status).toEqual({ trust: "UNTRUSTED_DATA", value: "Open" });
  });
  it("rejects foreign origin", async () =>
    await expect(
      new JiraRestClient({
        origin: "https://evil.example",
        allowedOrigins: ["https://jira.example"],
        getAccessToken: async () => new Uint8Array(),
        transport: async () => {
          throw new Error("called");
        },
      }).getIssue("PROJ-1"),
    ).rejects.toBeInstanceOf(JiraRestError));
  it("detects pagination token cycles", async () => {
    const c = client({ issues: [], nextPageToken: "same" });
    await expect(c.searchJql("project=PROJ", 3)).rejects.toMatchObject({
      kind: "pagination_cycle",
    });
  });
  it("rejects redirect and foreign final URL", async () => {
    const make = (finalUrl: string, redirected: boolean) =>
      new JiraRestClient({
        origin: "https://jira.example",
        allowedOrigins: ["https://jira.example"],
        getAccessToken: async () => new TextEncoder().encode("secret"),
        transport: async () => ({
          status: 200,
          headers: {},
          finalUrl,
          redirected,
          json: async () => issue,
        }),
      });
    await expect(
      make("https://jira.example/other", false).getIssue("PROJ-1"),
    ).rejects.toMatchObject({ kind: "auth" });
    await expect(
      make("https://jira.example/rest/api/3/issue/PROJ-1", true).getIssue("PROJ-1"),
    ).rejects.toMatchObject({ kind: "auth" });
  });
  it("accepts a real rich issue but rejects malformed/oversized ones", async () => {
    // A real Jira issue carries `self`/`expand`, rich `project`/`status` objects, and a `null`
    // description. It must be accepted (unknown keys stripped) and normalized to the modeled shape.
    const real = {
      ...issue,
      self: "https://jira.example/rest/api/3/issue/1",
      expand: "renderedFields,names",
      fields: {
        ...issue.fields,
        project: { self: "x", id: "10", key: "PROJ", name: "Project", projectTypeKey: "software" },
        status: { self: "x", id: "3", name: "Open", statusCategory: { key: "new" } },
        description: null,
      },
    };
    const parsed = await client(real).getIssue("PROJ-1");
    expect(parsed.fields.project).toEqual({ key: "PROJ" });
    expect(parsed.fields.status).toEqual({ trust: "UNTRUSTED_DATA", value: "Open" });
    expect(parsed.fields.description).toBeUndefined();
    // Missing the required `updated` field is still malformed.
    await expect(
      client({ id: "1", key: "PROJ-1", fields: { project: { key: "PROJ" }, labels: [] } }).getIssue(
        "PROJ-1",
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    // Oversized provider text is still rejected.
    await expect(
      client({ ...issue, fields: { ...issue.fields, summary: "x".repeat(70_000) } }).getIssue(
        "PROJ-1",
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("enforces bounded search arguments and page results", async () => {
    await expect(client({ issues: [] }).searchJql("", 1, 1)).rejects.toMatchObject({
      kind: "pagination_limit",
    });
    await expect(client({ issues: [] }).searchJql("x", 101, 1)).rejects.toMatchObject({
      kind: "pagination_limit",
    });
    await expect(client({ issues: [issue, issue] }).searchJql("x", 1, 1)).rejects.toMatchObject({
      kind: "pagination_limit",
    });
  });
  it("retries 429/503 with injected delay and exhausts", async () => {
    let calls = 0;
    const delays: number[] = [];
    const response = await requestJira(
      async () => {
        calls += 1;
        return calls < 3
          ? {
              status: calls === 1 ? 429 : 503,
              headers: { "retry-after": "0" },
              finalUrl: "u",
              redirected: false,
              json: async () => ({}),
            }
          : { status: 200, headers: {}, finalUrl: "u", redirected: false, json: async () => ({}) };
      },
      { method: "GET", url: "u", headers: {} },
      {
        delay: async (ms) => {
          delays.push(ms);
        },
        maxAttempts: 3,
      },
    );
    expect(response.status).toBe(200);
    expect(delays).toEqual([0, 0]);
    await expect(
      requestJira(
        async () => ({
          status: 429,
          headers: {},
          finalUrl: "u",
          redirected: false,
          json: async () => ({}),
        }),
        { method: "GET", url: "u", headers: {} },
        { delay: async () => undefined },
      ),
    ).rejects.toMatchObject({ kind: "rate_limit" });
  });
  it("never serializes bearer secret in errors", async () => {
    await expect(client({}, 401).getIssue("PROJ-1")).rejects.toSatisfy(
      (error) => !JSON.stringify(error).includes("secret"),
    );
  });
  it("accepts unknown page keys but rejects an invalid token type", async () => {
    // Real search envelopes may carry extra top-level keys; they are accepted (unknown stripped).
    expect(await client({ issues: [], extra: true, isLast: true }).searchJql("x")).toEqual([]);
    // A non-string nextPageToken is still a contract violation.
    await expect(client({ issues: [], nextPageToken: 4 }).searchJql("x")).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
  it("rejects invalid retry policy jitter and exhausted retries", async () => {
    await expect(
      requestJira(
        async () => ({
          status: 200,
          headers: {},
          finalUrl: "u",
          redirected: false,
          json: async () => ({}),
        }),
        { method: "GET", url: "u", headers: {} },
        { jitter: () => 2001 },
      ),
    ).rejects.toMatchObject({ kind: "http" });
    let calls = 0;
    await expect(
      requestJira(
        async () => {
          calls += 1;
          return {
            status: 503,
            headers: { "retry-after": "0" },
            finalUrl: "u",
            redirected: false,
            json: async () => ({}),
          };
        },
        { method: "GET", url: "u", headers: {} },
        { maxAttempts: 2, delay: async () => undefined },
      ),
    ).rejects.toMatchObject({ kind: "retry_exhausted" });
    expect(calls).toBe(2);
  });
  it("rejects Retry-After larger than max delay", async () => {
    await expect(
      requestJira(
        async () => ({
          status: 429,
          headers: { "retry-after": "31" },
          finalUrl: "u",
          redirected: false,
          json: async () => ({}),
        }),
        { method: "GET", url: "u", headers: {} },
        { delay: async () => undefined },
      ),
    ).rejects.toMatchObject({ kind: "rate_limit" });
  });
  it("rejects oversized JQL", async () => {
    await expect(client({ issues: [] }).searchJql("x".repeat(4097))).rejects.toMatchObject({
      kind: "pagination_limit",
    });
  });
});
