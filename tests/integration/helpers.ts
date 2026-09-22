import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, InjectOptions } from "fastify";
import { getPool } from "@livestream/db";
import type { DemoSession, ReplayEvent } from "@livestream/contracts";
import { buildApp } from "../../apps/api/src/app.js";
import { dispatchAction, processEvent } from "../../apps/worker/src/pipeline.js";
import { SimulationExecutor } from "@livestream/platforms";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

let app: FastifyInstance | null = null;

export async function testApp(): Promise<FastifyInstance> {
  if (!app) app = await buildApp();
  return app;
}

export interface Ctx {
  alice: DemoSession; // owner α
  bob: DemoSession; // mod α
  cara: DemoSession; // mod α
  dave: DemoSession; // owner β
  erin: DemoSession; // mod β
}

export async function login(username: string): Promise<DemoSession> {
  const a = await testApp();
  const res = await a.inject({ method: "POST", url: "/api/demo/login", payload: { username } });
  if (res.statusCode !== 200) throw new Error(`login ${username} failed: ${res.statusCode} ${res.body}`);
  return res.json() as DemoSession;
}

export async function loginAll(): Promise<Ctx> {
  const [alice, bob, cara, dave, erin] = await Promise.all(
    ["alice", "bob", "cara", "dave", "erin"].map(login)
  );
  if (!alice || !bob || !cara || !dave || !erin) throw new Error("seed login failed");
  return { alice, bob, cara, dave, erin };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function injectAuthed(opts: InjectOptions & { token: string }) {
  const a = await testApp();
  const { token, ...rest } = opts;
  return a.inject({ ...rest, headers: { ...(rest.headers as Record<string, string> | undefined), ...auth(token) } });
}

export async function truncateAndSeed(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      `TRUNCATE workspaces, users, memberships, demo_sessions, chat_events, deliveries,
        duplicate_deliveries, outbox, incidents, incident_events, policy_versions, action_intents,
        action_attempts, simulated_effects, audit_events, workspace_seq, workspace_updates CASCADE`
    );
    for (const [id, name, channel] of [
      ["demo-alpha", "Demo Alpha (synthetic)", "channel-alpha"],
      ["demo-beta", "Demo Beta (synthetic)", "channel-beta"],
    ]) {
      await client.query(
        `INSERT INTO workspaces(id, name, channel_id, mode, paused, policy_version, authority_version)
         VALUES ($1, $2, $3, 'preview', FALSE, 1, 1)`,
        [id, name, channel]
      );
      await client.query(`INSERT INTO workspace_seq(workspace_id, seq) VALUES ($1, 0)`, [id]);
    }
    for (const [id, display, platform] of [
      ["user-alice", "Alice Owner", "twitch-owner-alpha"],
      ["user-bob", "Bob Mod", "twitch-mod-alpha-1"],
      ["user-cara", "Cara Mod", "twitch-mod-alpha-2"],
      ["user-dave", "Dave Owner", "twitch-owner-beta"],
      ["user-erin", "Erin Mod", "twitch-mod-beta-1"],
    ]) {
      await client.query(`INSERT INTO users(id, display_name, platform_user_id) VALUES ($1, $2, $3)`, [id, display, platform]);
    }
    for (const [ws, user, role] of [
      ["demo-alpha", "user-alice", "owner"],
      ["demo-alpha", "user-bob", "moderator"],
      ["demo-alpha", "user-cara", "moderator"],
      ["demo-beta", "user-dave", "owner"],
      ["demo-beta", "user-erin", "moderator"],
    ]) {
      await client.query(`INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)`, [ws, user, role]);
    }
    for (const [ws, owner] of [["demo-alpha", "user-alice"], ["demo-beta", "user-dave"]]) {
      await client.query(
        `INSERT INTO policy_versions(workspace_id, version, preset, nuance, blocked_domains, created_by_user_id)
         VALUES ($1, 1, 'balanced', '', '["scammy-claim.example"]', $2)`,
        [ws, owner]
      );
    }
  } finally {
    client.release();
  }
}

export function loadFixture(name: string): ReplayEvent[] {
  const raw = JSON.parse(readFileSync(join(repoRoot, "fixtures", name), "utf8") as string) as Record<string, unknown>[];
  return raw.map((e) => {
    const { _note: _ignored, ...rest } = e;
    void _ignored;
    return rest as unknown as ReplayEvent;
  });
}

export async function replayBatch(
  workspaceId: string,
  token: string,
  events: ReplayEvent[]
): Promise<{ accepted: number; duplicates: number; eventIds: string[] }> {
  const res = await injectAuthed({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/replay`,
    payload: { events },
    token,
  });
  if (res.statusCode !== 200) throw new Error(`replay failed: ${res.statusCode} ${res.body}`);
  return res.json() as { accepted: number; duplicates: number; eventIds: string[] };
}

/**
 * Mimic the worker's outbox dispatcher + pg-boss handlers synchronously (no
 * queue in integration tests): process every pending chat_event outbox row
 * through the real pipeline and mark rows delivered.
 */
export async function processOutbox(): Promise<{ processed: number; duplicates: number }> {
  const pool = getPool();
  let processed = 0;
  let duplicates = 0;
  for (;;) {
    const client = await pool.connect();
    let row: { id: string; aggregate_id: string } | undefined;
    try {
      const { rows } = await client.query<{ id: string; aggregate_id: string }>(
        `SELECT id, aggregate_id FROM outbox WHERE delivered = FALSE AND aggregate_type = 'chat_event'
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
      );
      row = rows[0];
      if (!row) return { processed, duplicates };
      const outcome = await processEvent(client, row.aggregate_id);
      await client.query("UPDATE outbox SET delivered = TRUE WHERE id = $1", [row.id]);
      if (outcome.status === "duplicate") duplicates += 1;
      else processed += 1;
    } finally {
      client.release();
    }
    void row;
  }
}

/** Run simulated dispatch for a queued intent with a fresh executor. */
export async function runDispatch(
  intentId: string,
  executor?: SimulationExecutor,
  hooks?: import("../../apps/worker/src/pipeline.js").DispatchHooks,
  useClient?: import("pg").PoolClient
): Promise<{ status: string; state: string; executor: SimulationExecutor }> {
  const ex = executor ?? new SimulationExecutor();
  if (useClient) {
    const out = await dispatchAction(useClient, intentId, ex, hooks);
    return { ...out, executor: ex };
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    const out = await dispatchAction(client, intentId, ex, hooks);
    return { ...out, executor: ex };
  } finally {
    client.release();
  }
}

/** Deterministic in-process barrier: `await entered`, then `release()`. */
export function makeGate(): { entered: Promise<void>; release: () => void; enter: () => Promise<void> } {
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    signalEntered = r;
  });
  const proceed = new Promise<void>((r) => {
    release = r;
  });
  return {
    entered,
    release,
    enter: async () => {
      signalEntered();
      await proceed;
    },
  };
}

export async function setMode(workspaceId: string, token: string, mode: "preview" | "assist"): Promise<void> {
  const res = await injectAuthed({ method: "POST", url: `/api/workspaces/${workspaceId}/mode`, payload: { mode }, token });
  if (res.statusCode !== 200) throw new Error(`setMode failed: ${res.statusCode} ${res.body}`);
}

// Test-only helper: `table` is always a literal in tests, never user input.
export async function dbCount(table: string, where = "", params: unknown[] = []): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table} ${where}`, params as string[]);
    return Number(rows[0]?.n ?? "0");
  } finally {
    client.release();
  }
}
