-- M0 initial schema: demo workspaces, durable intake/outbox, incidents,
-- policy versions, action ledger, audit, update stream, demo sessions.
-- Every channel-owned record carries workspace_id (+ channel_id); uniqueness
-- and foreign keys prevent cross-workspace references.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migration bookkeeping (managed by scripts/db-migrate.mjs).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'preview' CHECK (mode IN ('preview', 'assist')),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version INTEGER NOT NULL DEFAULT 1,
  authority_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'moderator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Development-only demo sessions. Production refuses to issue or honor these.
CREATE TABLE demo_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX demo_sessions_workspace_idx ON demo_sessions(workspace_id);

CREATE TABLE chat_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message','message_deleted','user_messages_cleared','moderation_observed','connection_changed')),
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  original_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL DEFAULT '',
  reply_to_message_id TEXT NULL,
  target_user_id TEXT NULL,
  provider_time TIMESTAMPTZ NOT NULL,
  received_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_time TIMESTAMPTZ NULL,
  origin TEXT NOT NULL DEFAULT 'replay' CHECK (origin IN ('replay','live')),
  delivery_id TEXT NOT NULL,
  category TEXT NULL,
  evaluation JSONB NULL,
  skipped BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Deduplicate chat events by channel + provider message id + kind.
  CONSTRAINT chat_events_unique_msg UNIQUE (workspace_id, channel_id, platform_message_id, kind)
);
CREATE INDEX chat_events_workspace_time_idx ON chat_events(workspace_id, provider_time);
CREATE INDEX chat_events_workspace_author_idx ON chat_events(workspace_id, author_id, provider_time);

-- Transport-delivery dedup: verified subscription/delivery ids. A repeated
-- delivery returns success without new work.
CREATE TABLE deliveries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, delivery_id)
);

-- Every duplicate delivery attempt (repeated delivery id, or a known message
-- under a fresh delivery id). Powers honest deduplication counts in health.
CREATE TABLE duplicate_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX duplicate_deliveries_workspace_idx ON duplicate_deliveries(workspace_id);

-- Transactional outbox: persisted in the same transaction as intake.
CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox(delivered, created_at) WHERE delivered = FALSE;

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','claimed','resolved','dismissed')),
  claimed_by_user_id TEXT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  group_key TEXT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  account_count INTEGER NOT NULL DEFAULT 0,
  target_user_id TEXT NULL,
  recommended_action TEXT NOT NULL DEFAULT '',
  channel_rule TEXT NOT NULL DEFAULT '',
  observed_pattern TEXT NOT NULL DEFAULT '',
  uncertainty TEXT NOT NULL DEFAULT '',
  eligible_actions JSONB NOT NULL DEFAULT '[]',
  policy_version INTEGER NOT NULL DEFAULT 1,
  resolved_reason TEXT NULL,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX incidents_workspace_state_idx ON incidents(workspace_id, state, severity, last_observed_at DESC);
CREATE INDEX incidents_workspace_group_idx ON incidents(workspace_id, group_key) WHERE state IN ('open','claimed');

CREATE TABLE incident_events (
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  chat_event_id UUID NOT NULL REFERENCES chat_events(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, chat_event_id)
);

CREATE TABLE policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  preset TEXT NOT NULL CHECK (preset IN ('balanced','banter_friendly','strict')),
  nuance TEXT NOT NULL DEFAULT '',
  blocked_domains JSONB NOT NULL DEFAULT '[]',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policy_versions_unique UNIQUE (workspace_id, version)
);

-- Durable action intents. operation_key is scoped per workspace: the same
-- scoped key + request hash replays the original operation; a reused key with
-- changed parameters is rejected.
CREATE TABLE action_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('delete_message','timeout_user','ban_user')),
  target_message_id TEXT NULL,
  target_user_id TEXT NOT NULL,
  duration_seconds INTEGER NULL,
  evidence_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  authority_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('preview','assist')),
  executor TEXT NOT NULL DEFAULT 'simulation' CHECK (executor = 'simulation'),
  state TEXT NOT NULL DEFAULT 'awaiting_approval',
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id TEXT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_outcome TEXT NULL,
  last_outcome_detail TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_intents_unique_key UNIQUE (workspace_id, operation_key)
);
CREATE INDEX action_intents_workspace_state_idx ON action_intents(workspace_id, state, updated_at DESC);
-- Per-target action serialization: at most one live operation per target
-- message while it is pre-terminal.
CREATE UNIQUE INDEX action_intents_target_live_uidx ON action_intents(workspace_id, target_message_id)
  WHERE target_message_id IS NOT NULL AND state IN ('awaiting_approval','queued','submitting','unknown');

-- Simulation ledger: every simulated attempt is recorded. Unknown outcomes
-- are reconciled by re-reading this ledger, never by blind retry.
CREATE TABLE action_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID NOT NULL REFERENCES action_intents(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  applied BOOLEAN NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_attempts_unique UNIQUE (intent_id, attempt_no)
);

-- No raw chat bodies in audit rows.
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  prev_state TEXT NULL,
  new_state TEXT NULL,
  rationale TEXT NULL,
  correlation_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_idx ON audit_events(workspace_id, created_at DESC);

-- Scoped monotonic update cursor + bounded update log for SSE resume.
CREATE TABLE workspace_seq (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE workspace_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_updates_unique UNIQUE (workspace_id, seq)
);
CREATE INDEX workspace_updates_workspace_seq_idx ON workspace_updates(workspace_id, seq DESC);
