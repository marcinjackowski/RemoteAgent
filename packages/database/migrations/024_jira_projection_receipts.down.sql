DROP TABLE IF EXISTS jira_projection_receipts;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_receipt_key;
ALTER TABLE external_entities DROP CONSTRAINT IF EXISTS external_entities_jira_receipt_key;
