-- RA-003 migration 007 (up): workspaces, artifacts, reviews.
--
-- Each coding case has an isolated workspace (Master Plan §7). Artifacts (test
-- logs, snapshots) live outside the prompt; reviews are independent findings.
-- Artifacts and reviews are append-only records of what happened.

CREATE TABLE workspaces (
  workspace_id   text        PRIMARY KEY,
  case_id        text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  repo           text        NOT NULL,
  base_sha       text,
  branch_name    text,
  tree_digest    text        CHECK (tree_digest IS NULL OR tree_digest ~ '^sha256:[0-9a-f]{64}$'),
  status         text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- At most one active workspace per case (single-writer isolation, §7).
  UNIQUE (case_id)
);

CREATE INDEX workspaces_case_idx ON workspaces (case_id);

CREATE TRIGGER workspaces_touch_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Artifacts: test logs, snapshots, tree digests. Append-only ledger; each is a
-- reference to bytes stored outside the DB plus an integrity digest.
CREATE TABLE artifacts (
  artifact_id   text        PRIMARY KEY,
  case_id       text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  run_id        text        REFERENCES agent_runs (run_id) ON DELETE RESTRICT,
  kind          text        NOT NULL,
  storage_ref   text        NOT NULL,
  digest        text        NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes    bigint      CHECK (size_bytes IS NULL OR size_bytes >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_case_idx ON artifacts (case_id, created_at);
CREATE INDEX artifacts_run_idx ON artifacts (run_id) WHERE run_id IS NOT NULL;

CREATE TRIGGER artifacts_append_only
  BEFORE UPDATE OR DELETE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- Reviews: independent findings from the Reviewer role. Append-only.
CREATE TABLE reviews (
  review_id     text        PRIMARY KEY,
  case_id       text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  run_id        text        REFERENCES agent_runs (run_id) ON DELETE RESTRICT,
  verdict       text        NOT NULL CHECK (verdict IN ('PASS', 'CHANGES_REQUIRED', 'BLOCKED')),
  findings      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reviews_case_idx ON reviews (case_id, created_at);

CREATE TRIGGER reviews_append_only
  BEFORE UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
