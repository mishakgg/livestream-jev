import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@livestream/db";
import type { IncidentDetail, IncidentSummary } from "@livestream/contracts";
import {
  injectAuthed,
  loadFixture,
  loginAll,
  processOutbox,
  replayBatch,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

async function openIncident(token: string, category: string): Promise<IncidentSummary> {
  const res = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/incidents?status=open&limit=50", token });
  expect(res.statusCode).toBe(200);
  const incidents = (res.json() as { incidents: IncidentSummary[] }).incidents;
  const found = incidents.find((i) => i.category === category);
  if (!found) throw new Error(`no open ${category} incident`);
  return found;
}

async function detail(id: string, token: string, reveal = false): Promise<IncidentDetail> {
  const res = await injectAuthed({
    method: "GET",
    url: `/api/workspaces/demo-alpha/incidents/${id}${reveal ? "?reveal=1" : ""}`,
    token,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as IncidentDetail;
}

describe("incident collaboration", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
  });

  it("shows evidence detail with original text and bounded context", async () => {
    const spam = await openIncident(ctx.bob.token, "spam");
    const d = await detail(spam.id, ctx.bob.token);
    expect(d.evidence).toHaveLength(6);
    expect(d.evidence[0]?.text).toMatch(/FREE NITRO/i);
    expect(d.evidence[0]?.origin).toBe("replay");
    expect(d.context.length).toBeLessThanOrEqual(30);
    expect(d.channelRule.length).toBeGreaterThan(0);
    expect(d.uncertainty.length).toBeGreaterThan(0);
    expect(d.eligibleActions).toContain("delete_message");
  });

  it("claim/dismiss/resolve workflow with optimistic versions", async () => {
    const spam = await openIncident(ctx.bob.token, "spam");
    const claimed = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}/claim`,
      payload: { expectedVersion: spam.version },
      token: ctx.bob.token,
    });
    expect(claimed.statusCode).toBe(200);
    expect((claimed.json() as IncidentSummary).state).toBe("claimed");

    // Stale version is rejected with current state (no silent overwrite).
    const stale = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}/resolve`,
      payload: { expectedVersion: spam.version, disposition: "resolved", reason: "stale" },
      token: ctx.bob.token,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { code: string }).code).toBe("conflict");

    const current = (claimed.json() as IncidentSummary).version;
    const resolved = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}/resolve`,
      payload: { expectedVersion: current, disposition: "resolved", reason: "Reviewed together with mod team" },
      token: ctx.bob.token,
    });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as IncidentSummary).state).toBe("resolved");
  });

  it("two moderators racing converge on one claim (no double work)", async () => {
    const spam = await openIncident(ctx.bob.token, "spam");
    const [r1, r2] = await Promise.all([
      injectAuthed({
        method: "POST",
        url: `/api/workspaces/demo-alpha/incidents/${spam.id}/claim`,
        payload: { expectedVersion: spam.version },
        token: ctx.bob.token,
      }),
      injectAuthed({
        method: "POST",
        url: `/api/workspaces/demo-alpha/incidents/${spam.id}/claim`,
        payload: { expectedVersion: spam.version },
        token: ctx.cara.token,
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect((loser.json() as { message: string }).message).toMatch(/another moderator|changed/);

    // Exactly one claim holder persisted.
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ state: string; claimed_by_user_id: string; version: number }>(
        "SELECT state, claimed_by_user_id, version FROM incidents WHERE id = $1",
        [spam.id]
      );
      expect(rows[0]?.state).toBe("claimed");
      expect(rows[0]?.version).toBe(spam.version + 1);
      expect(["user-bob", "user-cara"]).toContain(rows[0]?.claimed_by_user_id);
    } finally {
      client.release();
    }
  });

  it("cross-tenant access is denied without leaking (404, no data)", async () => {
    const spam = await openIncident(ctx.alice.token, "spam");
    // Dave (beta owner) guesses an alpha incident id.
    const res = await injectAuthed({
      method: "GET",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}`,
      token: ctx.dave.token,
    });
    expect(res.statusCode).toBe(403);
    // Beta workspace list shows nothing from alpha.
    const beta = await injectAuthed({
      method: "GET",
      url: "/api/workspaces/demo-beta/incidents?status=all&limit=50",
      token: ctx.dave.token,
    });
    expect(beta.statusCode).toBe(200);
    expect((beta.json() as { incidents: unknown[] }).incidents).toHaveLength(0);
  });

  it("release returns the incident to open for the next moderator", async () => {
    const spam = await openIncident(ctx.bob.token, "spam");
    await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}/claim`,
      payload: { expectedVersion: spam.version },
      token: ctx.bob.token,
    });
    const released = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}/release`,
      payload: {},
      token: ctx.bob.token,
    });
    expect(released.statusCode).toBe(200);
    expect((released.json() as IncidentSummary).state).toBe("open");
    // Another moderator can now claim it.
    const d = await detail(spam.id, ctx.cara.token);
    const claimed = await injectAuthed({
      method: "POST",
      url: `/api/workspaces/demo-alpha/incidents/${spam.id}/claim`,
      payload: { expectedVersion: d.version },
      token: ctx.cara.token,
    });
    expect(claimed.statusCode).toBe(200);
  });

  it("masks private-information evidence until deliberately revealed (audited)", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    const leak = await openIncident(ctx.alice.token, "private_information_suspected");
    const masked = await detail(leak.id, ctx.alice.token);
    expect(masked.evidence[0]?.masked).toBe(true);
    expect(masked.evidence[0]?.text).not.toMatch(/Fiction Street/);

    const revealed = await detail(leak.id, ctx.alice.token, true);
    expect(revealed.evidence[0]?.masked).toBe(false);
    expect(revealed.evidence[0]?.text).toMatch(/Fiction Street/);

    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM audit_events WHERE workspace_id = 'demo-alpha' AND operation = 'evidence.reveal'"
      );
      expect(Number(rows[0]?.n ?? "0")).toBe(1);
    } finally {
      client.release();
    }
  });
});
