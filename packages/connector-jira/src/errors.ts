export class JiraContractError extends Error {
  readonly code = "JIRA_CONTRACT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "JiraContractError";
  }
}

export class JiraWebhookIngressError extends Error {
  readonly code = "JIRA_WEBHOOK_INGRESS_REJECTED" as const;
  constructor(
    public readonly reason:
      "authorization" | "body_limit" | "identity_conflict" | "outbox_conflict",
  ) {
    super(`jira webhook ${reason}`);
    this.name = "JiraWebhookIngressError";
  }
}
