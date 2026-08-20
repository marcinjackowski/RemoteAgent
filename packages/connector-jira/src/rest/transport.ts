export interface JiraHttpRequest {
  method: "GET";
  url: string;
  headers: Readonly<Record<string, string>>;
}
export interface JiraHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  json(): Promise<unknown>;
  finalUrl: string;
  redirected: boolean;
}
export type JiraTransport = (request: JiraHttpRequest) => Promise<JiraHttpResponse>;

export class JiraRestError extends Error {
  public constructor(
    public readonly kind:
      | "auth"
      | "http"
      | "rate_limit"
      | "retry_exhausted"
      | "pagination_cycle"
      | "pagination_limit"
      | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "JiraRestError";
  }
}

export interface RetryPolicy {
  maxAttempts?: number;
  maxDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export async function requestJira(
  transport: JiraTransport,
  request: JiraHttpRequest,
  policy: RetryPolicy = {},
): Promise<JiraHttpResponse> {
  const jitterValue = policy.jitter?.() ?? 0;
  if (
    !Number.isInteger(policy.maxAttempts ?? 3) ||
    (policy.maxAttempts ?? 3) < 1 ||
    (policy.maxAttempts ?? 3) > 5 ||
    !Number.isInteger(policy.maxDelayMs ?? 30_000) ||
    (policy.maxDelayMs ?? 30_000) < 0 ||
    (policy.maxDelayMs ?? 30_000) > 30_000 ||
    !Number.isFinite(jitterValue) ||
    jitterValue < 0 ||
    jitterValue > 1_000
  )
    throw new JiraRestError("http", "invalid retry policy");
  const maxAttempts = policy.maxAttempts ?? 3;
  const maxDelay = policy.maxDelayMs ?? 30_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await transport(request);
    if (response.status !== 429 && response.status !== 503) return response;
    const retryAfter = Number(response.headers["retry-after"] ?? response.headers["Retry-After"]);
    if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter * 1000 > maxDelay)
      throw new JiraRestError("rate_limit", "jira retry delay rejected");
    if (attempt === maxAttempts)
      throw new JiraRestError("retry_exhausted", "jira retry attempts exhausted");
    const jitter = jitterValue;
    await (policy.delay ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      Math.min(maxDelay, retryAfter * 1000 + jitter),
    );
  }
  throw new JiraRestError("retry_exhausted", "jira retry attempts exhausted");
}
