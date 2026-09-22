import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@livestream/db";
import type { IncidentSummary } from "@livestream/contracts";
import {
  injectAuthed,
  loadFixture,
  loginAll,
  processOutbox,
  replayBatch,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

async function listOpen(token: string, ws = "demo-alpha"): Promise<IncidentSummary[]> {
  const res = await injectAuthed({ method: "GET", url: `/api/workspaces/${ws}/incidents?status=open&limit=50`, token });
  expect(res.statusCode).toBe(200);
  return (res.json() as { incidents: IncidentSummary[] }).incidents;
}

describe("replay pipeline (intake -> grouping -> policy)", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
  });

  it("groups coordinated spam variants into one incident with persisted counts", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    const out = await processOutbox();
    expect(out.processed).toBe(22);

    const incidents = await listOpen(ctx.alice.token);
    const spam = incidents.filter((i) => i.category === "spam");
    // Case/punctuation/whitespace variants normalize identically and group.
    expect(spam).toHaveLength(1);
    expect(spam[0]?.messageCount).toBe(6);
    expect(spam[0]?.accountCount).toBe(6);
    const pool = getPool();
    const client = await pool.connect();
    try {
      for (const s of spam) {
        const { rows } = await client.query<{ messages: string; accounts: string }>(
          `SELECT COUNT(*)::text AS messages, COUNT(DISTINCT e.author_id)::text AS accounts
           FROM incident_events ie JOIN chat_events e ON e.id = ie.chat_event_id
           WHERE ie.incident_id = $1`,
          [s.id]
        );
        expect(s.messageCount).toBe(Number(rows[0]?.messages ?? "-1"));
        expect(s.accountCount).toBe(Number(rows[0]?.accounts ?? "-1"));
      }
    } finally {
      client.release();
    }
  });

  it("groups repeated targeted hostility by target with reply linkage", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const incidents = await listOpen(ctx.alice.token);
    const hostile = incidents.filter((i) => i.category === "targeted_harassment");
    expect(hostile).toHaveLength(1);
    expect(hostile[0]?.messageCount).toBe(3);
    expect(hostile[0]?.accountCount).toBe(2);
    expect(hostile[0]?.targetUserId).toBe("viewer-new-01");
    expect(hostile[0]?.severity).toBe("high");
  });

  it("keeps banter and ordinary chat out of the inbox", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const pool = getPool();
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ category: string }>(
        `SELECT category FROM chat_events
         WHERE workspace_id = 'demo-alpha' AND platform_message_id IN ('msg-banter-001','msg-banter-002','msg-banter-003','msg-chat-002','msg-chat-003')`
      );
      expect(rows).toHaveLength(5);
      for (const r of rows) expect(r.category).toBe("ordinary");
    } finally {
      client.release();
    }
  });

  it("builds the stream-issue aggregate from distinct persisted accounts", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const res = await injectAuthed({ method: "GET", url: "/api/workspaces/demo-alpha/stream-issues", token: ctx.alice.token });
    expect(res.statusCode).toBe(200);
    const card = res.json() as { distinctAccounts: number; messageCount: number; headline: string; incidentId: string | null };
    expect(card.distinctAccounts).toBe(6);
    expect(card.messageCount).toBe(6);
    expect(card.headline).toMatch(/6 distinct account/);
    expect(card.incidentId).not.toBeNull();
    // Stream reports stay out of the moderation inbox.
    const incidents = await listOpen(ctx.alice.token);
    expect(incidents.some((i) => i.category === "stream_issue_report")).toBe(false);
  });

  it("is order-independent: shuffled processing still groups correctly", async () => {
    const events = loadFixture("replay-basic.json");
    await replayBatch("demo-alpha", ctx.alice.token, [...events].reverse());
    await processOutbox();
    const incidents = await listOpen(ctx.alice.token);
    const hostile = incidents.filter((i) => i.category === "targeted_harassment");
    expect(hostile).toHaveLength(1);
    expect(hostile[0]?.messageCount).toBe(3);
  });

  it("reprocessing is idempotent (worker restart / redelivery safe)", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    const first = await processOutbox();
    expect(first.processed).toBe(22);
    // Simulate redelivery of every outbox row.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("UPDATE outbox SET delivered = FALSE WHERE workspace_id = 'demo-alpha'");
    } finally {
      client.release();
    }
    const second = await processOutbox();
    expect(second.processed).toBe(0);
    expect(second.duplicates).toBe(22);
    const incidents = await listOpen(ctx.alice.token);
    const hostile = incidents.filter((i) => i.category === "targeted_harassment");
    expect(hostile).toHaveLength(1);
    expect(hostile[0]?.messageCount).toBe(3);
  });

  it("flags injection attempts in evaluations without creating false incidents", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    const pool = getPool();
    const client = await pool.connect();
    try {
      const flagged = await client.query<{ platform_message_id: string; category: string }>(
        `SELECT platform_message_id, category FROM chat_events
         WHERE workspace_id = 'demo-alpha' AND (evaluation->>'injectionAttempt')::boolean = TRUE`
      );
      const ids = flagged.rows.map((r) => r.platform_message_id).sort();
      expect(ids).toContain("msg-adv-001");
      expect(ids).toContain("msg-adv-002");
      // Injection text is ordinary content, never an instruction: no incident,
      // no target, no policy change.
      for (const r of flagged.rows) {
        if (r.platform_message_id === "msg-adv-001" || r.platform_message_id === "msg-adv-002") {
          expect(r.category).toBe("ordinary");
        }
      }
      const policy = await client.query<{ policy_version: number }>(
        "SELECT policy_version FROM workspaces WHERE id = 'demo-alpha'"
      );
      expect(policy.rows[0]?.policy_version).toBe(1);
    } finally {
      client.release();
    }
  });

  it("classifies the unknown-outcome probe as spam for dispatch tests", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-adversarial.json"));
    await processOutbox();
    const incidents = await listOpen(ctx.alice.token);
    const probe = incidents.find((i) => i.category === "spam");
    expect(probe).toBeDefined();
  });
});
