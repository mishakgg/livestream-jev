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

export interface SimulatedEffectInput {
  workspaceId: string;
  channelId: string;
  intentId: string;
  operationKey: string;
  requestFingerprint: string;
  action: string;
  targetMessageId: string | null;
  targetUserId: string;
  durationSeconds: number | null;
  effect: string;
}

export interface SimulatedEffectRow extends SimulatedEffectInput {
  id: string;
  appliedAt: Date;
}

/**
 * Persist one simulated platform-side effect. Idempotent per intent: an
 * intent executes at most once, so a repeated insert is a no-op returning
 * the existing row. This is the simulated platform's state, not our receipt.
 */
export async function recordSimulatedEffect(
  client: PoolClient,
  input: SimulatedEffectInput
): Promise<SimulatedEffectRow> {
  const { rows } = await client.query<{
    id: string;
    applied_at: Date;
  }>(
    `INSERT INTO simulated_effects(
       workspace_id, channel_id, intent_id, operation_key, request_fingerprint,
       action, target_message_id, target_user_id, duration_seconds, effect
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (intent_id) DO NOTHING
     RETURNING id, applied_at`,
    [
      input.workspaceId,
      input.channelId,
      input.intentId,
      input.operationKey,
      input.requestFingerprint,
      input.action,
      input.targetMessageId,
      input.targetUserId,
      input.durationSeconds,
      input.effect,
    ]
  );
  const created = rows[0];
  if (created) return { ...input, id: created.id, appliedAt: created.applied_at };
  const existing = await client.query<{ id: string; applied_at: Date }>(
    "SELECT id, applied_at FROM simulated_effects WHERE intent_id = $1",
    [input.intentId]
  );
  const row = existing.rows[0];
  if (!row) throw new Error("simulated_effects row missing after idempotent insert");
  return { ...input, id: row.id, appliedAt: row.applied_at };
}

/**
 * Find the persisted effect for an exact operation. Every bound field must
 * match — workspace, channel, intent, operation key, request fingerprint,
 * action, and targets. Anything else fails closed (null): a foreign or
 * mismatched row is never evidence for this operation.
 */
export async function findSimulatedEffect(
  client: PoolClient,
  query: {
    workspaceId: string;
    channelId: string;
    intentId: string;
    operationKey: string;
    requestFingerprint: string;
    action: string;
    targetMessageId: string | null;
    targetUserId: string;
    durationSeconds: number | null;
  }
): Promise<SimulatedEffectRow | null> {
  const { rows } = await client.query<{
    id: string;
    workspace_id: string;
    channel_id: string;
    intent_id: string;
    operation_key: string;
    request_fingerprint: string;
    action: string;
    target_message_id: string | null;
    target_user_id: string;
    duration_seconds: number | null;
    effect: string;
    applied_at: Date;
  }>(
    `SELECT * FROM simulated_effects
     WHERE intent_id = $1
       AND workspace_id = $2
       AND channel_id = $3
       AND operation_key = $4
       AND request_fingerprint = $5
       AND action = $6
       AND target_message_id IS NOT DISTINCT FROM $7
       AND target_user_id = $8
       AND duration_seconds IS NOT DISTINCT FROM $9`,
    [
      query.intentId,
      query.workspaceId,
      query.channelId,
      query.operationKey,
      query.requestFingerprint,
      query.action,
      query.targetMessageId,
      query.targetUserId,
      query.durationSeconds,
    ]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    intentId: row.intent_id,
    operationKey: row.operation_key,
    requestFingerprint: row.request_fingerprint,
    action: row.action,
    targetMessageId: row.target_message_id,
    targetUserId: row.target_user_id,
    durationSeconds: row.duration_seconds,
    effect: row.effect,
    id: row.id,
    appliedAt: row.applied_at,
  };
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
