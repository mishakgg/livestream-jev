import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// PostgreSQL access: explicit parameterized queries, versioned migrations.
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

export function getPool(connectionString?: string): Pool {
  if (!pool) {
    const cs = connectionString ?? process.env.DATABASE_URL;
    if (!cs) throw new Error("DATABASE_URL is not configured");
    pool = new pg.Pool({ connectionString: cs, max: 10, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

/** Test-only: reset the shared pool so integration tests can switch databases. */
export function __resetPoolForTests(): void {
  pool = null;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export function migrationsDir(): string {
  // dist/src -> package root -> migrations
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "migrations");
}

export async function migrate(client: PoolClient, dir?: string): Promise<string[]> {
  const folder = dir ?? migrationsDir();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const files = readdirSync(folder)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const newly: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(folder, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newly.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  return newly;
}

export async function withTx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Atomically bump the scoped update cursor and record an update row. */
export async function emitUpdate(
  client: PoolClient,
  workspaceId: string,
  kind: string,
  refId: string
): Promise<number> {
  await client.query(
    `INSERT INTO workspace_seq(workspace_id, seq) VALUES ($1, 0)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId]
  );
  const { rows } = await client.query<{ seq: string }>(
    `UPDATE workspace_seq SET seq = seq + 1 WHERE workspace_id = $1 RETURNING seq`,
    [workspaceId]
  );
  const row = rows[0];
  if (!row) throw new Error("workspace_seq row missing");
  const seq = Number(row.seq);
  await client.query(
    `INSERT INTO workspace_updates(workspace_id, seq, kind, ref_id) VALUES ($1, $2, $3, $4)`,
    [workspaceId, seq, kind, refId]
  );
  // Bound the per-workspace update log.
  await client.query(
    `DELETE FROM workspace_updates WHERE workspace_id = $1 AND seq <= $2 - 500`,
    [workspaceId, seq]
  );
  return seq;
}

export async function recordAudit(
  client: PoolClient,
  row: {
    workspaceId: string;
    actorUserId: string;
    operation: string;
    entityType: string;
    entityId: string;
    prevState?: string | null;
    newState?: string | null;
    rationale?: string | null;
    correlationId?: string | null;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(workspace_id, actor_user_id, operation, entity_type, entity_id, prev_state, new_state, rationale, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.workspaceId,
      row.actorUserId,
      row.operation,
      row.entityType,
      row.entityId,
      row.prevState ?? null,
      row.newState ?? null,
      row.rationale ?? null,
      row.correlationId ?? null,
    ]
  );
}
