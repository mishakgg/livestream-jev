import type { FastifyInstance } from "fastify";
import { getPool, emitUpdate, recordAudit } from "@livestream/db";
import {
  ApproveActionRequestSchema,
  CreateActionRequestSchema,
} from "@livestream/contracts";
import type { ActionIntent, ActionIntentState } from "@livestream/contracts";
import { APPROVAL_TTL_MS, canonicalActionRequest, requestHash } from "@livestream/domain";
import { SimulationExecutor } from "@livestream/platforms";
import { requireWorkspaceSession } from "../auth.js";
import { sendError } from "../errors.js";

interface IntentRow {
  id: string;
  workspace_id: string;
  incident_id: string;
  operation_key: string;
  request_hash: string;
  action: ActionIntent["action"];
  target_message_id: string | null;
  target_user_id: string;
  duration_seconds: number | null;
  state: ActionIntentState;
  actor_user_id: string;
  policy_version: number;
  evidence_version: number;
  authority_version: number;
  mode: "preview" | "assist";
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  last_outcome: ActionIntent["lastOutcome"];
  last_outcome_detail: string | null;
}

function toIntent(row: IntentRow): ActionIntent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    incidentId: row.incident_id,
    operationKey: row.operation_key,
    action: row.action,
    targetMessageId: row.target_message_id,
    targetUserId: row.target_user_id,
    durationSeconds: row.duration_seconds,
    state: row.state,
    actorUserId: row.actor_user_id,
    policyVersion: row.policy_version,
    evidenceVersion: row.evidence_version,
    mode: row.mode,
    executor: "simulation",
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastOutcome: row.last_outcome,
    lastOutcomeDetail: row.last_outcome_detail,
  };
}

function idempotencyKey(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || key.length < 8 || key.length > 128) return null;
  return key;
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  // Create a human-approved action request. Preview refuses: proposals never
  // enter a dispatchable queue. Same scoped key + request hash replays the
  // original operation instead of creating a duplicate.
  app.post("/api/workspaces/:workspaceId/actions", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const key = idempotencyKey(req);
    if (!key) {
      return sendError(reply, "bad_request", "Idempotency-Key header (8-128 chars) is required.");
    }
    const parsed = CreateActionRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid action request.");
    const body = parsed.data;

    // M0 supports human-approved SIMULATED delete/timeout only. Bans stay as
    // human review items; no automatic bans exist in any milestone slice here.
    if (body.action === "ban_user") {
      return sendError(reply, "unsupported_capability", "M0 supports simulated delete/timeout only. Bans remain manual review items.");
    }
    if (body.action === "delete_message" && !body.targetMessageId) {
      // A missing message id is rejected — never interpreted as clearing chat.
      return sendError(reply, "missing_target", "delete_message requires the exact targetMessageId from stored evidence.");
    }
    if (body.action === "timeout_user" && body.durationSeconds === undefined) {
      return sendError(reply, "bad_request", "timeout_user requires an explicit durationSeconds.");
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      const ws = await client.query<{
        mode: "preview" | "assist";
        paused: boolean;
        policy_version: number;
        authority_version: number;
        channel_id: string;
      }>(
        "SELECT mode, paused, policy_version, authority_version, channel_id FROM workspaces WHERE id = $1",
        [workspaceId]
      );
      const w = ws.rows[0];
      if (!w) return sendError(reply, "not_found", "Workspace not found.");
      if (w.mode === "preview") {
        return sendError(reply, "preview_no_writes", "Preview never performs writes. Switch to Assist to request a simulated action.");
      }
      if (w.paused) {
        return sendError(reply, "paused", "Dispatch is paused. New approvals are blocked until the owner resumes.");
      }

      const inc = await client.query<{
        version: number;
        eligible_actions: string[];
        state: string;
      }>("SELECT version, eligible_actions, state FROM incidents WHERE id = $1 AND workspace_id = $2", [
        body.incidentId,
        workspaceId,
      ]);
      const incident = inc.rows[0];
      if (!incident) return sendError(reply, "not_found", "Incident not found.");
      if (body.expectedPolicyVersion !== w.policy_version) {
        return sendError(reply, "policy_changed", "Policy changed; refresh and re-request.", {
          policyVersion: w.policy_version,
        });
      }
      if (body.expectedIncidentVersion !== incident.version) {
        return sendError(reply, "stale_evidence", "Incident changed; refresh and re-request.", {
          version: incident.version,
        });
      }
      if (!incident.eligible_actions.includes(body.action)) {
        return sendError(reply, "unsupported_capability", "This incident category does not allow that action.");
      }

      // Exact targets must come from stored evidence in this workspace.
      if (body.action === "delete_message" && body.targetMessageId) {
        const t = await client.query<{ id: string }>(
          `SELECT e.id FROM chat_events e
           JOIN incident_events ie ON ie.chat_event_id = e.id
           WHERE ie.incident_id = $1 AND e.workspace_id = $2 AND e.platform_message_id = $3`,
          [body.incidentId, workspaceId, body.targetMessageId]
        );
        if (!t.rows[0]) {
          return sendError(reply, "missing_target", "Target message is not part of this incident's stored evidence.");
        }
      }
      if (body.action === "timeout_user") {
        const t = await client.query<{ id: string }>(
          `SELECT e.id FROM chat_events e
           JOIN incident_events ie ON ie.chat_event_id = e.id
           WHERE ie.incident_id = $1 AND e.workspace_id = $2 AND e.author_id = $3 LIMIT 1`,
          [body.incidentId, workspaceId, body.targetUserId]
        );
        if (!t.rows[0]) {
          return sendError(reply, "missing_target", "Target user has no stored evidence in this incident.");
        }
      }

      const hash = requestHash(
        canonicalActionRequest({
          workspaceId,
          incidentId: body.incidentId,
          action: body.action,
          targetMessageId: body.targetMessageId ?? null,
          targetUserId: body.targetUserId,
          durationSeconds: body.durationSeconds ?? null,
        })
      );

      // Idempotent replay: same key + same hash returns the original.
      const existing = await client.query<IntentRow>("SELECT * FROM action_intents WHERE workspace_id = $1 AND operation_key = $2", [
        workspaceId,
        key,
      ]);
      const prior = existing.rows[0];
      if (prior) {
        if (prior.request_hash !== hash) {
          return sendError(reply, "idempotency_conflict", "Idempotency-Key was already used with different parameters.");
        }
        return reply.send(toIntent(prior));
      }

      await client.query("BEGIN");
      try {
        const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
        const { rows } = await client.query<IntentRow>(
          `INSERT INTO action_intents(
             workspace_id, channel_id, incident_id, operation_key, request_hash, action,
             target_message_id, target_user_id, duration_seconds, evidence_version,
             policy_version, authority_version, mode, executor, state, actor_user_id, expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'assist','simulation','awaiting_approval',$13,$14)
           RETURNING *`,
          [
            workspaceId,
            w.channel_id,
            body.incidentId,
            key,
            hash,
            body.action,
            body.targetMessageId ?? null,
            body.targetUserId,
            body.durationSeconds ?? null,
            incident.version,
            w.policy_version,
            w.authority_version,
            auth.session.userId,
            expiresAt,
          ]
        );
        const created = rows[0];
        if (!created) throw new Error("action_intents insert returned no row");
        await recordAudit(client, {
          workspaceId,
          actorUserId: auth.session.userId,
          operation: "action.request",
          entityType: "action_intent",
          entityId: created.id,
          newState: "awaiting_approval",
        });
        await emitUpdate(client, workspaceId, "action", created.id);
        await client.query("COMMIT");
        return reply.status(201).send(toIntent(created));
      } catch (err) {
        await client.query("ROLLBACK");
        if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") {
          return sendError(reply, "conflict", "Another operation is already in flight for this target.");
        }
        throw err;
      }
    } finally {
      client.release();
    }
  });

  // Approve a requested action: revalidates versions, authority, mode, pause,
  // and target existence, then queues for the simulation executor.
  app.post("/api/workspaces/:workspaceId/actions/:id/approve", async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = ApproveActionRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Body must be { expectedIncidentVersion, expectedPolicyVersion }.");

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<IntentRow>(
        "SELECT * FROM action_intents WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [id, workspaceId]
      );
      const intent = locked.rows[0];
      if (!intent) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Action not found.");
      }
      if (intent.state !== "awaiting_approval") {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", `Action is already ${intent.state}.`, { state: intent.state });
      }
      if (intent.expires_at.getTime() <= Date.now()) {
        await client.query("UPDATE action_intents SET state = 'expired', updated_at = now() WHERE id = $1", [id]);
        await recordAudit(client, {
          workspaceId,
          actorUserId: auth.session.userId,
          operation: "action.expire",
          entityType: "action_intent",
          entityId: id,
          prevState: "awaiting_approval",
          newState: "expired",
        });
        await emitUpdate(client, workspaceId, "action", id);
        await client.query("COMMIT");
        return sendError(reply, "expired", "Approval expired after 120 seconds. Re-request against current evidence.");
      }

      const ws = await client.query<{
        mode: "preview" | "assist";
        paused: boolean;
        policy_version: number;
        authority_version: number;
      }>("SELECT mode, paused, policy_version, authority_version FROM workspaces WHERE id = $1", [workspaceId]);
      const w = ws.rows[0];
      if (!w) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Workspace not found.");
      }
      if (w.mode === "preview") {
        await client.query("ROLLBACK");
        return sendError(reply, "preview_no_writes", "Workspace returned to Preview; approvals cannot dispatch.");
      }
      if (w.paused) {
        await client.query("ROLLBACK");
        return sendError(reply, "paused", "Dispatch is paused.");
      }
      if (w.authority_version !== intent.authority_version) {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", "Authority changed since the request (mode/pause transition). Re-request.", {
          authorityVersion: w.authority_version,
        });
      }

      const inc = await client.query<{ version: number; eligible_actions: string[] }>(
        "SELECT version, eligible_actions FROM incidents WHERE id = $1 AND workspace_id = $2",
        [intent.incident_id, workspaceId]
      );
      const incident = inc.rows[0];
      if (!incident) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Incident not found.");
      }
      if (parsed.data.expectedPolicyVersion !== w.policy_version || intent.policy_version !== w.policy_version) {
        await client.query(
          "UPDATE action_intents SET state = 'superseded', last_outcome_detail = 'Policy changed since request.', updated_at = now() WHERE id = $1",
          [id]
        );
        await recordAudit(client, {
          workspaceId,
          actorUserId: auth.session.userId,
          operation: "action.supersede",
          entityType: "action_intent",
          entityId: id,
          prevState: "awaiting_approval",
          newState: "superseded",
          rationale: "policy_changed",
        });
        await emitUpdate(client, workspaceId, "action", id);
        await client.query("COMMIT");
        return sendError(reply, "policy_changed", "Policy changed since the request.", {
          policyVersion: w.policy_version,
        });
      }
      if (parsed.data.expectedIncidentVersion !== incident.version || intent.evidence_version !== incident.version) {
        await client.query(
          "UPDATE action_intents SET state = 'superseded', last_outcome_detail = 'Evidence changed since request.', updated_at = now() WHERE id = $1",
          [id]
        );
        await recordAudit(client, {
          workspaceId,
          actorUserId: auth.session.userId,
          operation: "action.supersede",
          entityType: "action_intent",
          entityId: id,
          prevState: "awaiting_approval",
          newState: "superseded",
          rationale: "stale_evidence",
        });
        await emitUpdate(client, workspaceId, "action", id);
        await client.query("COMMIT");
        return sendError(reply, "stale_evidence", "Evidence changed since the request.", {
          version: incident.version,
        });
      }
      if (!incident.eligible_actions.includes(intent.action)) {
        await client.query("ROLLBACK");
        return sendError(reply, "unsupported_capability", "Policy no longer allows this action for the incident.");
      }

      // Re-resolve the exact target from stored evidence.
      if (intent.action === "delete_message" && intent.target_message_id) {
        const t = await client.query<{ id: string }>(
          `SELECT e.id FROM chat_events e JOIN incident_events ie ON ie.chat_event_id = e.id
           WHERE ie.incident_id = $1 AND e.workspace_id = $2 AND e.platform_message_id = $3`,
          [intent.incident_id, workspaceId, intent.target_message_id]
        );
        if (!t.rows[0]) {
          await client.query(
            "UPDATE action_intents SET state = 'refused', last_outcome = 'refused', last_outcome_detail = 'Approved target no longer exists.', updated_at = now() WHERE id = $1",
            [id]
          );
          await emitUpdate(client, workspaceId, "action", id);
          await client.query("COMMIT");
          return sendError(reply, "missing_target", "Approved target no longer exists in stored evidence.");
        }
      }

      await client.query(
        `UPDATE action_intents SET state = 'queued', approved_by_user_id = $2, approved_at = now(), updated_at = now()
         WHERE id = $1`,
        [id, auth.session.userId]
      );
      await client.query(
        `INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'action_intent', $2, $3)`,
        [workspaceId, id, JSON.stringify({ intentId: id })]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: "action.approve",
        entityType: "action_intent",
        entityId: id,
        prevState: "awaiting_approval",
        newState: "queued",
      });
      await emitUpdate(client, workspaceId, "action", id);
      await client.query("COMMIT");
      const { rows } = await client.query<IntentRow>("SELECT * FROM action_intents WHERE id = $1", [id]);
      const updated = rows[0];
      if (!updated) return sendError(reply, "not_found", "Action not found.");
      return reply.send(toIntent(updated));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // Durable status for refresh/recovery. Never re-executes.
  app.get("/api/workspaces/:workspaceId/actions/:id", async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<IntentRow>(
        "SELECT * FROM action_intents WHERE id = $1 AND workspace_id = $2",
        [id, workspaceId]
      );
      const intent = rows[0];
      if (!intent) return sendError(reply, "not_found", "Action not found.");
      return reply.send(toIntent(intent));
    } finally {
      client.release();
    }
  });

  // List intents for an incident (scoped), so a refresh recovers the original
  // operation instead of creating a duplicate.
  app.get("/api/workspaces/:workspaceId/actions", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const query = req.query as { incidentId?: string };
    if (!query.incidentId) return sendError(reply, "bad_request", "Query must include incidentId.");
    const pool = getPool();
    const client = await pool.connect();
    try {
      const inc = await client.query<{ id: string }>(
        "SELECT id FROM incidents WHERE id = $1 AND workspace_id = $2",
        [query.incidentId, workspaceId]
      );
      if (!inc.rows[0]) return sendError(reply, "not_found", "Incident not found.");
      const { rows } = await client.query<IntentRow>(
        "SELECT * FROM action_intents WHERE workspace_id = $1 AND incident_id = $2 ORDER BY created_at ASC LIMIT 50",
        [workspaceId, query.incidentId]
      );
      return reply.send({ actions: rows.map(toIntent) });
    } finally {
      client.release();
    }
  });

  // Reconcile an unknown outcome by re-reading the simulation ledger. This
  // never submits: a refused reconcile needs a brand-new intent to retry.
  app.post("/api/workspaces/:workspaceId/actions/:id/reconcile", async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<IntentRow>(
        "SELECT * FROM action_intents WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [id, workspaceId]
      );
      const intent = locked.rows[0];
      if (!intent) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Action not found.");
      }
      if (intent.state !== "unknown") {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", `Only unknown outcomes need reconciliation (state: ${intent.state}).`, {
          state: intent.state,
        });
      }
      const executor = new SimulationExecutor();
      const found = await executor.reconcile({
        targetMessageId: intent.target_message_id,
        targetUserId: intent.target_user_id,
      });
      if (found.applied === null) {
        await client.query("ROLLBACK");
        return sendError(reply, "outcome_unknown", `Reconciliation still ambiguous: ${found.detail}`);
      }
      const next: ActionIntentState = found.applied ? "reconciled_succeeded" : "refused";
      await client.query(
        `UPDATE action_intents SET state = $2, last_outcome_detail = $3, updated_at = now() WHERE id = $1`,
        [id, next, found.detail]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: "action.reconcile",
        entityType: "action_intent",
        entityId: id,
        prevState: "unknown",
        newState: next,
      });
      await emitUpdate(client, workspaceId, "action", id);
      await client.query("COMMIT");
      const { rows } = await client.query<IntentRow>("SELECT * FROM action_intents WHERE id = $1", [id]);
      const updated = rows[0];
      if (!updated) return sendError(reply, "not_found", "Action not found.");
      return reply.send(toIntent(updated));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
