import { createHash } from "node:crypto";
import type {
  ModerationAction,
  PolicyPreset,
  PolicyPreview,
  Severity,
  SignalCategory,
  WorkspaceMode,
} from "@livestream/contracts";

// ---------------------------------------------------------------------------
// Deterministic text normalization. The original text is always retained
// separately; normalized text is used only for matching/counting.
// ---------------------------------------------------------------------------

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function normalizedHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

/** Extract candidate domains without fetching anything. */
export function extractDomains(text: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;
  for (const m of text.matchAll(re)) {
    out.add(m[0].toLowerCase().replace(/^www\./, ""));
    if (out.size >= 10) break;
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Injection screening. Chat, usernames, titles, history, and model outputs are
// untrusted: none can authorize a tool, change policy, or become an
// instruction. This screen flags text that *claims* authority so the pipeline
// can route it to ordinary review and prove it was not obeyed.
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+/i,
  /\[system\]/i,
  /system\s*:\s*(ban|delete|timeout|approve|allow)/i,
  /as\s+(an?\s+)?ai\s*,?\s*(ban|delete|timeout)/i,
  /execute\s+(this\s+)?(ban|timeout|delete|action)/i,
  /\bban\s+@?\w+\b.*\b(i\s+am|this\s+is)\s+(the\s+)?(owner|admin|moderator|system)\b/i,
  /new\s+policy\s*:/i,
  /update\s+(the\s+)?policy\s+to\s+allow/i,
  /jailbreak/i,
];

export function containsInjectionAttempt(text: string, authorName: string): boolean {
  const hay = `${authorName}\n${text}`;
  return INJECTION_PATTERNS.some((re) => re.test(hay));
}

// ---------------------------------------------------------------------------
// Grouping. Deterministic, explainable, time-windowed. Grouping key components
// are computed in code; the classifier never proves shared account control.
// ---------------------------------------------------------------------------

export const GROUP_WINDOW_MS: Record<string, number> = {
  spam: 10 * 60 * 1000,
  scam_suspected: 10 * 60 * 1000,
  targeted_harassment: 15 * 60 * 1000,
  private_information_suspected: 0, // never grouped: one incident per event
  spoiler_suspected: 10 * 60 * 1000,
  stream_issue_report: 2 * 60 * 1000,
  ordinary: 0,
  unknown: 0,
};

export interface GroupKeyInput {
  category: SignalCategory;
  normalizedText: string;
  targetUserId: string | null;
}

export function groupKey(input: GroupKeyInput): string | null {
  switch (input.category) {
    case "spam":
    case "scam_suspected":
      return `text:${normalizedHash(input.normalizedText)}`;
    case "targeted_harassment":
      if (!input.targetUserId) return null;
      return `target:${input.targetUserId}`;
    case "stream_issue_report":
      return "stream:audio-video";
    case "spoiler_suspected":
      return `spoiler:${normalizedHash(input.normalizedText)}`;
    case "private_information_suspected":
    case "ordinary":
    case "unknown":
      return null;
  }
}

export function severityFor(
  category: SignalCategory,
  opts: { accountCount: number; preset: PolicyPreset }
): Severity {
  switch (category) {
    case "private_information_suspected":
      return "critical";
    case "targeted_harassment":
      return opts.accountCount >= 3 ? "critical" : "high";
    case "scam_suspected":
      return "high";
    case "spam":
      if (opts.preset === "strict") return opts.accountCount >= 2 ? "high" : "medium";
      return opts.accountCount >= 5 ? "high" : "medium";
    case "spoiler_suspected":
      return "medium";
    case "stream_issue_report":
      return "low";
    case "ordinary":
    case "unknown":
      return "low";
  }
}

// ---------------------------------------------------------------------------
// Policy engine. Pure functions over validated inputs: no transport, clock, or
// model objects here. Callers inject `now` so tests use fake clocks.
// ---------------------------------------------------------------------------

export interface EffectivePolicy {
  preset: PolicyPreset;
  nuance: string;
  blockedDomains: string[];
  version: number;
}

export interface PolicyDecision {
  /** Review routing for the incident. Never an executable action. */
  route: "ignore" | "review" | "escalate";
  eligibleActions: ModerationAction[];
  recommendedAction: string;
  channelRule: string;
  uncertainty: string;
}

const HUMAN_ACTIONS: ModerationAction[] = ["delete_message", "timeout_user"];

export function previewPolicy(input: {
  preset: PolicyPreset;
  nuance: string;
  blockedDomains: string[];
}): PolicyPreview {
  const warnings: string[] = [];
  const nuance = input.nuance.trim();
  if (nuance.length > 0) {
    if (/always\s+ban|auto[\s-]?ban|permanent/i.test(nuance)) {
      warnings.push(
        "Nuance mentions automatic or permanent bans, which M0 does not perform. It will be shown to reviewers as context only."
      );
    }
    if (/allow\s+all|no\s+moderation|disable/i.test(nuance)) {
      warnings.push(
        "Nuance cannot disable review or platform rules. It will be shown to reviewers as context only."
      );
    }
    if (containsInjectionAttempt(nuance, "")) {
      warnings.push(
        "Nuance contains instruction-like phrasing. It is stored as inert context and grants no authority."
      );
    }
  }
  const summaries: Record<PolicyPreset, string> = {
    balanced: "Balanced: review suspected spam, scams, targeted hostility, and possible private-information disclosure. Ordinary banter stays out of the inbox.",
    banter_friendly:
      "Banter-friendly: roasting the streamer and reciprocal jokes stay out of the inbox. Repeated targeting of a viewer is still reviewed.",
    strict:
      "Strict: lower threshold for spam review. Nothing is enforced automatically; every action needs human approval.",
  };
  return {
    preset: input.preset,
    effectiveSummary: summaries[input.preset],
    allowedHumanActions: [...HUMAN_ACTIONS],
    blockedDomains: [...input.blockedDomains],
    automationEnabled: false,
    warnings,
  };
}

export function evaluatePolicy(input: {
  category: SignalCategory;
  policy: EffectivePolicy;
  accountCount: number;
  messageCount: number;
  hasBlockedDomain: boolean;
}): PolicyDecision {
  const { category, policy } = input;
  switch (category) {
    case "private_information_suspected":
      return {
        route: "escalate",
        eligibleActions: [...HUMAN_ACTIONS],
        recommendedAction: "Review urgently; mask evidence by default",
        channelRule: "Do not share private information. Masked until a moderator reveals it.",
        uncertainty:
          "Automated private-information detection is uncertain. Confirm from the masked evidence before acting.",
      };
    case "targeted_harassment":
      return {
        route: "escalate",
        eligibleActions: [...HUMAN_ACTIONS],
        recommendedAction: "Review the targeted messages with context",
        channelRule:
          policy.preset === "banter_friendly"
            ? "Jokes about the streamer are fine; repeated personal attacks on viewers are not."
            : "Repeated personal attacks are not allowed. Disagreement and criticism are allowed.",
        uncertainty:
          "Tone is hard to judge automatically. Check whether the target participates willingly or asked it to stop.",
      };
    case "scam_suspected":
      return {
        route: "escalate",
        eligibleActions: [...HUMAN_ACTIONS],
        recommendedAction: "Review suspected scam before anyone clicks",
        channelRule: "No scams or malicious links.",
        uncertainty: input.hasBlockedDomain
          ? "The link domain is on the owner-approved block list."
          : "Scam judgment is uncertain; verify the link pattern before acting.",
      };
    case "spam": {
      const threshold = policy.preset === "strict" ? 2 : 3;
      const route = input.accountCount >= threshold || input.messageCount >= 5 ? "review" : "review";
      return {
        route,
        eligibleActions: [...HUMAN_ACTIONS],
        recommendedAction: "Review grouped repetition together",
        channelRule: "No repetitive spam or unsolicited promotion.",
        uncertainty:
          "Repetition is observed; coordination is not proven. Authorized promotion can look similar.",
      };
    }
    case "spoiler_suspected":
      return {
        route: "review",
        eligibleActions: ["delete_message"],
        recommendedAction: "Review suspected spoiler (beta behavior)",
        channelRule: "Story Mode spoiler rules apply when the creator enabled them.",
        uncertainty: "Spoiler detection is uncertain without verified game progress.",
      };
    case "stream_issue_report":
      return {
        route: "ignore",
        eligibleActions: [],
        recommendedAction: "No moderation action; surface as operational report",
        channelRule: "Technical complaints are never punished as toxicity.",
        uncertainty: "Chat reports are reports, not verified measurements of the broadcast.",
      };
    case "ordinary":
    case "unknown":
      return {
        route: "ignore",
        eligibleActions: [],
        recommendedAction: "No action",
        channelRule: "Ordinary conversation.",
        uncertainty: "Not classified as a policy issue.",
      };
  }
}

// ---------------------------------------------------------------------------
// Dispatch checklist inputs. The worker revalidates every invariant immediately
// before dispatch; this pure helper computes the verdict from validated state.
// ---------------------------------------------------------------------------

export interface DispatchState {
  mode: WorkspaceMode;
  paused: boolean;
  writeDisabled: boolean;
  actorAuthorized: boolean;
  policyCurrent: boolean;
  evidenceCurrent: boolean;
  targetExists: boolean;
  paramsEqualApproved: boolean;
  evidenceFresh: boolean;
  superseded: boolean;
  conflictingInFlight: boolean;
  withinRateCap: boolean;
  notExpired: boolean;
  authorityCurrent: boolean;
}

export type DispatchVerdict =
  | { ok: true }
  | { ok: false; code: "preview_no_writes" | "paused" | "permission_required" | "policy_changed" | "stale_evidence" | "missing_target" | "expired" | "rate_limited" | "conflict"; reason: string };

export function checkDispatch(s: DispatchState): DispatchVerdict {
  if (s.mode === "preview" || s.writeDisabled)
    return { ok: false, code: "preview_no_writes", reason: "Preview never performs writes." };
  if (s.paused) return { ok: false, code: "paused", reason: "Dispatch is paused." };
  if (!s.authorityCurrent)
    return { ok: false, code: "conflict", reason: "Authority changed since approval." };
  if (!s.actorAuthorized)
    return { ok: false, code: "permission_required", reason: "Actor is no longer authorized." };
  if (!s.policyCurrent)
    return { ok: false, code: "policy_changed", reason: "Policy changed since approval." };
  if (!s.evidenceCurrent || !s.evidenceFresh)
    return { ok: false, code: "stale_evidence", reason: "Evidence changed or went stale." };
  if (!s.targetExists || !s.paramsEqualApproved)
    return { ok: false, code: "missing_target", reason: "Approved target no longer matches." };
  if (s.superseded) return { ok: false, code: "conflict", reason: "Superseded by other work." };
  if (s.conflictingInFlight)
    return { ok: false, code: "conflict", reason: "Conflicting operation in flight." };
  if (!s.withinRateCap) return { ok: false, code: "rate_limited", reason: "Rate cap reached." };
  if (!s.notExpired) return { ok: false, code: "expired", reason: "Approval expired." };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Idempotency: scoped key + request hash. Same key + same hash replays the
// original operation; same key + different hash is a conflict.
// ---------------------------------------------------------------------------

export function requestHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function canonicalActionRequest(parts: {
  workspaceId: string;
  incidentId: string;
  action: string;
  targetMessageId: string | null;
  targetUserId: string;
  durationSeconds: number | null;
}): string {
  return JSON.stringify([
    parts.workspaceId,
    parts.incidentId,
    parts.action,
    parts.targetMessageId ?? "",
    parts.targetUserId,
    parts.durationSeconds ?? 0,
  ]);
}

// Human approvals expire after 120 seconds and must be refreshed.
export const APPROVAL_TTL_MS = 120_000;
// Simulated dispatch is capped like the future automatic cap: 10/minute/channel.
export const SIMULATED_DISPATCH_CAP_PER_MIN = 10;
