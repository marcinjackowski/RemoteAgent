import { JiraContractError } from "./errors.js";

export function assertJiraProjectInScope(
  projectKey: string | undefined,
  allowlist: readonly string[],
): string {
  if (typeof projectKey !== "string" || !allowlist.includes(projectKey)) {
    throw new JiraContractError("jira project outside authoritative scope");
  }
  return projectKey;
}
