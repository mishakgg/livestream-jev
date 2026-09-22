import type { FastifyInstance } from "fastify";
import { getPool, emitUpdate, recordAudit } from "@livestream/db";
import { PolicyDraftSchema } from "@livestream/contracts";
import { previewPolicy } from "@livestream/domain";
import type { PolicyVersion } from "@livestream/contracts";
import { requireWorkspaceSession } from "../auth.js";
import { sendError } from "../errors.js";

export async function policyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/workspaces/:workspaceId/policy", async (req, reply) => {
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
      const ws = await client.query<{ policy_version: number }>(
        "SELECT policy_version FROM workspaces WHERE id = $1",
        [workspaceId]
      );
      const current = ws.rows[0];
      if (!current) return sendError(reply, "not_found", "Workspace not found.");
      const { rows } = await client.query<{
        version: number;
        preset: PolicyVersion["preset"];
        nuance: string;
        blocked_domains: string[];
        created_by_user_id: string;
        created_at: Date;
      }>(
        `SELECT version, preset, nuance, blocked_domains, created_by_user_id, created_at
         FROM policy_versions WHERE workspace_id = $1 AND version = $2`,
        [workspaceId, current.policy_version]
      );
      const row = rows[0];
      if (!row) return sendError(reply, "not_found", "Policy version not found.");
      const policy: PolicyVersion = {
        version: row.version,
        preset: row.preset,
        nuance: row.nuance,
        blockedDomains: row.blocked_domains ?? [],
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at.toISOString(),
      };
      return reply.send({ policy, preview: previewPolicy({ preset: policy.preset, nuance: policy.nuance, blockedDomains: policy.blockedDomains }) });
    } finally {
      client.release();
    }
  });

  // Policy preview: pure computation over the submitted draft. It performs
  // ZERO writes (no policy, audit, outbox, or update rows) so reviewers can
  // inspect the effective policy safely. Covered by the zero-write test.
  app.post("/api/workspaces/:workspaceId/policy/preview", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    const parsed = PolicyDraftSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid policy draft.");
    return reply.send(previewPolicy(parsed.data));
  });

  // Owner-only versioned save. Versions are immutable once approved.
  app.post("/api/workspaces/:workspaceId/policy", async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const auth = await requireWorkspaceSession(req, workspaceId);
    if ("error" in auth) {
      return auth.error === "unauthorized"
        ? sendError(reply, "unauthorized", "Authentication required.")
        : sendError(reply, "forbidden", "No access to this workspace.");
    }
    if (auth.session.role !== "owner") {
      return sendError(reply, "permission_required", "Only the owner can save policy.");
    }
    const parsed = PolicyDraftSchema.safeParse(req.body);
    if (!parsed.success) return sendError(reply, "bad_request", "Invalid policy draft.");
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ws = await client.query<{ policy_version: number }>(
        "SELECT policy_version FROM workspaces WHERE id = $1 FOR UPDATE",
        [workspaceId]
      );
      const current = ws.rows[0];
      if (!current) {
        await client.query("ROLLBACK");
        return sendError(reply, "not_found", "Workspace not found.");
      }
      const next = current.policy_version + 1;
      await client.query(
        `INSERT INTO policy_versions(workspace_id, version, preset, nuance, blocked_domains, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [workspaceId, next, parsed.data.preset, parsed.data.nuance, JSON.stringify(parsed.data.blockedDomains), auth.session.userId]
      );
      await client.query("UPDATE workspaces SET policy_version = $2 WHERE id = $1", [workspaceId, next]);
      await recordAudit(client, {
        workspaceId,
        actorUserId: auth.session.userId,
        operation: "policy.save",
        entityType: "policy",
        entityId: String(next),
        prevState: String(current.policy_version),
        newState: String(next),
      });
      await emitUpdate(client, workspaceId, "policy", String(next));
      await client.query("COMMIT");
      return reply.send({
        policy: {
          version: next,
          preset: parsed.data.preset,
          nuance: parsed.data.nuance,
          blockedDomains: parsed.data.blockedDomains,
          createdByUserId: auth.session.userId,
        },
        preview: previewPolicy(parsed.data),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}
