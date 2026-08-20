ALTER TABLE external_entities ADD CONSTRAINT external_entities_jira_receipt_key UNIQUE (entity_id, case_id, owner_id, connection_id, provider, kind, external_id);
ALTER TABLE outbox ADD CONSTRAINT outbox_receipt_key UNIQUE (outbox_id, aggregate_id);

CREATE TABLE jira_projection_receipts (
  event_id text PRIMARY KEY,
  owner_id text NOT NULL,
  connection_id text NOT NULL,
  issue_key text NOT NULL,
  provider text NOT NULL DEFAULT 'jira' CHECK (provider = 'jira'),
  kind text NOT NULL DEFAULT 'jira_issue' CHECK (kind = 'jira_issue'),
  case_id text NOT NULL,
  entity_id text NOT NULL,
  outbox_id text NOT NULL,
  canonical_digest text NOT NULL CHECK (canonical_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, owner_id) REFERENCES cases(case_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (entity_id, case_id, owner_id, connection_id, provider, kind, issue_key) REFERENCES external_entities(entity_id, case_id, owner_id, connection_id, provider, kind, external_id) ON DELETE RESTRICT,
  FOREIGN KEY (outbox_id, case_id) REFERENCES outbox(outbox_id, aggregate_id) ON DELETE RESTRICT
);
CREATE INDEX jira_projection_receipts_lookup ON jira_projection_receipts(owner_id, connection_id, issue_key);
