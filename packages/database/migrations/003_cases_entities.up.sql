-- RA-003 migration 003 (up): cases, external entities, case messages.
--
-- A Case is the unit of conversation, concurrency and checkpointing
-- (Master Plan §5.2). Owner scope is enforced natively: a case's entities and
-- messages cannot reference another owner's connection by a plain write.

CREATE TABLE cases (
  case_id             text        PRIMARY KEY,
  owner_id            text        NOT NULL REFERENCES owners (owner_id) ON DELETE RESTRICT,
  status              text        NOT NULL CHECK (status IN (
                        'NEW', 'TRIAGED', 'PLANNING', 'WAITING_FOR_USER', 'IMPLEMENTING',
                        'VERIFYING', 'REVIEWING', 'FIXING', 'READY_FOR_MR', 'MR_OPEN',
                        'DONE', 'BLOCKED', 'CANCELLED')),
  integration_scope   jsonb       NOT NULL,
  discord_thread_id   text        NOT NULL,
  active_run_id       text,
  -- Monotonic checkpoint revision this case is at (optimistic concurrency).
  checkpoint_revision integer     NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Composite key so children can bind to (case_id, owner_id) and thereby never
  -- cross owner scope.
  UNIQUE (case_id, owner_id)
);

CREATE INDEX cases_owner_status_idx ON cases (owner_id, status);
CREATE UNIQUE INDEX cases_discord_thread_idx ON cases (discord_thread_id);

CREATE TRIGGER cases_touch_updated_at
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- External entities linked to a case (Jira issue, GitLab MR, Gmail thread, ...).
-- Both the case and the connection must belong to the same owner, enforced by
-- two composite foreign keys sharing the owner_id column.
CREATE TABLE external_entities (
  entity_id     text        PRIMARY KEY,
  case_id       text        NOT NULL,
  owner_id      text        NOT NULL,
  connection_id text        NOT NULL,
  provider      text        NOT NULL CHECK (provider IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  kind          text        NOT NULL,
  external_id   text        NOT NULL,
  url           text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- The entity must belong to the case's owner AND to a connection of that same
  -- owner. Sharing owner_id across both FKs makes cross-owner linkage impossible.
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT,
  -- One provider entity maps to at most one row per connection.
  UNIQUE (connection_id, provider, kind, external_id)
);

CREATE INDEX external_entities_case_idx ON external_entities (case_id);
CREATE INDEX external_entities_lookup_idx ON external_entities (provider, external_id);

CREATE TRIGGER external_entities_touch_updated_at
  BEFORE UPDATE ON external_entities
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Case messages (conversation transcript). Append-only ledger: the transcript
-- of what was said/observed is immutable.
CREATE TABLE case_messages (
  message_id  text        PRIMARY KEY,
  case_id     text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  role        text        NOT NULL CHECK (role IN ('OWNER', 'AGENT', 'SYSTEM')),
  -- Trust marker for the body; external/model content is UNTRUSTED_DATA.
  trust       text        NOT NULL CHECK (trust IN ('TRUSTED', 'UNTRUSTED_DATA')),
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX case_messages_case_idx ON case_messages (case_id, created_at);

CREATE TRIGGER case_messages_append_only
  BEFORE UPDATE OR DELETE ON case_messages
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
