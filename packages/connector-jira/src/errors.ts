export class JiraContractError extends Error {
  readonly code = "JIRA_CONTRACT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "JiraContractError";
  }
}
