import type { FastifyInstance } from "fastify";
import { getPool } from "@livestream/db";
import { ReplayBatchSchema } from "@livestream/contracts";
import { requireWorkspaceSession } from "../auth.js";
import { demoEnabled, sendError } from "../errors.js";
import { acceptReplayBatch } from "../intake.js";

export async function replayRoutes(app: FastifyInstance): Promise<void> {
  // Deterministic synthetic replay intake. Development/demo only; production
  // refuses. Authenticated + workspace-scoped like every other mutation.
  app.post("/api/workspaces/:workspaceId/replay", async (req, reply) => {
    if (!demoEnabled()) return sendError(reply, "not_found", "Not found.");
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = ReplayBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, "bad_request", "Invalid replay batch: events[0..500] with delivery/message ids and ISO providerTime.");
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      const ws = await client.query<{ channel_id: string }>(
        "SELECT channel_id FROM workspaces WHERE id = $1",
        [workspaceId]
      );
      const channelId = ws.rows[0]?.channel_id;
      if (!channelId) return sendError(reply, "not_found", "Workspace not found.");
      const result = await acceptReplayBatch(client, {
        workspaceId,
        channelId,
        events: parsed.data.events,
      });
      return reply.send(result);
    } finally {
      client.release();
    }
  });
}
