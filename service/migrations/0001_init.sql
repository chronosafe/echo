-- Echo schema. Every *_at column is TEXT holding a UTC ISO-8601 time set by the Worker.

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  approvals_required INTEGER NOT NULL DEFAULT 0,
  approval_window_min INTEGER NOT NULL DEFAULT 30,
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE owner_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  last_checked_in_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE project_agents (
  project_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL,
  installation_id INTEGER,
  last_status_ok INTEGER,
  last_status_error TEXT,
  last_status_at TEXT,
  prs_listed_at TEXT -- when the cron last listed its open PRs on GitHub; NULL: never, or its installation just attached
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  sender_agent_id INTEGER,
  sender_label TEXT NOT NULL,
  body TEXT NOT NULL,
  requires_ack INTEGER NOT NULL DEFAULT 0,
  escalate_at TEXT,
  kind TEXT NOT NULL DEFAULT 'plain' CHECK (kind IN ('plain','hold','approval_request','system')),
  ref_id INTEGER,
  withdrawn_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE message_recipients (
  message_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  delivered_at TEXT,
  deferred_until TEXT,
  defer_reason TEXT,
  acked_at TEXT,
  ack_note TEXT,
  acked_by TEXT,
  escalated_at TEXT,
  PRIMARY KEY (message_id, agent_id)
);

CREATE TABLE holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  target_kind TEXT NOT NULL DEFAULT 'pr' CHECK (target_kind IN ('pr','gate')),
  repo_id INTEGER,
  pr_number INTEGER,
  gate_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('blocking','advisory')),
  reason TEXT NOT NULL,
  placed_by_agent_id INTEGER,
  placed_by_label TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  message_id INTEGER,
  acked_at TEXT,
  acked_by TEXT,
  ack_note TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','released')),
  released_at TEXT,
  released_by TEXT,
  release_note TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  entered_as TEXT NOT NULL,
  importance TEXT NOT NULL DEFAULT 'normal' CHECK (importance IN ('low','normal','high')),
  kind TEXT NOT NULL,
  repo_id INTEGER,
  pr_number INTEGER,
  merger_agent_id INTEGER,
  created_by TEXT NOT NULL,
  merged_at TEXT,
  merged_by TEXT,
  after_the_fact INTEGER NOT NULL DEFAULT 0,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE event_approvers (
  event_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  request_message_id INTEGER,
  response TEXT CHECK (response IN ('approved','objected')),
  responded_at TEXT,
  responded_by TEXT,
  approved_for_starts_at TEXT, -- the event's starts_at when this approval was given; an approval counts only for that slot
  objection_hold_id INTEGER,
  PRIMARY KEY (event_id, agent_id)
);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  added_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE scratchpad_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);

CREATE TABLE documents (
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('json','markdown')),
  content TEXT NOT NULL,
  saved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, name, version)
);

CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id INTEGER,
  data TEXT
);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  cursor_seq INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE pr_heads (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 1,
  gh_updated_at TEXT,      -- GitHub's pull_request.updated_at of the delivery stored; older deliveries are ignored
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, pr_number)
);

-- The echo/hold status GitHub has confirmed for a commit. A status belongs to a commit, not a PR, and several open
-- PRs can share one head. state is NULL while a write is unconfirmed (set to NULL before each POST).
CREATE TABLE commit_statuses (
  repo_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  state TEXT,
  description TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha)
);

CREATE TABLE status_jobs (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (repo_id, pr_number)
);

CREATE INDEX idx_recipients_agent_acked ON message_recipients(agent_id, acked_at);
CREATE INDEX idx_recipients_escalated_acked ON message_recipients(escalated_at, acked_at);
CREATE INDEX idx_messages_escalate_at ON messages(escalate_at);
CREATE INDEX idx_holds_pr_state ON holds(repo_id, pr_number, state);
CREATE INDEX idx_holds_project_state ON holds(project_id, state);
CREATE INDEX idx_events_project_starts ON events(project_id, starts_at);
CREATE INDEX idx_events_pr ON events(repo_id, pr_number);
-- One merge per PR: the loser of a hook/GitHub race fails on this and returns the winner's row.
CREATE UNIQUE INDEX one_merge ON events(repo_id, pr_number) WHERE merged_at IS NOT NULL;
CREATE INDEX idx_approvers_agent_response ON event_approvers(agent_id, response);
CREATE INDEX idx_change_log_project_seq ON change_log(project_id, seq);
CREATE INDEX idx_change_log_subject ON change_log(subject_id, kind);
CREATE INDEX idx_status_jobs_next ON status_jobs(next_attempt_at);
CREATE INDEX idx_pr_heads_sha ON pr_heads(repo_id, head_sha);
CREATE INDEX idx_pr_heads_open ON pr_heads(open, repo_id, pr_number);
CREATE INDEX idx_repos_prs_listed ON repos(prs_listed_at);
