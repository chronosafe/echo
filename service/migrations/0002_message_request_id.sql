-- A client-chosen request_id makes echo_send_message safe to retry: the same sender repeating a request_id
-- in a project stores nothing new. Nullable, so existing rows (and messages sent without one) are untouched;
-- the partial unique index ignores NULLs and is what makes the insert race-safe.

ALTER TABLE messages ADD COLUMN request_id TEXT;

CREATE UNIQUE INDEX messages_request_id_uq ON messages (project_id, sender_agent_id, request_id) WHERE request_id IS NOT NULL;
