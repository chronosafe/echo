-- Shared data: versioned key/value entries with compare-and-set writes and a permanent history.
-- Every *_at column is TEXT holding a UTC ISO-8601 time set by the Worker (as in 0001).

CREATE TABLE data_entries (
  project_id INTEGER NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  value      TEXT,                       -- JSON text; NULL only on a tombstone
  owner      TEXT,                       -- agent name; NULL = shared or released
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note       TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  CHECK ((deleted = 1) = (value IS NULL)),
  PRIMARY KEY (project_id, key)
);

CREATE TABLE data_history (
  project_id INTEGER NOT NULL,
  key        TEXT NOT NULL,
  version    INTEGER NOT NULL,           -- NOT NULL is load-bearing: it aborts a batch whose guard failed
  op         TEXT NOT NULL CHECK (op IN ('put', 'delete', 'admin_release', 'admin_delete')),
  value      TEXT,
  owner      TEXT,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL,
  note       TEXT,
  batch_id   TEXT,                       -- NULL for a single put/delete
  request_id TEXT,
  PRIMARY KEY (project_id, key, version)
);

-- One row per request_id an agent used on a write. It is inserted inside the write's batch, so a second, different write
-- under the same id aborts on this primary key (the same idea as the unique index on messages.request_id).
CREATE TABLE data_requests (
  project_id INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  request_id TEXT NOT NULL,
  PRIMARY KEY (project_id, actor, request_id)
);

-- The scratch table of the check-op guard; always empty outside a batch.
CREATE TABLE data_guard (ok INTEGER NOT NULL CHECK (ok = 1));

-- Live-key count and list reads over live keys.
CREATE INDEX idx_data_entries_live ON data_entries (project_id, key) WHERE deleted = 0;
-- request_id retry lookups.
CREATE INDEX idx_data_history_request ON data_history (project_id, actor, request_id) WHERE request_id IS NOT NULL;
-- AGENT_REFS (adminDeleteAgent) asks "does this agent appear as an actor?".
CREATE INDEX idx_data_history_actor ON data_history (actor);
-- AGENT_REFS also asks it of entry owners and last writers.
CREATE INDEX idx_data_entries_owner ON data_entries (owner) WHERE owner IS NOT NULL;
CREATE INDEX idx_data_entries_updated_by ON data_entries (updated_by);
