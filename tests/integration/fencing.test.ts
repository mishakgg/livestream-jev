import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@livestream/db";
import type { PoolClient } from "pg";
import type { ActionIntent, IncidentDetail, IncidentSummary } from "@livestream/contracts";
import { SimulationExecutor } from "@livestream/platforms";
import {
  injectAuthed,
  loadFixture,
  loginAll,
  makeGate,
  processOutbox,
  replayBatch,
  runDispatch,
  setMode,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Authority fencing: pause / mode / policy changes share one serialized
// per-workspace boundary with dispatch admission. These tests use separate
// PostgreSQL connections and explicit barriers (in-process gates plus
// lock_timeout), never timing-dependent sleeps.
// ---------------------------------------------------------------------------

async function spamIncident(token: string): Promise<{ summary: IncidentSummary; detail: IncidentDetail }> {
  const list = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/incidents?status=open&limit=50", token });
  const incidents = (list.json() as { incidents: IncidentSummary[] }).incidents;
  const summary = incidents.find((i) => i.category === "spam");
  if (!summary) throw new Error("no open spam incident");
  const res = await injectAuthed({ method: "GET", url: `/api/workspaces/demo-alpha/incidents/${summary.id}`, token });
  return { summary, detail: res.json() as IncidentDetail };
}

async function queuedIntent(ctx: Ctx): Promise<ActionIntent> {
  const { summary, detail } = await spamIncident(ctx.bob.token);
  const target = detail.evidence[0];
  if (!target) throw new Error("no evidence");
  const created = await injectAuthed({
    method: "POST",
    url: "/api/workspaces/demo-alpha/actions",
    payload: {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    },
    headers: { "Idempotency-Key": `key-fence-${Date.now()}-${Math.random()}` },
    token: ctx.bob.token,
  });
  expect(created.statusCode).toBe(201);
  const intent = created.json() as ActionIntent;
  const approved = await injectAuthed({
    method: "POST",
    url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
    payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
    token: ctx.bob.token,
  });
  expect(approved.statusCode).toBe(200);
  return (approved.json() as ActionIntent);
}

async function intentState(id: string): Promise<string> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ state: string }>("SELECT state FROM action_intents WHERE id = $1", [id]);
    return rows[0]?.state ?? "missing";
  } finally {
    client.release();
  }
}

async function attemptCount(id: string): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM action_attempts WHERE intent_id = $1", [id]);
    return Number(rows[0]?.n ?? "0");
  } finally {
    client.release();
  }
}

type ControlResult = { ok: true } | { ok: false; code: string };

/** Pause written the way the route writes it, but with a lock timeout so a
 *  blocked control change fails fast and deterministically instead of
 *  hanging the test. */
async function tryPause(client: PoolClient, timeoutMs: number): Promise<ControlResult> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
  try {
    await client.query("SELECT paused FROM workspaces WHERE id = 'demo-alpha' FOR UPDATE");
    await client.query("UPDATE workspaces SET paused = TRUE, authority_version = authority_version + 1 WHERE id = 'demo-alpha'");
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, code: (err as { code?: string }).code ?? "unknown" };
  }
}

async function tryModeToPreview(client: PoolClient, timeoutMs: number): Promise<ControlResult> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
  try {
    await client.query("SELECT mode FROM workspaces WHERE id = 'demo-alpha' FOR UPDATE");
    await client.query("UPDATE workspaces SET mode = 'preview', authority_version = authority_version + 1 WHERE id = 'demo-alpha'");
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, code: (err as { code?: string }).code ?? "unknown" };
  }
}

async function tryPolicySave(client: PoolClient, timeoutMs: number): Promise<ControlResult> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
  try {
    const cur = await client.query<{ policy_version: number }>(
      "SELECT policy_version FROM workspaces WHERE id = 'demo-alpha' FOR UPDATE"
    );
    const next = (cur.rows[0]?.policy_version ?? 1) + 1;
    await client.query(
      `INSERT INTO policy_versions(workspace_id, version, preset, nuance, blocked_domains, created_by_user_id)
       VALUES ('demo-alpha', $1, 'strict', '', '[]', 'user-alice')`,
      [next]
    );
    await client.query("UPDATE workspaces SET policy_version = $1 WHERE id = 'demo-alpha'", [next]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, code: (err as { code?: string }).code ?? "unknown" };
  }
}

describe("authority fencing (pause / mode / policy vs dispatch)", () => {
  let ctx: Ctx;
  const held: PoolClient[] = [];

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    await setMode("demo-alpha", ctx.alice.token, "assist");
  });

  afterEach(async () => {
    for (const c of held.splice(0)) {
      try {
        await c.query("ROLLBACK");
      } catch {
        // Already released or idle; ignore.
      }
      c.release();
    }
  });

  async function holdWorkspaceLock(): Promise<PoolClient> {
    const pool = getPool();
    const c = await pool.connect();
    held.push(c);
    await c.query("BEGIN");
    await c.query("SELECT id FROM workspaces WHERE id = 'demo-alpha' FOR UPDATE");
    return c;
  }

  it("a pause cannot interleave dispatch admission: the control change waits on the fence", async () => {
    const intent = await queuedIntent(ctx);
    const gate = makeGate();
    const executor = new SimulationExecutor();
    const pool = getPool();
    const dispatchConn = await pool.connect();
    const controlConn = await pool.connect();
    try {
      const running = runDispatch(intent.id, executor, { afterAdmissionLocks: gate.enter }, dispatchConn);
      await gate.entered;
      // Dispatch holds the authority fence: the pause must block (lock timeout
      // turns the block into a deterministic error), never sneak through.
      const paused = await tryPause(controlConn, 2000);
      gate.release();
      const out = await running;
      expect(paused.ok).toBe(false);
      if (!paused.ok) expect(paused.code).toBe("55P03");
      // Dispatch crossed admission before the pause: in flight, completes.
      expect(out.state).toBe("succeeded");
      expect(executor.callCount).toBe(1);
      expect(await attemptCount(intent.id)).toBe(1);
      // The pause itself then commits normally.
      const retry = await tryPause(controlConn, 5000);
      expect(retry.ok).toBe(true);
      expect(await intentState(intent.id)).toBe("succeeded");
    } finally {
      dispatchConn.release();
      controlConn.release();
    }
  });

  it("an Assist-to-Preview change cannot interleave dispatch admission", async () => {
    const intent = await queuedIntent(ctx);
    const gate = makeGate();
    const executor = new SimulationExecutor();
    const pool = getPool();
    const dispatchConn = await pool.connect();
    const controlConn = await pool.connect();
    try {
      const running = runDispatch(intent.id, executor, { afterAdmissionLocks: gate.enter }, dispatchConn);
      await gate.entered;
      const flipped = await tryModeToPreview(controlConn, 2000);
      gate.release();
      const out = await running;
      expect(flipped.ok).toBe(false);
      if (!flipped.ok) expect(flipped.code).toBe("55P03");
      expect(out.state).toBe("succeeded");
      expect(executor.callCount).toBe(1);
    } finally {
      dispatchConn.release();
      controlConn.release();
    }
  });

  it("a policy save cannot interleave dispatch admission", async () => {
    const intent = await queuedIntent(ctx);
    const gate = makeGate();
    const executor = new SimulationExecutor();
    const pool = getPool();
    const dispatchConn = await pool.connect();
    const controlConn = await pool.connect();
    try {
      const running = runDispatch(intent.id, executor, { afterAdmissionLocks: gate.enter }, dispatchConn);
      await gate.entered;
      const saved = await tryPolicySave(controlConn, 2000);
      gate.release();
      const out = await running;
      expect(saved.ok).toBe(false);
      if (!saved.ok) expect(saved.code).toBe("55P03");
      expect(out.state).toBe("succeeded");
      expect(executor.callCount).toBe(1);
    } finally {
      dispatchConn.release();
      controlConn.release();
    }
  });

  it("dispatch seeks the same fence: it blocks on a held authority lock", async () => {
    const intent = await queuedIntent(ctx);
    const holder = await holdWorkspaceLock();
    const pool = getPool();
    const dispatchConn = await pool.connect();
    try {
      await dispatchConn.query("SET lock_timeout = '2000ms'");
      const executor = new SimulationExecutor();
      await expect(runDispatch(intent.id, executor, undefined, dispatchConn)).rejects.toMatchObject({ code: "55P03" });
      expect(executor.callCount).toBe(0);
      expect(await intentState(intent.id)).toBe("queued");
    } finally {
      await dispatchConn.query("RESET lock_timeout");
      dispatchConn.release();
    }
    void holder;
  });

  it("a committed pause refuses dispatch (pause wins the race)", async () => {
    const intent = await queuedIntent(ctx);
    const paused = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/automation/pause",
      payload: { paused: true },
      token: ctx.alice.token,
    });
    expect(paused.statusCode).toBe(200);
    const executor = new SimulationExecutor();
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("refused");
    expect(executor.callCount).toBe(0);
    expect(await intentState(intent.id)).toBe("refused");
  });

  it("a committed Assist-to-Preview change refuses dispatch (mode wins the race)", async () => {
    const intent = await queuedIntent(ctx);
    await setMode("demo-alpha", ctx.alice.token, "preview");
    const executor = new SimulationExecutor();
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("refused");
    expect(executor.callCount).toBe(0);
    expect(await intentState(intent.id)).toBe("refused");
  });

  it("a committed policy change supersedes dispatch (policy wins the race)", async () => {
    const intent = await queuedIntent(ctx);
    const saved = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/policy",
      payload: { preset: "strict", nuance: "", blockedDomains: [] },
      token: ctx.alice.token,
    });
    expect(saved.statusCode).toBe(200);
    const executor = new SimulationExecutor();
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("refused");
    expect(out.state).toBe("superseded");
    expect(executor.callCount).toBe(0);
  });

  it("approvals during a committed pause are rejected without queueing dispatchable work", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const created = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: {
        incidentId: summary.id,
        action: "delete_message",
        targetMessageId: target.platformMessageId,
        targetUserId: target.authorId,
        expectedIncidentVersion: summary.version,
        expectedPolicyVersion: summary.policyVersion,
      },
      headers: { "Idempotency-Key": "key-fence-approve-paused" },
      token: ctx.bob.token,
    });
    expect(created.statusCode).toBe(201);
    const intent = created.json() as ActionIntent;
    const paused = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/automation/pause",
      payload: { paused: true },
      token: ctx.alice.token,
    });
    expect(paused.statusCode).toBe(200);
    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(409);
    expect((approved.json() as { code: string }).code).toBe("paused");
    const executor = new SimulationExecutor();
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("duplicate");
    expect(executor.callCount).toBe(0);
  });
});
