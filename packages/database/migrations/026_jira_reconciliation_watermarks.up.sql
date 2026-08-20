CREATE TABLE jira_reconciliation_watermarks (
  owner_id text NOT NULL,
  connection_id text NOT NULL,
  project_key text NOT NULL CHECK (length(btrim(project_key)) BETWEEN 1 AND 128),
  watermark_ms bigint NOT NULL CHECK (watermark_ms >= 0),
  last_issue_key text NOT NULL DEFAULT '' CHECK (length(last_issue_key) <= 128),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, connection_id, project_key),
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections(connection_id, owner_id) ON DELETE RESTRICT
);

CREATE TABLE jira_issue_snapshots (
  owner_id text NOT NULL,
  connection_id text NOT NULL,
  project_key text NOT NULL CHECK (length(btrim(project_key)) BETWEEN 1 AND 128),
  issue_key text NOT NULL CHECK (length(btrim(issue_key)) BETWEEN 1 AND 128),
  issue_version_ms bigint NOT NULL CHECK (issue_version_ms >= 0),
  snapshot jsonb NOT NULL,
  PRIMARY KEY (owner_id, connection_id, project_key, issue_key),
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections(connection_id, owner_id) ON DELETE RESTRICT
);
