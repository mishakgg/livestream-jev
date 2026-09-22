import type { FastifyInstance } from "fastify";
import { getPool, emitUpdate, recordAudit } from "@livestream/db";
import { z } from "zod";
import type { Health, StreamIssueCard, WorkspaceInfo } from "@livestream/contracts";
import { requireWorkspaceSession } from "../auth.js";
import { sendError } from "../errors.js";

const ModeBody = z.object({ mode: z.enum(["preview", "assist"]) });
const PauseBody = z.object({ paused: z.boolean() });

async function workspaceInfo(workspaceId: string, role: "owner" | "moderator"): Promise<WorkspaceInfo | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      name: string;
      channel_id: string;
      mode: "preview" | "assist";
      paused: boolean;
      policy_version: number;
      authority_version: number;
    }>(
      `SELECT id, name, channel_id, mode, paused, policy_version, authority_version
       FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      channelId: row.channel_id,
      mode: row.mode,
      paused: row.paused,
      policyVersion: row.policy_version,
      authorityVersion: row.authority_version,
      role,
    };
  } finally {
    client.release();
  }
}

export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const info = await workspaceInfo(workspaceId, auth.session.role);
    if (!info) return sendError(reply, "not_found", "Workspace not found.");
    return reply.send(info);
  });

  // Explicit demo Preview <-> Assist transition. Owner only. Assist enables
  // human-approved SIMULATED actions; it never enables live writes in M0.
  app.post("/api/workspaces/:workspaceId/mode", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    if (auth.session.role !== "owner") {
      return sendError(reply, "permission_required", "Only the owner can change modes.");
    }
    const parsed = ModeBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Body must be { mode: preview | assist }.");
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ mode: string; authority_version: number }>(
        "SELECT mode, authority_version FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId]
      );
      const current = rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Workspace not found.");
      }
      await client.query(
        `UPDATE workspaces SET mode = $2, authority_version = authority_version + 1 WHERE id = $1`,
        [workspaceId, parsed.data.mode]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: "mode.change",
        entityType: "workspace",
        entityId: workspaceId,
        prevState: current.mode,
        newState: parsed.data.mode,
      });
      await emitUpdate(client, workspaceId, "mode", workspaceId);
      await client.query("COMMIT");
      const info = await workspaceInfo(workspaceId, auth.session.role);
      return reply.send(info);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // Pause fence: owner or moderator may pause; only the owner may re-enable.
  // Pause blocks new dispatch admission; already-submitting work is unaffected.
  app.post("/api/workspaces/:workspaceId/automation/pause", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = PauseBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Body must be { paused: boolean }.");
    if (parsed.data.paused === false && auth.session.role !== "owner") {
      return sendError(reply, "permission_required", "Only the owner can re-enable dispatch.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ paused: boolean }>(
        "SELECT paused FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId]
      );
      const current = rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Workspace not found.");
      }
      await client.query(
        `UPDATE workspaces SET paused = $2, authority_version = authority_version + 1 WHERE id = $1`,
        [workspaceId, parsed.data.paused]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: parsed.data.paused ? "dispatch.pause" : "dispatch.resume",
        entityType: "workspace",
        entityId: workspaceId,
        prevState: String(current.paused),
        newState: String(parsed.data.paused),
      });
      await emitUpdate(client, workspaceId, "health", workspaceId);
      await client.query("COMMIT");
      const info = await workspaceInfo(workspaceId, auth.session.role);
      return reply.send(info);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.get("/api/workspaces/:workspaceId/health", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      const ws = await client.query<{
        mode: "preview" | "assist";
        paused: boolean;
      }>("SELECT mode, paused FROM workspaces WHERE id = $1", [workspaceId]);
      const w = ws.rows[0];
      if (!w) return sendError(reply, "not_found", "Workspace not found.");
      const counts = await client.query<{
        received: string;
        evaluated: string;
        skipped: string;
        classified: string;
        awaiting: string;
        failed: string;
        last_processed: string | null;
      }>(
        `SELECT COUNT(*)::text AS received,
                COUNT(*) FILTER (WHERE processed_time IS NOT NULL)::text AS evaluated,
                COUNT(*) FILTER (WHERE skipped)::text AS skipped,
                COUNT(*) FILTER (WHERE processing_state = 'classified')::text AS classified,
                COUNT(*) FILTER (WHERE processing_state = 'awaiting')::text AS awaiting,
                COUNT(*) FILTER (WHERE processing_state = 'failed')::text AS failed,
                MAX(processed_time)::text AS last_processed
         FROM chat_events WHERE workspace_id = $1`,
        [workspaceId]
      );
      const c = counts.rows[0] ?? {
        received: "0",
        evaluated: "0",
        skipped: "0",
        classified: "0",
        awaiting: "0",
        failed: "0",
        last_processed: null,
      };
      const deliveries = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM duplicate_deliveries WHERE workspace_id = $1",
        [workspaceId]
      );
      const queue = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM outbox WHERE workspace_id = $1 AND delivered = FALSE",
        [workspaceId]
      );
      const open = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM incidents WHERE workspace_id = $1 AND state IN ('open','claimed') AND category != 'stream_issue_report'",
        [workspaceId]
      );
      const received = Number(c.received);
      const evaluated = Number(c.evaluated);
      const skipped = Number(c.skipped);
      const classified = Number(c.classified);
      const awaiting = Number(c.awaiting);
      const failed = Number(c.failed);
      const dedup = Number(deliveries.rows[0]?.n ?? "0");
      const queueDepth = Number(queue.rows[0]?.n ?? "0");
      const writesDisabled = w.mode === "preview" || w.paused;
      // Coverage keys on persisted processing state, never on transport
      // handoff: an outbox row marked delivered (handed to the queue) says
      // nothing about whether the event was ever classified.
      const coverage =
        received === 0
          ? "Waiting for replay: no events received yet."
          : failed > 0
            ? `Attention: ${failed} event(s) failed processing and need review; ${awaiting} awaiting classification.`
            : awaiting > 0
              ? `${awaiting} event(s) awaiting classification; queue handoff is not completion.`
              : queueDepth > 0
                ? `Processing: ${queueDepth} event(s) pending confirmed handoff to the queue.`
                : `Up to date: ${classified} classified, ${skipped} skipped observations (fake deterministic classifier).`;
      const health: Health = {
        workspaceId,
        mode: w.mode,
        paused: w.paused,
        connection: "demo-replay",
        writesDisabled,
        writesDisabledReason: w.mode === "preview"
          ? "Preview: recommendations only, no writes of any kind."
          : w.paused
            ? "Dispatch paused: new approvals are blocked until the owner resumes."
            : "Assist (demo): human-approved SIMULATED actions only. No live platform writes exist in M0.",
        queueDepth,
        receivedEvents: received,
        deduplicatedDeliveries: Math.max(0, dedup),
        evaluatedEvents: evaluated,
        skippedEvents: skipped,
        classifiedEvents: classified,
        awaitingProcessing: awaiting,
        failedEvents: failed,
        outboxPending: queueDepth,
        openIncidents: Number(open.rows[0]?.n ?? "0"),
        classifier: "fake-deterministic",
        lastProcessedAt: c.last_processed,
        coverage,
      };
      return reply.send(health);
    } finally {
      client.release();
    }
  });

  // Compact chat-reported stream-problem card. Counts come from persisted
  // events only; repeated reports by one account never become N viewers.
  app.get("/api/workspaces/:workspaceId/stream-issues", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{
        id: string;
        message_count: number;
        account_count: number;
        first_observed_at: string;
        last_observed_at: string;
        acknowledged: boolean;
        state: string;
      }>(
        `SELECT id, message_count, account_count, first_observed_at, last_observed_at, acknowledged, state
         FROM incidents
         WHERE workspace_id = $1 AND category = 'stream_issue_report' AND state IN ('open','claimed')
         ORDER BY last_observed_at DESC LIMIT 1`,
        [workspaceId]
      );
      const row = rows[0];
      if (!row) {
        const card: StreamIssueCard = {
          workspaceId,
          distinctAccounts: 0,
          messageCount: 0,
          windowMinutes: 2,
          firstObservedAt: null,
          lastObservedAt: null,
          headline: "No stream problems reported in chat.",
          incidentId: null,
          acknowledged: false,
        };
        return reply.send(card);
      }
      const card: StreamIssueCard = {
        workspaceId,
        distinctAccounts: row.account_count,
        messageCount: row.message_count,
        windowMinutes: 2,
        firstObservedAt: new Date(row.first_observed_at).toISOString(),
        lastObservedAt: new Date(row.last_observed_at).toISOString(),
        headline:
          row.account_count === 0
            ? "No stream problems reported in chat."
            : `${row.account_count} distinct account(s) reported audio/video problems in recent chat.`,
        incidentId: row.id,
        acknowledged: row.acknowledged || row.state !== "open",
      };
      return reply.send(card);
    } finally {
      client.release();
    }
  });
}
