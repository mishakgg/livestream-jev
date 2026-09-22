import { beforeEach, describe, expect, it } from "vitest";
import { findSimulatedEffect, getPool, recordSimulatedEffect } from "@livestream/db";
import type { ActionIntent, IncidentDetail, IncidentSummary } from "@livestream/contracts";
import { SimulationExecutor } from "@livestream/platforms";
import {
  injectAuthed,
  loadFixture,
  loginAll,
  processOutbox,
  replayBatch,
  runDispatch,
  setMode,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Durable simulated evidence: success may only be reported when a persisted,
// exactly-bound effect row exists. Fault markers select a failure scenario;
// they never prove that an action happened.
// ---------------------------------------------------------------------------

let keyCounter = 0;
function freshKey(prefix: string): string {
  keyCounter += 1;
  return `key-${prefix}-${Date.now()}-${keyCounter}`;
}

async function spamIncident(token: string): Promise<{ summary: IncidentSummary; detail: IncidentDetail }> {
  const list = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/incidents?status=open&limit=50", token });
  const incidents = (list.json() as { incidents: IncidentSummary[] }).incidents;
  const summary = incidents.find((i) => i.category === "spam");
  if (!summary) throw new Error("no open spam incident");
  const res = await injectAuthed({ method: "GET", url: `/api/workspaces/demo-alpha/incidents/${summary.id}`, token });
  return { summary, detail: res.json() as IncidentDetail };
}

async function queuedDelete(
  ctx: Ctx,
  targetMessageId: string,
  targetUserId: string,
  keyPrefix: string
): Promise<{ intent: ActionIntent; version: number; policyVersion: number }> {
  const { summary } = await spamIncident(ctx.bob.token);
  const created = await injectAuthed({
    method: "POST",
    url: "/api/workspaces/demo-alpha/actions",
    payload: {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId,
      targetUserId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    },
    headers: { "Idempotency-Key": freshKey(keyPrefix) },
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
  return { intent: approved.json() as ActionIntent, version: summary.version, policyVersion: summary.policyVersion };
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

async function effectCount(intentId: string): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM simulated_effects WHERE intent_id = $1", [intentId]);
    return Number(rows[0]?.n ?? "0");
  } finally {
    client.release();
  }
}

async function setIntentState(id: string, state: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("UPDATE action_intents SET state = $2, updated_at = now() WHERE id = $1", [id, state]);
  } finally {
    client.release();
  }
}

interface IntentBinding {
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

async function readBinding(intentId: string): Promise<IntentBinding> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      workspace_id: string;
      channel_id: string;
      operation_key: string;
      request_hash: string;
      action: string;
      target_message_id: string | null;
      target_user_id: string;
      duration_seconds: number | null;
    }>(
      `SELECT workspace_id, channel_id, operation_key, request_hash, action,
              target_message_id, target_user_id, duration_seconds
       FROM action_intents WHERE id = $1`,
      [intentId]
    );
    const r = rows[0];
    if (!r) throw new Error("intent missing");
    return {
      workspaceId: r.workspace_id,
      channelId: r.channel_id,
      intentId,
      operationKey: r.operation_key,
      requestFingerprint: r.request_hash,
      action: r.action,
      targetMessageId: r.target_message_id,
      targetUserId: r.target_user_id,
      durationSeconds: r.duration_seconds,
    };
  } finally {
    client.release();
  }
}

async function recordEffectFor(intentId: string, effect: string): Promise<void> {
  const binding = await readBinding(intentId);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await recordSimulatedEffect(client, { ...binding, effect });
  } finally {
    client.release();
  }
}

class SimulatedCrash extends Error {
  constructor(public point: string) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

describe("durable simulated evidence and recovery", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    await setMode("demo-alpha", ctx.alice.token, "assist");
  });

  it("an action that was never applied stays unknown — never succeeded by target name", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const { intent } = await queuedDelete(ctx, target.platformMessageId, target.authorId, "rec-never");
    // Crash after admission, before any simulated effect was recorded.
    await setIntentState(intent.id, "submitting");
    expect(await effectCount(intent.id)).toBe(0);

    const executor = new SimulationExecutor();
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("recovered");
    expect(out.state).toBe("unknown");
    expect(executor.callCount).toBe(0);
    expect(await effectCount(intent.id)).toBe(0);
  });

  it("crash between admission and effect persists unknown without re-execution", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[1] ?? detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const { intent } = await queuedDelete(ctx, target.platformMessageId, target.authorId, "rec-crash");
    const executor = new SimulationExecutor();
    await expect(
      runDispatch(intent.id, executor, {
        beforeEffectPersist: async () => {
          throw new SimulatedCrash("before-effect");
        },
      })
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await intentState(intent.id)).toBe("submitting");
    expect(await effectCount(intent.id)).toBe(0);

    const callsBefore = executor.callCount;
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("recovered");
    expect(out.state).toBe("unknown");
    expect(executor.callCount).toBe(callsBefore);
  });

  it("effect applied but acknowledgement lost recovers to succeeded from evidence", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[2] ?? detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const { intent } = await queuedDelete(ctx, target.platformMessageId, target.authorId, "rec-lostack");
    const firstExecutor = new SimulationExecutor();
    await expect(
      runDispatch(intent.id, firstExecutor, {
        afterEffectPersist: async () => {
          throw new SimulatedCrash("after-effect");
        },
      })
    ).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await intentState(intent.id)).toBe("submitting");
    expect(await effectCount(intent.id)).toBe(1);

    // A fresh executor/process recovers purely from durable evidence.
    const fresh = new SimulationExecutor();
    const out = await runDispatch(intent.id, fresh);
    expect(out.status).toBe("recovered");
    expect(out.state).toBe("succeeded");
    expect(fresh.callCount).toBe(0);
    expect(await effectCount(intent.id)).toBe(1);
  });

  it("duplicate delivery after receipt is a no-op; repeated reconciliation is stable", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[3] ?? detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const { intent } = await queuedDelete(ctx, target.platformMessageId, target.authorId, "rec-dupe");
    const first = await runDispatch(intent.id);
    expect(first.state).toBe("succeeded");
    const second = await runDispatch(intent.id, first.executor);
    expect(second.status).toBe("duplicate");
    expect(first.executor.callCount).toBe(1);
    expect(await effectCount(intent.id)).toBe(1);
  });

  it("ambiguous outcomes stay unknown across redelivery and reconciliation", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    const pool = getPool();
    const probe = await pool.connect();
    let incidentId = "";
    let version = 0;
    let policyVersion = 1;
    try {
      const { rows } = await probe.query<{ incident_id: string; version: number; policy_version: number }>(
        `SELECT ie.incident_id, i.version, i.policy_version FROM incident_events ie
         JOIN chat_events e ON e.id = ie.chat_event_id
         JOIN incidents i ON i.id = ie.incident_id
         WHERE e.workspace_id = 'demo-alpha' AND e.platform_message_id = 'msg-unknown-001'`
      );
      incidentId = rows[0]?.incident_id ?? "";
      version = rows[0]?.version ?? 0;
      policyVersion = rows[0]?.policy_version ?? 1;
    } finally {
      probe.release();
    }
    expect(incidentId).not.toBe("");
    const created = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: {
        incidentId,
        action: "delete_message",
        targetMessageId: "msg-unknown-001",
        targetUserId: "viewer-unknown-01",
        expectedIncidentVersion: version,
        expectedPolicyVersion: policyVersion,
      },
      headers: { "Idempotency-Key": freshKey("rec-amb") },
      token: ctx.bob.token,
    });
    expect(created.statusCode).toBe(201);
    const intent = created.json() as ActionIntent;
    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: version, expectedPolicyVersion: policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(200);

    const executor = new SimulationExecutor();
    const done = await runDispatch(intent.id, executor);
    expect(done.state).toBe("unknown");
    expect(executor.callCount).toBe(1);
    expect(await effectCount(intent.id)).toBe(0);

    const redelivered = await runDispatch(intent.id, executor);
    expect(redelivered.status).toBe("duplicate");
    expect(executor.callCount).toBe(1);

    for (let i = 0; i < 2; i += 1) {
      const reconciled = await injectAuthed({
        method: "POST",
        url: `/api/workspaces/demo-alpha/actions/${intent.id}/reconcile`,
        payload: {},
        token: ctx.bob.token,
      });
      expect(reconciled.statusCode).toBe(409);
      expect((reconciled.json() as { code: string }).code).toBe("outcome_unknown");
    }
    expect(await intentState(intent.id)).toBe("unknown");
    expect(await effectCount(intent.id)).toBe(0);
  });

  it("foreign or mismatched effect rows never satisfy another operation", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const t1 = detail.evidence[0];
    const t2 = detail.evidence[1];
    if (!t1 || !t2) throw new Error("need two evidence targets");
    const first = await queuedDelete(ctx, t1.platformMessageId, t1.authorId, "rec-iso-a");
    const second = await queuedDelete(ctx, t2.platformMessageId, t2.authorId, "rec-iso-b");

    // An effect bound to the first operation exists; the second operation
    // (crashed, submitting, no effect of its own) must stay unknown.
    await recordEffectFor(first.intent.id, "deleted_message");
    await setIntentState(second.intent.id, "submitting");
    const out = await runDispatch(second.intent.id);
    expect(out.state).toBe("unknown");

    // A row whose binding was tampered with (wrong workspace) also fails closed.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("UPDATE simulated_effects SET workspace_id = 'demo-beta' WHERE intent_id = $1", [first.intent.id]);
      const binding = await readBinding(first.intent.id);
      const found = await findSimulatedEffect(client, binding);
      expect(found).toBeNull();
    } finally {
      client.release();
    }
  });

  it("reconciliation confirms only from persisted evidence, not markers", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    const pool = getPool();
    const probe = await pool.connect();
    let incidentId = "";
    let version = 0;
    let policyVersion = 1;
    try {
      const { rows } = await probe.query<{ incident_id: string; version: number; policy_version: number }>(
        `SELECT ie.incident_id, i.version, i.policy_version FROM incident_events ie
         JOIN chat_events e ON e.id = ie.chat_event_id
         JOIN incidents i ON i.id = ie.incident_id
         WHERE e.workspace_id = 'demo-alpha' AND e.platform_message_id = 'msg-unknown-001'`
      );
      incidentId = rows[0]?.incident_id ?? "";
      version = rows[0]?.version ?? 0;
      policyVersion = rows[0]?.policy_version ?? 1;
    } finally {
      probe.release();
    }
    const created = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: {
        incidentId,
        action: "delete_message",
        targetMessageId: "msg-unknown-001",
        targetUserId: "viewer-unknown-01",
        expectedIncidentVersion: version,
        expectedPolicyVersion: policyVersion,
      },
      headers: { "Idempotency-Key": freshKey("rec-ev") },
      token: ctx.bob.token,
    });
    const intent = created.json() as ActionIntent;
    await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: version, expectedPolicyVersion: policyVersion },
      token: ctx.bob.token,
    });
    await runDispatch(intent.id);
    expect(await intentState(intent.id)).toBe("unknown");

    // The ambiguous marker says nothing; a persisted, exactly-bound effect
    // row is the only thing that can confirm application.
    await recordEffectFor(intent.id, "deleted_message");
    const reconciled = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/reconcile`,
      payload: {},
      token: ctx.bob.token,
    });
    expect(reconciled.statusCode).toBe(200);
    expect((reconciled.json() as ActionIntent).state).toBe("reconciled_succeeded");
  });

  it("reconciliation without evidence stays unknown even for ordinary targets", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[4] ?? detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const { intent } = await queuedDelete(ctx, target.platformMessageId, target.authorId, "rec-noev");
    await setIntentState(intent.id, "unknown");
    expect(await effectCount(intent.id)).toBe(0);
    const reconciled = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/reconcile`,
      payload: {},
      token: ctx.bob.token,
    });
    expect(reconciled.statusCode).toBe(409);
    expect((reconciled.json() as { code: string }).code).toBe("outcome_unknown");
    expect(await intentState(intent.id)).toBe("unknown");
  });

  it("reconciliation past the dispatch window without evidence resolves to refused", async () => {
    const { detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[5] ?? detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const { intent } = await queuedDelete(ctx, target.platformMessageId, target.authorId, "rec-cutoff");
    await setIntentState(intent.id, "unknown");
    // Age the intent past UNKNOWN_OUTCOME_CUTOFF_SECONDS: no admitted
    // attempt can still be mid-flight, so "no effect" is definitive.
    const pool = getPool();
    const aged = await pool.connect();
    try {
      await aged.query("UPDATE action_intents SET created_at = now() - interval '300 seconds' WHERE id = $1", [intent.id]);
    } finally {
      aged.release();
    }
    expect(await effectCount(intent.id)).toBe(0);
    const reconciled = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/reconcile`,
      payload: {},
      token: ctx.bob.token,
    });
    expect(reconciled.statusCode).toBe(200);
    expect((reconciled.json() as ActionIntent).state).toBe("refused");
    expect(await intentState(intent.id)).toBe("refused");
  });
});
