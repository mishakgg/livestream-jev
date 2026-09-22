-- M0 correctness pass: explicit chat-event processing states.
--
-- Outbox handoff (handed to pg-boss) is not processing completion. Health and
-- coverage must distinguish accepted, awaiting, classified, skipped, and
-- failed events from persisted state instead of inferring completion from
-- the undelivered-outbox count.

ALTER TABLE chat_events
  ADD COLUMN processing_state TEXT NOT NULL DEFAULT 'awaiting'
    CHECK (processing_state IN ('awaiting', 'classified', 'skipped', 'failed')),
  ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_error TEXT NULL;

-- Backfill rows processed before this migration existed.
UPDATE chat_events
SET processing_state = CASE WHEN skipped THEN 'skipped' ELSE 'classified' END,
    processing_attempts = 1
WHERE processed_time IS NOT NULL;

CREATE INDEX chat_events_workspace_state_idx ON chat_events(workspace_id, processing_state)
  WHERE processed_time IS NULL;
