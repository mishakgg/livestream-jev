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
// and touches no platform. Outcomes are deterministic:
//   - target message/user id containing "unknown"  -> outcome "unknown"
//     (simulates an ambiguous post-submission failure for reconciliation tests)
//   - otherwise                                   -> outcome "succeeded"
// Every invocation is recorded in the in-memory call log (tests assert Preview
// never reaches it) and callers persist attempts to the simulation ledger.
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
  /** Ledger evidence: what the (fake) platform state shows afterwards. */
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

  async execute(call: Omit<SimulationCall, "at">): Promise<SimulationResult> {
    const entry: SimulationCall = { ...call, at: new Date().toISOString() };
    this.calls.push(entry);
    const marker = `${call.targetMessageId ?? ""} ${call.targetUserId}`;
    if (marker.includes("unknown")) {
      // Ambiguous: the request may or may not have applied. Callers must
      // reconcile via the ledger, never blindly retry.
      return {
        outcome: "unknown",
        applied: null,
        detail:
          "SIMULATED ambiguous result: the request may or may not have applied. Reconcile before any retry. Not a live action.",
      };
    }
    return {
      outcome: "succeeded",
      applied: true,
      detail: "SIMULATED success recorded in the simulation ledger only. Not a live platform action.",
    };
  }

  /** Ledger reconciliation for unknown outcomes: deterministic re-read. */
  async reconcile(call: { targetMessageId: string | null; targetUserId: string }): Promise<{
    applied: boolean | null;
    detail: string;
  }> {
    const marker = `${call.targetMessageId ?? ""} ${call.targetUserId}`;
    if (marker.includes("unknown")) {
      // Some unknowns stay unknown (still ambiguous); others resolve. The
      // suffix decides deterministically so tests cover both branches.
      if (marker.includes("unknown-resolve")) {
        return { applied: true, detail: "SIMULATED reconcile: ledger shows the effect applied." };
      }
      if (marker.includes("unknown-absent")) {
        return { applied: false, detail: "SIMULATED reconcile: ledger shows the effect did not apply." };
      }
      return { applied: null, detail: "SIMULATED reconcile: outcome still ambiguous." };
    }
    return { applied: true, detail: "SIMULATED reconcile: ledger shows the effect applied." };
  }
}
