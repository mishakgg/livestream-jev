import { describe, expect, it } from "vitest";
import {
  CreateActionRequestSchema,
  ReplayBatchSchema,
  ResolveRequestSchema,
} from "./index.js";

describe("contracts", () => {
  it("rejects replay batches with bad provider times", () => {
    expect(
      ReplayBatchSchema.safeParse({ events: [] }).success
    ).toBe(false);
    expect(
      ReplayBatchSchema.safeParse({
        events: [{ deliveryId: "d", platformMessageId: "m", authorId: "a", authorName: "n", text: "t", providerTime: "not-a-time" }],
      }).success
    ).toBe(false);
  });
  it("accepts a minimal valid replay event", () => {
    const r = ReplayBatchSchema.safeParse({
      events: [{ deliveryId: "d", platformMessageId: "m", authorId: "a", authorName: "n", text: "t", providerTime: "2026-09-22T18:00:05+00:00" }],
    });
    expect(r.success).toBe(true);
  });
  it("bounds action durations and resolve reasons", () => {
    expect(
      CreateActionRequestSchema.safeParse({
        incidentId: "00000000-0000-0000-0000-000000000000",
        action: "timeout_user",
        targetUserId: "u",
        durationSeconds: 99999999,
        expectedIncidentVersion: 1,
        expectedPolicyVersion: 1,
      }).success
    ).toBe(false);
    expect(
      ResolveRequestSchema.safeParse({ expectedVersion: 1, disposition: "resolved", reason: "x".repeat(501) }).success
    ).toBe(false);
  });
});
