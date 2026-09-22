import { beforeEach, describe, expect, it } from "vitest";
import { getPool } from "@livestream/db";
import {
  injectAuthed,
  loadFixture,
  loginAll,
  processOutbox,
  replayBatch,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Truthful coverage: outbox handoff is not processing completion. Health must
// distinguish accepted, awaiting, classified, skipped, and failed events from
// persisted processing state, and keep transport-handoff metrics separate.
// ---------------------------------------------------------------------------

interface HealthView {
  receivedEvents: number;
  deduplicatedDeliveries: number;
  evaluatedEvents: number;
  classifiedEvents?: number;
  skippedEvents: number;
  awaitingProcessing?: number;
  failedEvents?: number;
  outboxPending?: number;
  queueDepth: number;
  coverage: string;
}

async function health(token: string, ws = "demo-alpha"): Promise<HealthView> {
  const res = await injectAuthed({ method: "GET", url: `/api/workspaces/${ws}/health`, token });
  expect(res.statusCode).toBe(200);
  return res.json() as HealthView;
}

describe("truthful coverage and backlog", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
  });

  it("jobs handed to the queue but not processed are awaiting — never 'up to date'", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    // Simulate a worker outage after handoff: every outbox row is marked
    // delivered (handed to pg-boss) but no event was ever processed.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("UPDATE outbox SET delivered = TRUE WHERE workspace_id = 'demo-alpha'");
    } finally {
      client.release();
    }
    const h = await health(ctx.alice.token);
    expect(h.receivedEvents).toBe(22);
    expect(h.evaluatedEvents).toBe(0);
    expect(h.coverage).not.toMatch(/Up to date/);
    expect(h.coverage).toMatch(/awaiting classification/);
    expect(h.awaitingProcessing).toBe(22);
    expect(h.failedEvents).toBe(0);
  });

  it("failed processing is reported explicitly, not hidden or counted as evaluated", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    await processOutbox();
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE chat_events SET processing_state = 'failed', processing_attempts = 3,
                last_error = 'simulated worker fault', processed_time = NULL
         WHERE workspace_id = 'demo-alpha' AND platform_message_id = 'msg-chat-003'`
      );
    } finally {
      client.release();
    }
    const h = await health(ctx.alice.token);
    expect(h.failedEvents).toBe(1);
    expect(h.coverage).toMatch(/failed/);
    expect(h.coverage).not.toMatch(/Up to date/);
    expect(h.evaluatedEvents).toBe(21);
  });

  it("skipped non-message observations are reported as skipped, not AI-evaluated", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, [
      {
        deliveryId: "d-obs-1",
        platformMessageId: "msg-obs-1",
        kind: "message_deleted",
        authorId: "viewer-fan-01",
        authorName: "RegularRita",
        text: "observation placeholder",
        providerTime: "2026-09-22T18:00:05+00:00",
      },
    ]);
    await processOutbox();
    const h = await health(ctx.alice.token);
    expect(h.receivedEvents).toBe(1);
    expect(h.skippedEvents).toBe(1);
    expect(h.classifiedEvents).toBe(0);
    expect(h.awaitingProcessing).toBe(0);
    expect(h.coverage).toMatch(/Up to date/);
  });

  it("successful catch-up drains the awaiting backlog to zero", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    const before = await health(ctx.alice.token);
    expect(before.awaitingProcessing).toBe(22);
    await processOutbox();
    const after = await health(ctx.alice.token);
    expect(after.awaitingProcessing).toBe(0);
    expect(after.failedEvents).toBe(0);
    expect(after.classifiedEvents).toBe(after.evaluatedEvents - after.skippedEvents);
    expect(after.coverage).toMatch(/Up to date/);
  });

  it("transport handoff and processing backlog are reported separately", async () => {
    await replayBatch("demo-alpha", ctx.alice.token, loadFixture("replay-basic.json"));
    // Partial catch-up: process half the outbox rows, leave the rest.
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE outbox SET delivered = TRUE
         WHERE id IN (SELECT id FROM outbox WHERE workspace_id = 'demo-alpha' AND delivered = FALSE LIMIT 11)`
      );
    } finally {
      client.release();
    }
    const h = await health(ctx.alice.token);
    expect(h.outboxPending).toBe(11);
    expect(h.awaitingProcessing).toBe(22);
    expect(h.coverage).not.toMatch(/Up to date/);
  });
});
