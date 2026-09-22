import type { FastifyInstance } from "fastify";
import { getPool, emitUpdate, recordAudit } from "@livestream/db";
import { z } from "zod";
import type {
  EvidenceMessage,
  IncidentDetail,
  IncidentState,
  IncidentSummary,
  Severity,
  SignalCategory,
} from "@livestream/contracts";
import { ClaimRequestSchema, ResolveRequestSchema } from "@livestream/contracts";
import { requireWorkspaceSession } from "../auth.js";
import { sendError } from "../errors.js";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const ListQuery = z.object({
  status: z.enum(["open", "claimed", "resolved", "dismissed", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

interface IncidentRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  category: SignalCategory;
  severity: Severity;
  title: string;
  summary: string;
  state: IncidentState;
  claimed_by_user_id: string | null;
  claimed_by_name: string | null;
  version: number;
  first_observed_at: Date;
  last_observed_at: Date;
  message_count: number;
  account_count: number;
  target_user_id: string | null;
  recommended_action: string;
  channel_rule: string;
  observed_pattern: string;
  uncertainty: string;
  eligible_actions: string[];
  policy_version: number;
  updated_at: Date;
}

function toSummary(row: IncidentRow): IncidentSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    state: row.state,
    claimedByUserId: row.claimed_by_user_id,
    claimedByDisplayName: row.claimed_by_name,
    version: row.version,
    firstObservedAt: row.first_observed_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    messageCount: row.message_count,
    accountCount: row.account_count,
    targetUserId: row.target_user_id,
    recommendedAction: row.recommended_action,
    policyVersion: row.policy_version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const MASKED_TEXT = "[Evidence masked: possible private information. Reveal deliberately from the evidence view.]";

function maskIfNeeded(category: SignalCategory, text: string, reveal: boolean): { text: string; masked: boolean } {
  if (category === "private_information_suspected" && !reveal) return { text: MASKED_TEXT, masked: true };
  return { text, masked: false };
}

const DetailQuery = z.object({ reveal: z.coerce.string().optional() });

export async function incidentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/incidents", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid list query.");
    const { status, limit, cursor } = parsed.data;

    let cursorClause = "";
    const values: unknown[] = [workspaceId];
    if (cursor) {
      try {
        const [rank, lastObserved, id] = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as [
          number,
          string,
          string,
        ];
        values.push(rank, lastObserved, id);
        cursorClause = `AND (CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.last_observed_at, i.id)
          > ($2, $3::timestamptz, $4::uuid)`;
      } catch {
        return sendError(reply, "bad_request", "Invalid cursor.");
      }
    }
    // Stream-issue reports live on the operational card, not the moderation inbox.
    const statusClause =
      status === "all"
        ? `AND i.category != 'stream_issue_report'`
        : `AND i.state = $${values.length + 1} AND i.category != 'stream_issue_report'`;
    if (status !== "all") values.push(status);
    values.push(limit + 1);

    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<IncidentRow>(
        `SELECT i.*, u.display_name AS claimed_by_name
         FROM incidents i LEFT JOIN users u ON u.id = i.claimed_by_user_id
         WHERE i.workspace_id = $1 ${cursorClause} ${statusClause}
         ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
                  i.last_observed_at DESC, i.id ASC
         LIMIT $${values.length}`,
        values as string[]
      );
      const page = rows.slice(0, limit);
      let nextCursor: string | null = null;
      if (rows.length > limit) {
        const last = page[page.length - 1];
        if (last) {
          nextCursor = Buffer.from(
            JSON.stringify([SEVERITY_RANK[last.severity], last.last_observed_at.toISOString(), last.id])
          ).toString("base64");
        }
      }
      return reply.send({ incidents: page.map(toSummary), nextCursor });
    } finally {
      client.release();
    }
  });

  app.get("/api/workspaces/:workspaceId/incidents/:id", async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const reveal = DetailQuery.safeParse(req.query).success
      ? (req.query as { reveal?: string }).reveal === "1"
      : false;
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<IncidentRow>(
        `SELECT i.*, u.display_name AS claimed_by_name
         FROM incidents i LEFT JOIN users u ON u.id = i.claimed_by_user_id
         WHERE i.id = $1 AND i.workspace_id = $2`,
        [id, workspaceId]
      );
      const row = rows[0];
      if (!row) return sendError(reply, "not_found", "Incident not found.");
      const evidence = await client.query<{
        id: string;
        platform_message_id: string;
        author_id: string;
        author_name: string;
        original_text: string;
        reply_to_message_id: string | null;
        provider_time: Date;
        origin: "replay" | "live";
      }>(
        `SELECT e.id, e.platform_message_id, e.author_id, e.author_name, e.original_text,
                e.reply_to_message_id, e.provider_time, e.origin
         FROM incident_events ie JOIN chat_events e ON e.id = ie.chat_event_id
         WHERE ie.incident_id = $1 ORDER BY e.provider_time ASC LIMIT 50`,
        [id]
      );
      // Bounded chronological context: up to 30 nearby messages in the same
      // channel; never the whole history.
      const context = await client.query<{
        id: string;
        platform_message_id: string;
        author_id: string;
        author_name: string;
        original_text: string;
        reply_to_message_id: string | null;
        provider_time: Date;
        origin: "replay" | "live";
      }>(
        `SELECT id, platform_message_id, author_id, author_name, original_text,
                reply_to_message_id, provider_time, origin
         FROM chat_events
         WHERE workspace_id = $1 AND kind = 'message'
           AND provider_time BETWEEN $2::timestamptz - interval '15 minutes' AND $3::timestamptz + interval '15 minutes'
         ORDER BY provider_time ASC LIMIT 31`,
        [workspaceId, row.first_observed_at, row.last_observed_at]
      );
      const evidenceIds = new Set(evidence.rows.map((e) => e.id));
      const contextRows = context.rows.filter((c) => !evidenceIds.has(c.id)).slice(0, 30);
      const contextTruncated = context.rows.length > 31 - 1 || context.rows.length === 31;

      if (reveal && row.category === "private_information_suspected") {
        await recordAudit(client, {
          workspaceId,
          actorUserId: auth.session.userId,
          operation: "evidence.reveal",
          entityType: "incident",
          entityId: id,
        });
      }

      const toEvidence = (e: {
        id: string;
        platform_message_id: string;
        author_id: string;
        author_name: string;
        original_text: string;
        reply_to_message_id: string | null;
        provider_time: Date;
        origin: "replay" | "live";
      }): EvidenceMessage => {
        const m = maskIfNeeded(row.category, e.original_text, reveal);
        return {
          id: e.id,
          platformMessageId: e.platform_message_id,
          authorId: e.author_id,
          authorName: e.author_name,
          text: m.text,
          masked: m.masked,
          replyToMessageId: e.reply_to_message_id,
          providerTime: e.provider_time.toISOString(),
          origin: e.origin,
        };
      };

      const detail: IncidentDetail = {
        ...toSummary(row),
        summary: row.summary,
        evidence: evidence.rows.map(toEvidence),
        context: contextRows.map(toEvidence),
        contextTruncated,
        channelRule: row.channel_rule,
        observedPattern: row.observed_pattern,
        uncertainty: row.uncertainty,
        eligibleActions: (row.eligible_actions as IncidentDetail["eligibleActions"]) ?? [],
        knownNativeActions: [],
      };
      return reply.send(detail);
    } finally {
      client.release();
    }
  });

  app.post("/api/workspaces/:workspaceId/incidents/:id/claim", async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = ClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Body must be { expectedVersion }.");
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        state: IncidentState;
        version: number;
        claimed_by_user_id: string | null;
      }>("SELECT state, version, claimed_by_user_id FROM incidents WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [
        id,
        workspaceId,
      ]);
      const current = rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Incident not found.");
      }
      if (current.version !== parsed.data.expectedVersion) {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", "Incident changed; refresh and retry.", {
          version: current.version,
          state: current.state,
        });
      }
      if (current.state === "claimed" && current.claimed_by_user_id !== auth.session.userId) {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", "Handled by another moderator.", {
          version: current.version,
          state: current.state,
        });
      }
      if (current.state !== "open" && current.state !== "claimed") {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", `Incident is already ${current.state}.`, {
          version: current.version,
          state: current.state,
        });
      }
      await client.query(
        `UPDATE incidents SET state = 'claimed', claimed_by_user_id = $3, version = version + 1, updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId, auth.session.userId]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: "incident.claim",
        entityType: "incident",
        entityId: id,
        prevState: current.state,
        newState: "claimed",
      });
      await emitUpdate(client, workspaceId, "incident", id);
      await client.query("COMMIT");
      const { rows: updated } = await client.query<IncidentRow>(
        `SELECT i.*, u.display_name AS claimed_by_name FROM incidents i
         LEFT JOIN users u ON u.id = i.claimed_by_user_id WHERE i.id = $1`,
        [id]
      );
      const row = updated[0];
      if (!row) return sendError(reply, "not_found", "Incident not found.");
      return reply.send(toSummary(row));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/api/workspaces/:workspaceId/incidents/:id/release", async (req, reply) => {
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
      const { rows } = await client.query<{
        state: IncidentState;
        claimed_by_user_id: string | null;
      }>("SELECT state, claimed_by_user_id FROM incidents WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [
        id,
        workspaceId,
      ]);
      const current = rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Incident not found.");
      }
      if (current.state === "open") {
        await client.query("COMMIT");
        const { rows: updated } = await client.query<IncidentRow>(
          `SELECT i.*, u.display_name AS claimed_by_name FROM incidents i
           LEFT JOIN users u ON u.id = i.claimed_by_user_id WHERE i.id = $1`,
          [id]
        );
        const row = updated[0];
        if (!row) return sendError(reply, "not_found", "Incident not found.");
        return reply.send(toSummary(row));
      }
      if (current.state !== "claimed") {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", `Incident is ${current.state}; cannot release.`);
      }
      if (current.claimed_by_user_id !== auth.session.userId && auth.session.role !== "owner") {
        await client.query("ROLLBACK");
        return sendError(reply, "permission_required", "Only the claim holder or owner can release.");
      }
      await client.query(
        `UPDATE incidents SET state = 'open', claimed_by_user_id = NULL, version = version + 1, updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: "incident.release",
        entityType: "incident",
        entityId: id,
        prevState: "claimed",
        newState: "open",
      });
      await emitUpdate(client, workspaceId, "incident", id);
      await client.query("COMMIT");
      const { rows: updated } = await client.query<IncidentRow>(
        `SELECT i.*, u.display_name AS claimed_by_name FROM incidents i
         LEFT JOIN users u ON u.id = i.claimed_by_user_id WHERE i.id = $1`,
        [id]
      );
      const row = updated[0];
      if (!row) return sendError(reply, "not_found", "Incident not found.");
      return reply.send(toSummary(row));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/api/workspaces/:workspaceId/incidents/:id/resolve", async (req, reply) => {
    const { workspaceId, id } = req.params as { workspaceId: string; id: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = ResolveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, "bad_request", "Body must be { expectedVersion, disposition, reason }.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ state: IncidentState; version: number }>(
        "SELECT state, version FROM incidents WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [id, workspaceId]
      );
      const current = rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Incident not found.");
      }
      if (current.version !== parsed.data.expectedVersion) {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", "Incident changed; refresh and retry.", {
          version: current.version,
          state: current.state,
        });
      }
      if (current.state !== "open" && current.state !== "claimed") {
        await client.query("ROLLBACK");
        return sendError(reply, "conflict", `Incident is already ${current.state}.`, {
          version: current.version,
          state: current.state,
        });
      }
      const next: IncidentState = parsed.data.disposition === "resolved" ? "resolved" : "dismissed";
      await client.query(
        `UPDATE incidents SET state = $3, resolved_reason = $4, version = version + 1, updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId, next, parsed.data.reason]
      );
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: next === "resolved" ? "incident.resolve" : "incident.dismiss",
        entityType: "incident",
        entityId: id,
        prevState: current.state,
        newState: next,
        rationale: parsed.data.reason,
      });
      await emitUpdate(client, workspaceId, "incident", id);
      await client.query("COMMIT");
      const { rows: updated } = await client.query<IncidentRow>(
        `SELECT i.*, u.display_name AS claimed_by_name FROM incidents i
         LEFT JOIN users u ON u.id = i.claimed_by_user_id WHERE i.id = $1`,
        [id]
      );
      const row = updated[0];
      if (!row) return sendError(reply, "not_found", "Incident not found.");
      return reply.send(toSummary(row));
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
