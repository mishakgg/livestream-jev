-- M0 correctness pass: durable simulated-effect evidence.
--
-- The simulation executor's "platform side effect" must be persisted as data,
-- isolated by workspace/channel and bound to the exact operation identity,
-- action, target, and request fingerprint. Recovery and reconciliation may
-- only report success when a matching effect row exists; fault markers select
-- a failure scenario but never prove that an action happened.
--
-- This table is the simulated platform's state. It is distinct from our
-- receipt of the result (action_attempts): an effect row without a receipt
-- means "applied, acknowledgement lost" and honestly recovers to succeeded;
-- no effect row means success can never be reported.

CREATE TABLE simulated_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  intent_id UUID NOT NULL REFERENCES action_intents(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  action TEXT NOT NULL,
  target_message_id TEXT NULL,
  target_user_id TEXT NOT NULL,
  duration_seconds INTEGER NULL,
  effect TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An intent executes at most once: redelivery never re-executes, so at most
  -- one effect row can ever exist per intent.
  CONSTRAINT simulated_effects_unique_intent UNIQUE (intent_id)
);
CREATE INDEX simulated_effects_workspace_op_idx ON simulated_effects(workspace_id, operation_key);
