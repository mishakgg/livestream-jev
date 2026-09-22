import { describe, expect, it } from "vitest";
import {
  NullWriteAdapter,
  ReplayAdapter,
  SimulationExecutor,
  UnsupportedCapabilityError,
} from "./index.js";

describe("ReplayAdapter", () => {
  const events = [
    { deliveryId: "d2", platformMessageId: "m2", kind: "message" as const, authorId: "a", authorName: "A", text: "second", providerTime: "2026-09-22T18:00:11+00:00" },
    { deliveryId: "d1", platformMessageId: "m1", kind: "message" as const, authorId: "a", authorName: "A", text: "first", providerTime: "2026-09-22T18:00:05+00:00" },
  ];
  it("replays deterministically by providerTime", () => {
    const ordered = new ReplayAdapter().eventsFromFixture(events);
    expect(ordered.map((e) => e.deliveryId)).toEqual(["d1", "d2"]);
  });
  it("preserves delivery order for duplicate/out-of-order tests", () => {
    const ordered = new ReplayAdapter().eventsFromFixture(events, { preserveDeliveryOrder: true });
    expect(ordered.map((e) => e.deliveryId)).toEqual(["d2", "d1"]);
  });
  it("advertises no write capabilities", () => {
    const caps = new ReplayAdapter().capabilities;
    expect(caps.deleteMessage).toBe(false);
    expect(caps.timeoutUser).toBe(false);
    expect(caps.banUser).toBe(false);
  });
});

describe("NullWriteAdapter", () => {
  it("throws instead of simulating success", async () => {
    const adapter = new NullWriteAdapter();
    await expect(adapter.deleteMessage()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(adapter.timeoutUser()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(adapter.banUser()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });
});

describe("SimulationExecutor", () => {
  const call = { operationKey: "k", action: "delete_message", targetMessageId: "msg-1", targetUserId: "u", durationSeconds: null };
  it("succeeds deterministically for ordinary targets", async () => {
    const ex = new SimulationExecutor();
    const res = await ex.execute(call);
    expect(res.outcome).toBe("succeeded");
    expect(res.applied).toBe(true);
    expect(res.detail).toMatch(/SIMULATED/);
    expect(ex.callCount).toBe(1);
  });
  it("returns unknown for ambiguous markers", async () => {
    const ex = new SimulationExecutor();
    const res = await ex.execute({ ...call, targetMessageId: "msg-unknown-001" });
    expect(res.outcome).toBe("unknown");
    expect(res.applied).toBeNull();
  });
  it("is a pure scenario oracle: reconcile-from-evidence lives in the pipeline, not here", async () => {
    const ex = new SimulationExecutor();
    // No reconcile method: recovery/reconciliation read the durable
    // simulated_effects ledger via findSimulatedEffect, never the oracle.
    expect("reconcile" in ex).toBe(false);
    const res = await ex.execute({ ...call, targetMessageId: "msg-unknown-001" });
    expect(res.outcome).toBe("unknown");
    expect(res.applied).toBeNull();
    expect(ex.callCount).toBe(1);
  });
});
