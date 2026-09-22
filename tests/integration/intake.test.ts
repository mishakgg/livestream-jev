import { beforeEach, describe, expect, it } from "vitest";
import {
  dbCount,
  injectAuthed,
  loadFixture,
  loginAll,
  replayBatch,
  truncateAndSeed,
  type Ctx,
} from "./helpers.js";

describe("durable intake", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    await truncateAndSeed();
    ctx = await loginAll();
  });

  it("persists events + outbox atomically and reports duplicates", async () => {
    const events = loadFixture("replay-basic.json");
    const first = await replayBatch("demo-alpha", ctx.alice.token, events);
    // 23 deliveries: 1 duplicate delivery (d-spam-001 twice) + 22 unique.
    expect(first.accepted).toBe(22);
    expect(first.duplicates).toBe(1);
    expect(await dbCount("chat_events", "WHERE workspace_id = $1", ["demo-alpha"])).toBe(22);
    expect(await dbCount("outbox", "WHERE workspace_id = $1 AND aggregate_type = 'chat_event'", ["demo-alpha"])).toBe(22);

    // Full redelivery: everything deduplicates, no new work.
    const second = await replayBatch("demo-alpha", ctx.alice.token, events);
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(events.length);
    expect(await dbCount("chat_events", "WHERE workspace_id = $1", ["demo-alpha"])).toBe(22);
  });

  it("dedups the same message under a fresh delivery id", async () => {
    const [event] = loadFixture("replay-basic.json");
    if (!event) throw new Error("fixture empty");
    await replayBatch("demo-alpha", ctx.alice.token, [event]);
    const retry = { ...event, deliveryId: "d-fresh-delivery-same-message" };
    const res = await replayBatch("demo-alpha", ctx.alice.token, [retry]);
    expect(res.accepted).toBe(0);
    expect(res.duplicates).toBe(1);
    expect(await dbCount("chat_events", "WHERE workspace_id = $1", ["demo-alpha"])).toBe(1);
  });

  it("accepts out-of-order arrivals without reordering intake", async () => {
    const events = loadFixture("replay-basic.json");
    // Reverse delivery order: intake still accepts every unique event.
    const reversed = [...events].reverse();
    const res = await replayBatch("demo-alpha", ctx.alice.token, reversed);
    expect(res.accepted).toBe(22);
  });

  it("rejects invalid batches without partial writes", async () => {
    const res = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-alpha/replay",
      payload: { events: [{ deliveryId: "x" }] },
      token: ctx.alice.token,
    });
    expect(res.statusCode).toBe(400);
    expect(await dbCount("chat_events", "WHERE workspace_id = $1", ["demo-alpha"])).toBe(0);
    expect(await dbCount("outbox", "WHERE workspace_id = $1", ["demo-alpha"])).toBe(0);
  });

  it("isolates tenants: a moderator cannot replay into another workspace", async () => {
    const events = loadFixture("replay-basic.json").slice(0, 2);
    const res = await injectAuthed({
      method: "POST",
      url: "/api/workspaces/demo-beta/replay",
      payload: { events },
      token: ctx.bob.token, // alpha moderator
    });
    expect(res.statusCode).toBe(403);
    expect(await dbCount("chat_events", "WHERE workspace_id = $1", ["demo-beta"])).toBe(0);
  });

  it("requires authentication", async () => {
    const { testApp } = await import("./helpers.js");
    const app = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/demo-alpha/replay",
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});
