import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPool } from "@livestream/db";
import { z } from "zod";
import { bearerToken, resolveSession, type Session } from "../auth.js";
import { sendError } from "../errors.js";

const EventsQuery = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  token: z.string().min(1).max(256).optional(),
});

async function sessionForStream(req: FastifyRequest, workspaceId: string): Promise<Session | null> {
  // EventSource cannot set headers, so the demo client passes ?token=.
  // Production will use HttpOnly cookies + CSRF; this fallback exists only
  // for the development demo transport.
  const header = bearerToken(req);
  const query = req.query as { token?: string };
  const token = header ?? query.token ?? null;
  if (!token) return null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    const session = await resolveSession(client, token);
    if (!session || session.workspaceId !== workspaceId) return null;
    return session;
  } finally {
    client.release();
  }
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  // Scoped update stream with bounded resume. Duplicates are harmless; an
  // expired cursor triggers a fresh snapshot, not an unlimited replay.
  app.get("/api/workspaces/:workspaceId/events", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const parsed = EventsQuery.safeParse(req.query);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid cursor.");
    const session = await sessionForStream(req, workspaceId);
    if (!session) return sendError(reply, "unauthorized", "Authentication required.");

    const pool = getPool();
    const client = await pool.connect();
    const current = await client.query<{ seq: string }>(
      "SELECT seq FROM workspace_seq WHERE workspace_id = $1",
      [workspaceId]
    );
    client.release();
    let last = parsed.data.cursor;
    const head = Number(current.rows[0]?.seq ?? "0");
    // Expired or future cursor: fresh snapshot from head.
    if (last > head || last < head - 500) last = head;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify({ seq: head })}\n\n`);

    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(`: heartbeat\n\n`);
    }, 15_000);
    const poller = setInterval(() => {
      void (async () => {
        if (closed) return;
        const c = await pool.connect();
        try {
          // Close resumed streams after revoked membership.
          const still = await resolveSession(c, session.token);
          if (!still || still.workspaceId !== workspaceId) {
            closed = true;
            reply.raw.write(`event: revoked\ndata: {}\n\n`);
            reply.raw.end();
            return;
          }
          const { rows } = await c.query<{ seq: string; kind: string; ref_id: string; created_at: Date }>(
            `SELECT seq, kind, ref_id, created_at FROM workspace_updates
             WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 100`,
            [workspaceId, last]
          );
          for (const row of rows) {
            last = Number(row.seq);
            reply.raw.write(
              `event: update\ndata: ${JSON.stringify({ seq: last, kind: row.kind, refId: row.ref_id, at: row.created_at.toISOString() })}\n\n`
            );
          }
        } catch {
          // Transient poll failure: keep the stream open; the client resumes.
        } finally {
          c.release();
        }
      })();
    }, 1500);

    req.raw.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poller);
    });
    // Hijacked: fastify must not send its own response.
    return reply;
  });

  // JSON polling fallback (used by tests and non-SSE clients).
  app.get("/api/workspaces/:workspaceId/updates", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const parsed = EventsQuery.safeParse(req.query);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid cursor.");
    const header = bearerToken(req);
    const query = req.query as { token?: string };
    const token = header ?? query.token ?? null;
    if (!token) return sendError(reply, "unauthorized", "Authentication required.");
    const pool = getPool();
    const client = await pool.connect();
    try {
      const session = await resolveSession(client, token);
      if (!session || session.workspaceId !== workspaceId) {
        return sendError(reply, "unauthorized", "Authentication required.");
      }
      const current = await client.query<{ seq: string }>(
        "SELECT seq FROM workspace_seq WHERE workspace_id = $1",
        [workspaceId]
      );
      const head = Number(current.rows[0]?.seq ?? "0");
      let since = parsed.data.cursor;
      let reset = false;
      if (since > head || since < head - 500) {
        since = head;
        reset = true;
      }
      const { rows } = await client.query<{ seq: string; kind: string; ref_id: string; created_at: Date }>(
        `SELECT seq, kind, ref_id, created_at FROM workspace_updates
         WHERE workspace_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 100`,
        [workspaceId, since]
      );
      return reply.send({
        head,
        reset,
        updates: rows.map((r) => ({
          seq: Number(r.seq),
          kind: r.kind,
          refId: r.ref_id,
          at: r.created_at.toISOString(),
        })),
      });
    } finally {
      client.release();
    }
  });
}
