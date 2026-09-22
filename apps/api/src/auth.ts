import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { getPool } from "@livestream/db";
import type { MembershipRole } from "@livestream/contracts";
import { isProduction } from "./errors.js";

export interface Session {
  userId: string;
  displayName: string;
  platformUserId: string;
  workspaceId: string;
  role: MembershipRole;
  token: string;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const token = h.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Resolve a demo session. Production never honors demo tokens. */
export async function resolveSession(client: PoolClient, token: string): Promise<Session | null> {
  if (isProduction()) return null;
  const { rows } = await client.query<{
    user_id: string;
    display_name: string;
    platform_user_id: string;
    workspace_id: string;
    role: MembershipRole;
    token: string;
  }>(
    `SELECT s.user_id, u.display_name, u.platform_user_id, s.workspace_id, m.role, s.token
     FROM demo_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    displayName: row.display_name,
    platformUserId: row.platform_user_id,
    workspaceId: row.workspace_id,
    role: row.role,
    token: row.token,
  };
}

export async function requireSession(req: FastifyRequest): Promise<Session | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await resolveSession(client, token);
  } finally {
    client.release();
  }
}

/**
 * Require membership in the URL workspace. Scope comes from the session, never
 * from the request body. Returns the session, or null when the caller must
 * receive 401/403 (the route decides which, without leaking tenant data).
 */
export async function requireWorkspaceSession(
  req: FastifyRequest,
  workspaceId: string
): Promise<{ session: Session } | { error: "unauthorized" | "forbidden" }> {
  const session = await requireSession(req);
  if (!session) return { error: "unauthorized" };
  if (session.workspaceId !== workspaceId) return { error: "forbidden" };
  return { session };
}

const DEMO_USERS: Record<string, { userId: string; workspaceId: string }> = {
  alice: { userId: "user-alice", workspaceId: "demo-alpha" },
  bob: { userId: "user-bob", workspaceId: "demo-alpha" },
  cara: { userId: "user-cara", workspaceId: "demo-alpha" },
  dave: { userId: "user-dave", workspaceId: "demo-beta" },
  erin: { userId: "user-erin", workspaceId: "demo-beta" },
};

/** Development-only demo login. Production refuses (route returns 404 first). */
export async function demoLogin(username: string): Promise<Session | null> {
  if (isProduction()) return null;
  const mapping = DEMO_USERS[username.trim().toLowerCase()];
  if (!mapping) return null;
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      display_name: string;
      platform_user_id: string;
      role: MembershipRole;
    }>(
      `SELECT u.display_name, u.platform_user_id, m.role
       FROM users u JOIN memberships m ON m.user_id = u.id AND m.workspace_id = $2
       WHERE u.id = $1`,
      [mapping.userId, mapping.workspaceId]
    );
    const row = rows[0];
    if (!row) return null;
    const token = `demo_${randomBytes(24).toString("hex")}`;
    await client.query(
      `INSERT INTO demo_sessions(token, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '24 hours')`,
      [token, mapping.userId, mapping.workspaceId]
    );
    return {
      userId: mapping.userId,
      displayName: row.display_name,
      platformUserId: row.platform_user_id,
      workspaceId: mapping.workspaceId,
      role: row.role,
      token,
    };
  } finally {
    client.release();
  }
}
