import type { ReplayEvent } from "@livestream/contracts";

// ---------------------------------------------------------------------------
// Platform adapters for M0. There is deliberately NO live platform adapter in
// this milestone: no Twitch reads, no Twitch writes, no credentials.
// ---------------------------------------------------------------------------

export interface CapabilityMatrix {
  receiveMessages: boolean;
  observeDeletions: boolean;
  observeModeration: boolean;
  deleteMessage: boolean;
  timeoutUser: boolean;
  banUser: boolean;
  reverseSanction: boolean;
  nativeHoldHandling: boolean;
}

// ---------------------------------------------------------------------------
// ReplayAdapter: deterministic synthetic intake. Fixtures are plain validated
// ReplayEvent objects; the adapter sorts by providerTime for stable replay but
// preserves duplicate deliveries and out-of-order arrivals as delivered when
// asked, so tests can exercise exactly those paths.
// ---------------------------------------------------------------------------

export interface ReplayAdapterOptions {
  /** When true (tests), emit events in fixture order including duplicates. */
  preserveDeliveryOrder?: boolean;
}

export class ReplayAdapter {
  readonly name = "replay" as const;
  readonly capabilities: CapabilityMatrix = {
    receiveMessages: true,
    observeDeletions: false,
    observeModeration: false,
    deleteMessage: false,
    timeoutUser: false,
    banUser: false,
    reverseSanction: false,
    nativeHoldHandling: false,
  };

  eventsFromFixture(fixture: ReplayEvent[], opts: ReplayAdapterOptions = {}): ReplayEvent[] {
    if (opts.preserveDeliveryOrder) return [...fixture];
    // Stable deterministic order: providerTime, then deliveryId.
    return [...fixture].sort((a, b) =>
      a.providerTime < b.providerTime ? -1 : a.providerTime > b.providerTime ? 1 : a.deliveryId < b.deliveryId ? -1 : 1
    );
  }
}

// ---------------------------------------------------------------------------
// NullWriteAdapter: every write capability is unsupported. Preview and any
// live-write path resolve to this adapter in M0, so a write attempt throws
// instead of simulating success.
// ---------------------------------------------------------------------------

export class UnsupportedCapabilityError extends Error {
  readonly code = "unsupported_capability" as const;
  constructor(public capability: string) {
    super(`Capability not supported in M0: ${capability}`);
    this.name = "UnsupportedCapabilityError";
  }
}

export class NullWriteAdapter {
  readonly name = "null-write" as const;
  readonly capabilities: CapabilityMatrix = {
    receiveMessages: false,
    observeDeletions: false,
    observeModeration: false,
    deleteMessage: false,
    timeoutUser: false,
    banUser: false,
    reverseSanction: false,
    nativeHoldHandling: false,
  };

  async deleteMessage(): Promise<never> {
    throw new UnsupportedCapabilityError("delete_message");
  }
  async timeoutUser(): Promise<never> {
    throw new UnsupportedCapabilityError("timeout_user");
  }
  async banUser(): Promise<never> {
    throw new UnsupportedCapabilityError("ban_user");
  }
}

// ---------------------------------------------------------------------------
// SimulationExecutor: the ONLY executor in M0. It performs no network calls
// and touches no platform. It is a pure scenario oracle; scenario selection
// is deterministic:
//   - target message/user id containing "unknown"  -> "unknown" scenario
//     (simulates an ambiguous post-submission failure; persists no effect)
//   - otherwise                                   -> success scenario
// Every invocation is recorded in the in-memory call log (tests assert Preview
// never reaches it). The pipeline persists the simulated platform-side effect
// to simulated_effects in its own transaction, and recovery trusts only that
// persisted evidence — never the oracle's claim and never the marker.
// ---------------------------------------------------------------------------

export type SimulatedOutcome = "succeeded" | "unknown";

export interface SimulationCall {
  operationKey: string;
  action: string;
  targetMessageId: string | null;
  targetUserId: string;
  durationSeconds: number | null;
  at: string;
}

export interface SimulationResult {
  outcome: SimulatedOutcome;
  /**
   * Claimed by the scenario oracle only. A `true` value here is NOT proof of
   * application: the pipeline must persist a simulated_effects row first, and
   * recovery/reconciliation trust only that row. See findSimulatedEffect.
   */
  applied: boolean | null;
  detail: string;
}

export class SimulationExecutor {
  readonly name = "simulation" as const;
  private calls: SimulationCall[] = [];

  getCalls(): readonly SimulationCall[] {
    return this.calls;
  }

  get callCount(): number {
    return this.calls.length;
  }

  reset(): void {
    this.calls = [];
  }

  /**
   * Pure scenario oracle: selects the synthetic outcome for this invocation
   * and records the call (Preview zero-write tests assert on this log). The
   * target marker selects a failure scenario; it never proves that an action
   * happened. Persisting the simulated platform-side effect is the
   * pipeline's job, in its own transaction, so crash windows stay honest.
   */
  async execute(call: Omit<SimulationCall, "at">): Promise<SimulationResult> {
    const entry: SimulationCall = { ...call, at: new Date().toISOString() };
    this.calls.push(entry);
    const marker = `${call.targetMessageId ?? ""} ${call.targetUserId}`;
    if (marker.includes("unknown")) {
      // Ambiguous scenario: the simulated platform call reports an ambiguous
      // result and persists no effect. Recovery must preserve unknown.
      return {
        outcome: "unknown",
        applied: null,
        detail:
          "SIMULATED ambiguous result: no simulated effect was recorded. Reconcile from evidence before any retry. Not a live action.",
      };
    }
    return {
      outcome: "succeeded",
      applied: true,
      detail: "SIMULATED success scenario: the effect row is persisted separately as evidence. Not a live platform action.",
    };
  }
}
