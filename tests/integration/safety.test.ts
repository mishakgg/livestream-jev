import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@livestream/db";
import {
  injectAuthed,
  loadFixture,
  login,
  loginAll,
  processOutbox,
  replayBatch,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

describe("safety boundaries", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
  });

  it("unknown demo users are rejected; sessions are workspace-bound", async () => {
    const { testApp } = await import("./helpers.js");
    const app = await testApp();
    const bad = await app.inject({ method: "POST", url: "/api/demo/login", payload: { username: "mallory" } });
    expect(bad.statusCode).toBe(401);

    // Bob's token works for alpha but not beta.
    const ok = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha", token: ctx.bob.token });
    expect(ok.statusCode).toBe(200);
    const denied = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-beta", token: ctx.bob.token });
    expect(denied.statusCode).toBe(403);
  });

  it("removed moderators lose access immediately (open work included)", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM memberships WHERE workspace_id = 'demo-alpha' AND user_id = 'user-bob'");
    } finally {
      client.release();
    }
    const res = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/incidents?status=open", token: ctx.bob.token });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("HTML payloads are stored verbatim and served as data (never executed server-side)", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ original_text: string; author_name: string }>(
        "SELECT original_text, author_name FROM chat_events WHERE workspace_id = 'demo-alpha' AND platform_message_id = 'msg-adv-003'"
      );
      // Stored verbatim: escaping is a rendering concern, asserted in e2e.
      expect(rows[0]?.original_text).toContain("<script>alert('xss')</script>");
      expect(rows[0]?.author_name).toContain("<img");
    } finally {
      client.release();
    }
  });

  it("audit rows never contain raw chat bodies", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const list = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/incidents?status=open&limit=1", token: ctx.alice.token });
    const incidents = (list.json() as { incidents: { id: string; version: number }[] }).incidents;
    const first = incidents[0];
    if (!first) throw new Error("expected an incident");
    await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${first.id}/claim`,
      payload: { expectedVersion: first.version },
      token: ctx.alice.token,
    });
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ rationale: string | null; new_state: string | null }>(
        "SELECT rationale, new_state FROM audit_events WHERE workspace_id = 'demo-alpha'"
      );
      for (const r of rows) {
        expect(r.rationale ?? "").not.toMatch(/NITRO|idiot|audio/i);
        expect(r.new_state ?? "").not.toMatch(/NITRO|idiot|audio/i);
      }
    } finally {
      client.release();
    }
  });

  it("update cursors resume safely; expired cursors reset to a snapshot", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const fresh = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/updates?cursor=0", token: ctx.alice.token });
    expect(fresh.statusCode).toBe(200);
    const body = fresh.json() as { head: number; reset: boolean; updates: unknown[] };
    expect(body.head).toBeGreaterThan(0);
    expect(body.updates.length).toBeGreaterThan(0);

    // A cursor from another tenant's range is just a number: scoped rows only.
    const beta = await login("dave");
    const betaUpdates = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-beta/updates?cursor=0", token: beta.token });
    expect(betaUpdates.statusCode).toBe(200);
    expect((betaUpdates.json() as { updates: unknown[] }).updates).toHaveLength(0);

    // Absurd cursor resets instead of replaying unbounded history.
    const reset = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/updates?cursor=999999999", token: ctx.alice.token });
    expect((reset.json() as { reset: boolean }).reset).toBe(true);
    expect((reset.json() as { updates: unknown[] }).updates).toHaveLength(0);
  });

  it("health reports honest coverage states from persisted data", async () => {
    const empty = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/health", token: ctx.alice.token });
    const emptyBody = empty.json() as { coverage: string; writesDisabled: boolean };
    expect(emptyBody.coverage).toMatch(/Waiting for replay/);
    expect(emptyBody.writesDisabled).toBe(true);

    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const full = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/health", token: ctx.alice.token });
    const fullBody = full.json() as { receivedEvents: number; deduplicatedDeliveries: number; evaluatedEvents: number; coverage: string };
    expect(fullBody.receivedEvents).toBe(22);
    expect(fullBody.deduplicatedDeliveries).toBe(1);
    expect(fullBody.evaluatedEvents).toBe(22);
    expect(fullBody.coverage).toMatch(/Up to date/);
  });
});
