import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@livestream/db";
import type { ActionIntent, IncidentDetail, IncidentSummary } from "@livestream/contracts";
import { SimulationExecutor } from "@livestream/platforms";
import {
  dbCount,
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

async function spamIncident(token: string): Promise<{ summary: IncidentSummary; detail: IncidentDetail }> {
  const list = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/incidents?status=open&limit=50", token });
  const incidents = (list.json() as { incidents: IncidentSummary[] }).incidents;
  const summary = incidents.find((i) => i.category === "spam");
  if (!summary) throw new Error("no open spam incident");
  const res = await injectAuthed({ method: "GET", url: `/api/workspaces/demo-alpha/incidents/${summary.id}`, token });
  return { summary, detail: res.json() as IncidentDetail };
}

async function createAction(
  token: string,
  key: string,
  body: Record<string, unknown>,
  expectedStatus = 201
): Promise<ActionIntent> {
  const res = await injectAuthed({
    method: "POST",
    url: "/api/workspaces/demo-alpha/actions",
    payload: body,
    headers: { "Idempotency-Key": key },
    token,
  });
  expect(res.statusCode).toBe(expectedStatus);
  return res.json() as ActionIntent;
}

describe("human-approved simulated actions", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    await setMode("demo-alpha", ctx.alice.token, "assist");
  });

  it("request -> approve -> dispatch yields one persisted logical action", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const intent = await createAction(ctx.bob.token, "key-e2e-flow-0001", {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    });
    expect(intent.state).toBe("awaiting_approval");
    expect(intent.executor).toBe("simulation");

    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(200);
    expect((approved.json() as ActionIntent).state).toBe("queued");

    const done = await runDispatch(intent.id);
    expect(done.executor.callCount).toBe(1);
    expect(done.state).toBe("succeeded");
    expect(await dbCount("action_attempts", "WHERE intent_id = $1", [intent.id])).toBe(1);

    // Refresh recovery: durable status, no re-execution.
    const again = await runDispatch(intent.id);
    expect(again.status).toBe("duplicate");
    expect(done.executor.callCount).toBe(1);
    const status = await injectAuthed({ method: "GET", url: `/api/workspaces/demo-alpha/actions/${intent.id}`, token: ctx.bob.token });
    expect((status.json() as ActionIntent).state).toBe("succeeded");
  });

  it("same key + same params replays the original; changed params conflict", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const body = {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    };
    const first = await createAction(ctx.bob.token, "key-idem-0001", body);
    const replay = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: body,
      headers: { "Idempotency-Key": "key-idem-0001" },
      token: ctx.bob.token,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as ActionIntent).id).toBe(first.id);
    expect(await dbCount("action_intents", "WHERE workspace_id = 'demo-alpha'")).toBe(1);

    const conflict = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: { ...body, targetUserId: "someone-else" },
      headers: { "Idempotency-Key": "key-idem-0001" },
      token: ctx.bob.token,
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { code: string }).code).toBe("idempotency_conflict");
  });

  it("missing message ids are rejected, never treated as clear-chat", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const res = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: {
        incidentId: summary.id,
        action: "delete_message",
        targetUserId: target.authorId,
        expectedIncidentVersion: summary.version,
        expectedPolicyVersion: summary.policyVersion,
      },
      headers: { "Idempotency-Key": "key-missing-target-1" },
      token: ctx.bob.token,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("missing_target");
    expect(await dbCount("action_intents", "WHERE workspace_id = 'demo-alpha'")).toBe(0);
  });

  it("refuses bans in M0 (simulated delete/timeout only)", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const res = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/actions",
      payload: {
        incidentId: summary.id,
        action: "ban_user",
        targetUserId: target.authorId,
        expectedIncidentVersion: summary.version,
        expectedPolicyVersion: summary.policyVersion,
      },
      headers: { "Idempotency-Key": "key-ban-refused-1" },
      token: ctx.bob.token,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("unsupported_capability");
  });

  it("stale approvals are superseded, never dispatched", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const intent = await createAction(ctx.bob.token, "key-stale-0001", {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    });
    // New evidence arrives and bumps the incident version.
    await replayBatch("demo-alpha", ctx.alice.token, [
      {
        deliveryId: "d-spam-late-1",
        platformMessageId: "msg-spam-late-1",
        kind: "message",
        authorId: "viewer-spam-07",
        authorName: "PromoBot7",
        text: "FREE NITRO giveaway!! click here",
        providerTime: "2026-09-22T18:00:55+00:00",
      },
    ]);
    await processOutbox();

    const executor = new SimulationExecutor();
    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(409);
    expect((approved.json() as { code: string }).code).toBe("stale_evidence");
    expect(executor.callCount).toBe(0);
    const status = await injectAuthed({ method: "GET", url: `/api/workspaces/demo-alpha/actions/${intent.id}`, token: ctx.bob.token });
    expect((status.json() as ActionIntent).state).toBe("superseded");
  });

  it("expired approvals are rejected and marked expired", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const intent = await createAction(ctx.bob.token, "key-expire-0001", {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    });
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("UPDATE action_intents SET expires_at = now() - interval '1 second' WHERE id = $1", [intent.id]);
    } finally {
      client.release();
    }
    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(410);
    const status = await injectAuthed({ method: "GET", url: `/api/workspaces/demo-alpha/actions/${intent.id}`, token: ctx.bob.token });
    expect((status.json() as ActionIntent).state).toBe("expired");
  });

  it("policy changes supersede pending approvals", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const intent = await createAction(ctx.bob.token, "key-polchange-1", {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    });
    const saved = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/policy",
      payload: { preset: "strict", nuance: "", blockedDomains: [] },
      token: ctx.alice.token,
    });
    expect(saved.statusCode).toBe(200);
    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(409);
    expect((approved.json() as { code: string }).code).toBe("policy_changed");
  });

  it("unknown simulated outcomes are reconciled, never blindly retried", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    // Find the incident containing the ambiguous probe message.
    const pool = getPool();
    const client = await pool.connect();
    let incidentId = "";
    let version = 0;
    let policyVersion = 1;
    try {
      const { rows } = await client.query<{ incident_id: string; version: number; policy_version: number }>(
        `SELECT ie.incident_id, i.version, i.policy_version FROM incident_events ie
         JOIN chat_events e ON e.id = ie.chat_event_id
         JOIN incidents i ON i.id = ie.incident_id
         WHERE e.workspace_id = 'demo-alpha' AND e.platform_message_id = 'msg-unknown-001'`
      );
      incidentId = rows[0]?.incident_id ?? "";
      version = rows[0]?.version ?? 0;
      policyVersion = rows[0]?.policy_version ?? 1;
    } finally {
      client.release();
    }
    expect(incidentId).not.toBe("");
    const intent = await createAction(ctx.bob.token, "key-unknown-0001", {
      incidentId,
      action: "delete_message",
      targetMessageId: "msg-unknown-001",
      targetUserId: "viewer-unknown-01",
      expectedIncidentVersion: version,
      expectedPolicyVersion: policyVersion,
    });
    const approved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: version, expectedPolicyVersion: policyVersion },
      token: ctx.bob.token,
    });
    expect(approved.statusCode).toBe(200);
    const done = await runDispatch(intent.id);
    expect(done.state).toBe("unknown");
    expect(done.executor.callCount).toBe(1);

    // Redelivery after the unknown outcome does not re-execute.
    const redelivered = await runDispatch(intent.id, done.executor);
    expect(redelivered.status).toBe("duplicate");
    expect(done.executor.callCount).toBe(1);

    // Reconciliation re-reads the ledger (still ambiguous here) without submit.
    const reconciled = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/reconcile`,
      payload: {},
      token: ctx.bob.token,
    });
    expect(reconciled.statusCode).toBe(409);
    expect((reconciled.json() as { code: string }).code).toBe("outcome_unknown");
    expect(done.executor.callCount).toBe(1);
  });

  it("worker restart during submitting recovers without re-execution", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const intent = await createAction(ctx.bob.token, "key-restart-0001", {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    });
    await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    // Simulate a crash between submit and ledger write.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("UPDATE action_intents SET state = 'submitting' WHERE id = $1", [intent.id]);
    } finally {
      client.release();
    }
    const executor = new SimulationExecutor();
    const recovered = await runDispatch(intent.id, executor);
    expect(recovered.status).toBe("recovered");
    expect(recovered.state).toBe("succeeded");
    expect(executor.callCount).toBe(0); // reconcile reads; never submits
    expect(await dbCount("action_attempts", "WHERE intent_id = $1", [intent.id])).toBe(1);
  });

  it("Preview refuses every write path with zero executor calls", async () => {
    await setMode("demo-alpha", ctx.alice.token, "preview");
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const res = await injectAuthed({
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
      headers: { "Idempotency-Key": "key-preview-zero-1" },
      token: ctx.bob.token,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("preview_no_writes");
    expect(await dbCount("action_intents", "WHERE workspace_id = 'demo-alpha'")).toBe(0);

    // A queued intent that survives a mode downgrade is refused at dispatch.
    await setMode("demo-alpha", ctx.alice.token, "assist");
    const intent = await createAction(ctx.bob.token, "key-preview-race-1", {
      incidentId: summary.id,
      action: "delete_message",
      targetMessageId: target.platformMessageId,
      targetUserId: target.authorId,
      expectedIncidentVersion: summary.version,
      expectedPolicyVersion: summary.policyVersion,
    });
    await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/actions/${intent.id}/approve`,
      payload: { expectedIncidentVersion: summary.version, expectedPolicyVersion: summary.policyVersion },
      token: ctx.bob.token,
    });
    await setMode("demo-alpha", ctx.alice.token, "preview");
    const executor = new SimulationExecutor();
    const out = await runDispatch(intent.id, executor);
    expect(out.status).toBe("refused");
    expect(executor.callCount).toBe(0);
  });

  it("pause blocks new admission and in-flight dispatch honestly", async () => {
    const { summary, detail } = await spamIncident(ctx.bob.token);
    const target = detail.evidence[0];
    if (!target) throw new Error("no evidence");
    const paused = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/automation/pause",
      payload: { paused: true },
      token: ctx.bob.token,
    });
    expect(paused.statusCode).toBe(200);
    const blocked = await injectAuthed({
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
      headers: { "Idempotency-Key": "key-paused-block-1" },
      token: ctx.bob.token,
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { code: string }).code).toBe("paused");
    // Only the owner may resume.
    const modResume = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/automation/pause",
      payload: { paused: false },
      token: ctx.bob.token,
    });
    expect(modResume.statusCode).toBe(403);
    const ownerResume = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/automation/pause",
      payload: { paused: false },
      token: ctx.alice.token,
    });
    expect(ownerResume.statusCode).toBe(200);
  });
});
