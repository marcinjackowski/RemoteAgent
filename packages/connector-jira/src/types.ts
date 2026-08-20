import type { z } from "zod";

import { jiraConnectorConfig, jiraEventContract, jiraIssueSnapshotContract } from "./contracts.js";

export type JiraConnectorConfig = z.infer<typeof jiraConnectorConfig>;
export type JiraEvent = z.infer<typeof jiraEventContract>;
export type JiraIssueSnapshot = z.infer<typeof jiraIssueSnapshotContract>;
