import { requestJira, JiraRestError, type JiraTransport, type RetryPolicy } from "./transport.js";
import * as z from "zod";
import { TrustLevel } from "@remoteagent/contracts";
export { JiraRestError } from "./transport.js";

const ISSUE_FIELDS = [
  "id",
  "key",
  "project",
  "summary",
  "description",
  "status",
  "updated",
  "labels",
] as const;
export interface JiraRestClientOptions {
  origin: string;
  allowedOrigins: readonly string[];
  getAccessToken: () => Promise<Uint8Array>;
  transport: JiraTransport;
  retry?: RetryPolicy;
}
export interface JiraIssueResponse {
  id: string;
  key: string;
  fields: {
    project: { key: string };
    summary?: { trust: typeof TrustLevel.UNTRUSTED_DATA; value: string };
    description?: { trust: typeof TrustLevel.UNTRUSTED_DATA; value: string };
    status?: { trust: typeof TrustLevel.UNTRUSTED_DATA; value: string };
    labels: string[];
    updated: string;
  };
}
export interface JiraSearchPage {
  issues: JiraIssueResponse[];
  nextPageToken?: string;
  isLast?: boolean;
}
const rawIssueSchema = z.strictObject({
  id: z.string().min(1).max(128),
  key: z.string().min(1).max(128),
  fields: z.strictObject({
    project: z.strictObject({ key: z.string().min(1).max(128) }),
    summary: z.string().max(65_536).optional(),
    description: z.string().max(65_536).optional(),
    status: z.strictObject({ name: z.string().max(256) }).optional(),
    labels: z.array(z.string().max(256)).max(128).default([]),
    updated: z.string().max(64),
  }),
});
function parseIssueResponse(value: unknown): JiraIssueResponse {
  const parsed = rawIssueSchema.safeParse(value);
  if (!parsed.success) throw new JiraRestError("invalid_response", "jira issue response invalid");
  const mark = (value: string | undefined) =>
    value === undefined ? undefined : { trust: TrustLevel.UNTRUSTED_DATA, value };
  const fields = {
    ...parsed.data.fields,
    ...(mark(parsed.data.fields.summary) === undefined
      ? {}
      : { summary: mark(parsed.data.fields.summary) }),
    ...(mark(parsed.data.fields.description) === undefined
      ? {}
      : { description: mark(parsed.data.fields.description) }),
    ...(parsed.data.fields.status === undefined
      ? {}
      : { status: mark(parsed.data.fields.status.name) }),
  };
  return { ...parsed.data, fields } as JiraIssueResponse;
}
const pageSchema = z.strictObject({
  issues: z.array(rawIssueSchema).max(100),
  nextPageToken: z.string().min(1).max(4096).optional(),
  isLast: z.boolean().optional(),
});
export class JiraRestClient {
  public constructor(private readonly options: JiraRestClientOptions) {}
  private async get(path: string, query = ""): Promise<unknown> {
    let origin: string;
    try {
      origin = new URL(this.options.origin).origin;
    } catch {
      throw new JiraRestError("auth", "invalid jira origin");
    }
    if (!this.options.allowedOrigins.includes(origin) || !origin.startsWith("https://"))
      throw new JiraRestError("auth", "jira origin rejected");
    if (!path.startsWith("/rest/api/3/") || path.includes("//") || path.includes(".."))
      throw new JiraRestError("auth", "jira path rejected");
    const leased = await this.options.getAccessToken();
    const token = new Uint8Array(leased);
    try {
      const response = await requestJira(
        this.options.transport,
        {
          method: "GET",
          url: `${origin}${path}${query}`,
          headers: {
            Authorization: `Bearer ${new TextDecoder().decode(token)}`,
            Accept: "application/json",
          },
        },
        this.options.retry,
      );
      if (response.redirected !== false || response.finalUrl !== `${origin}${path}${query}`)
        throw new JiraRestError("auth", "jira redirect rejected");
      if (response.status === 401 || response.status === 403)
        throw new JiraRestError("auth", "jira authentication failed");
      if (response.status < 200 || response.status >= 300)
        throw new JiraRestError("http", "jira request failed");
      return response.json();
    } finally {
      token.fill(0);
    }
  }
  public async getIssue(issueKey: string): Promise<JiraIssueResponse> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(issueKey))
      throw new JiraRestError("invalid_response", "jira issue key rejected");
    const value = await this.get(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
      `?fields=${ISSUE_FIELDS.join(",")}`,
    );
    return parseIssueResponse(value);
  }
  public async searchJql(
    jql: string,
    maxPages = 10,
    maxIssues = 1_000,
  ): Promise<JiraIssueResponse[]> {
    if (
      jql.length < 1 ||
      jql.length > 4096 ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 100 ||
      !Number.isInteger(maxIssues) ||
      maxIssues < 1 ||
      maxIssues > 10_000
    )
      throw new JiraRestError("pagination_limit", "jira search limits rejected");
    const results: JiraIssueResponse[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      if (token !== undefined) {
        if (token.length < 1 || token.length > 4096)
          throw new JiraRestError("pagination_limit", "jira token rejected");
        if (seen.has(token))
          throw new JiraRestError("pagination_cycle", "jira pagination token cycle");
        seen.add(token);
      }
      const query = `?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(100, maxIssues - results.length)}${token === undefined ? "" : `&nextPageToken=${encodeURIComponent(token)}`}`;
      const value = await this.get("/rest/api/3/search/jql", query);
      const pageResult = pageSchema.safeParse(value);
      if (!pageResult.success)
        throw new JiraRestError("invalid_response", "jira search response invalid");
      if (
        pageResult.data.issues.length > 100 ||
        results.length + pageResult.data.issues.length > maxIssues
      )
        throw new JiraRestError("pagination_limit", "jira result limit exceeded");
      results.push(...pageResult.data.issues.map(parseIssueResponse));
      if (results.length > maxIssues)
        throw new JiraRestError("pagination_limit", "jira result limit exceeded");
      if (pageResult.data.isLast || pageResult.data.nextPageToken === undefined) return results;
      token = pageResult.data.nextPageToken;
    }
    throw new JiraRestError("pagination_limit", "jira page limit exceeded");
  }
}
