/**
 * Deterministic in-memory stand-in for the Jira REST surface.
 *
 * `FakeJira` implements the public surface of {@link JiraRestClient} that the
 * connector actually calls (`getIssue`, `searchJql`), so it is typed against the
 * production interface instead of an `as never` cast. It performs NO network I/O,
 * holds no credentials and returns only fixture data. Responses it hands back are
 * UNTRUSTED_DATA, exactly like real Jira responses.
 *
 * It also records calls so an end-to-end spec can prove enrichment happened
 * exactly once per event (duplicate delivery / restart must not re-GET).
 */
import { JiraRestError, type JiraIssueResponse, type JiraRestClient } from "../src/rest/client.js";
import { e2eIssue, type E2EIssueOptions } from "./fixtures/e2e-issues.js";

/** The subset of the real client the connector depends on. */
export type FakeJiraSurface = Pick<JiraRestClient, "getIssue" | "searchJql">;

/** Same shape the real client enforces before issuing a request. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const JQL =
  /^project = ([A-Z][A-Z0-9_]{0,127}) AND updated >= (\S+) ORDER BY updated ASC, key ASC$/;

export class FakeJira implements FakeJiraSurface {
  readonly #issues = new Map<string, JiraIssueResponse>();
  readonly #getIssueCalls: string[] = [];
  readonly #searchCalls: string[] = [];
  #getIssueFailure: Error | undefined;
  #getIssueDelayMs = 0;

  public constructor(issues: readonly JiraIssueResponse[] = []) {
    for (const issue of issues) this.#issues.set(issue.key, issue);
  }

  /** Seed or replace an issue; returns the stored fixture. */
  public put(options: E2EIssueOptions = {}): JiraIssueResponse {
    const issue = e2eIssue(options);
    this.#issues.set(issue.key, issue);
    return issue;
  }

  /** Make the next and all further `getIssue` calls fail. */
  public failGetIssue(error: Error): void {
    this.#getIssueFailure = error;
  }

  /** Widen a concurrency window without touching production code. */
  public delayGetIssue(ms: number): void {
    this.#getIssueDelayMs = ms;
  }

  public get getIssueCalls(): readonly string[] {
    return [...this.#getIssueCalls];
  }

  public get searchCalls(): readonly string[] {
    return [...this.#searchCalls];
  }

  public async getIssue(issueKey: string): Promise<JiraIssueResponse> {
    if (!ISSUE_KEY.test(issueKey))
      throw new JiraRestError("invalid_response", "jira issue key rejected");
    this.#getIssueCalls.push(issueKey);
    if (this.#getIssueDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.#getIssueDelayMs));
    if (this.#getIssueFailure !== undefined) throw this.#getIssueFailure;
    const issue = this.#issues.get(issueKey);
    if (issue === undefined) throw new JiraRestError("http", "jira request failed");
    return structuredClone(issue);
  }

  public async searchJql(
    jql: string,
    maxPages = 10,
    maxIssues = 1_000,
  ): Promise<JiraIssueResponse[]> {
    if (jql.length < 1 || jql.length > 4096 || maxPages < 1 || maxIssues < 1)
      throw new JiraRestError("pagination_limit", "jira search limits rejected");
    this.#searchCalls.push(jql);
    const parsed = JQL.exec(jql);
    if (parsed === null) throw new JiraRestError("invalid_response", "jira search jql rejected");
    const projectKey = parsed[1]!;
    // The reconciler bounds `updated` with epoch milliseconds (ISO 8601 is silently ignored by
    // real Jira JQL), so the cursor is a bare integer, not a parseable date string.
    const cursorMs = Number(parsed[2]!);
    if (!Number.isFinite(cursorMs))
      throw new JiraRestError("invalid_response", "jira search cursor rejected");
    return [...this.#issues.values()]
      .filter(
        (issue) =>
          issue.fields.project.key === projectKey && Date.parse(issue.fields.updated) >= cursorMs,
      )
      .sort(
        (left, right) =>
          Date.parse(left.fields.updated) - Date.parse(right.fields.updated) ||
          Buffer.from(left.key).compare(Buffer.from(right.key)),
      )
      .slice(0, maxIssues)
      .map((issue) => structuredClone(issue));
  }
}
