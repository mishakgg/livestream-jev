import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared runtime-validated contracts for Livestream Copilot M0.
// Every identifier is an opaque string; display names are never identity.
// Chat text, usernames, titles, and classifier outputs are untrusted evidence.
// ---------------------------------------------------------------------------

export const WorkspaceModeSchema = z.enum(["preview", "assist"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

export const MembershipRoleSchema = z.enum(["owner", "moderator"]);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

export const EventKindSchema = z.enum([
  "message",
  "message_deleted",
  "user_messages_cleared",
  "moderation_observed",
  "connection_changed",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventOriginSchema = z.enum(["replay", "live"]);
export type EventOrigin = z.infer<typeof EventOriginSchema>;

// Closed, model-neutral signal categories. `ordinary` and `unknown` are never
// guilt; community feedback is not automatically abuse.
export const SignalCategorySchema = z.enum([
  "spam",
  "scam_suspected",
  "targeted_harassment",
  "private_information_suspected",
  "spoiler_suspected",
  "stream_issue_report",
  "ordinary",
  "unknown",
]);
export type SignalCategory = z.infer<typeof SignalCategorySchema>;

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const IncidentStateSchema = z.enum(["open", "claimed", "resolved", "dismissed"]);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

export const PolicyPresetSchema = z.enum(["balanced", "banter_friendly", "strict"]);
export type PolicyPreset = z.infer<typeof PolicyPresetSchema>;

export const ModerationActionSchema = z.enum(["delete_message", "timeout_user"]);
export type ModerationAction = z.infer<typeof ModerationActionSchema>;

// M0 supports human-approved simulated delete/timeout only. Bans are proposed
// as review items and always refused at the action boundary in this milestone.
export const ProposedActionSchema = z.enum(["delete_message", "timeout_user", "ban_user"]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ActionIntentStateSchema = z.enum([
  "proposed",
  "awaiting_approval",
  "queued",
  "submitting",
  "succeeded",
  "unknown",
  "reconciled_succeeded",
  "refused",
  "expired",
  "cancelled",
  "superseded",
]);
export type ActionIntentState = z.infer<typeof ActionIntentStateSchema>;

export const AttemptOutcomeSchema = z.enum([
  "succeeded",
  "unknown",
  "refused",
  "expired",
  "cancelled",
  "superseded",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

// ---------------------------------------------------------------------------
// Error codes: typed, structured, no secrets or raw chat bodies.
// ---------------------------------------------------------------------------

export const ApiErrorCodeSchema = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "stale_evidence",
  "policy_changed",
  "permission_required",
  "role_revoked",
  "preview_no_writes",
  "rate_limited",
  "outcome_unknown",
  "unsupported_capability",
  "missing_target",
  "paused",
  "expired",
  "idempotency_conflict",
  "gone",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().max(300),
  // Current versions are exposed on conflicts so the caller can refresh; they
  // never leak another tenant's data.
  current: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export const ReplayEventSchema = z.object({
  deliveryId: z.string().min(1).max(128),
  platformMessageId: z.string().min(1).max(128),
  kind: EventKindSchema.default("message"),
  authorId: z.string().min(1).max(128),
  authorName: z.string().min(1).max(128),
  text: z.string().min(1).max(2000),
  replyToMessageId: z.string().min(1).max(128).optional(),
  // ISO-8601 provider event time. Missing/unparseable times are rejected:
  // clock uncertainty must never drive enforcement.
  providerTime: z.string().datetime({ offset: true }),
});
export type ReplayEvent = z.infer<typeof ReplayEventSchema>;

export const ReplayBatchSchema = z.object({
  events: z.array(ReplayEventSchema).min(1).max(500),
});
export type ReplayBatch = z.infer<typeof ReplayBatchSchema>;

export const ReplayResultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  eventIds: z.array(z.string().uuid()),
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export const IncidentSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  channelId: z.string().min(1),
  category: SignalCategorySchema,
  severity: SeveritySchema,
  title: z.string(),
  state: IncidentStateSchema,
  claimedByUserId: z.string().nullable(),
  claimedByDisplayName: z.string().nullable(),
  version: z.number().int().nonnegative(),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  accountCount: z.number().int().nonnegative(),
  targetUserId: z.string().nullable(),
  recommendedAction: z.string(),
  policyVersion: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type IncidentSummary = z.infer<typeof IncidentSummarySchema>;

export const EvidenceMessageSchema = z.object({
  id: z.string().uuid(),
  platformMessageId: z.string(),
  authorId: z.string(),
  // Author names are untrusted display strings, rendered as text only.
  authorName: z.string(),
  // Original text; may be masked when it likely contains private information.
  // `masked: true` means `text` is a placeholder, not the original.
  text: z.string(),
  masked: z.boolean(),
  replyToMessageId: z.string().nullable(),
  providerTime: z.string(),
  origin: EventOriginSchema,
});
export type EvidenceMessage = z.infer<typeof EvidenceMessageSchema>;

export const IncidentDetailSchema = IncidentSummarySchema.extend({
  summary: z.string(),
  evidence: z.array(EvidenceMessageSchema),
  // Bounded chronological context around the evidence (not whole history).
  context: z.array(EvidenceMessageSchema),
  contextTruncated: z.boolean(),
  channelRule: z.string(),
  observedPattern: z.string(),
  uncertainty: z.string(),
  eligibleActions: z.array(ModerationActionSchema),
  knownNativeActions: z.array(z.string()),
});
export type IncidentDetail = z.infer<typeof IncidentDetailSchema>;

export const ClaimRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ResolveRequestSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  disposition: z.enum(["resolved", "dismissed"]),
  reason: z.string().min(1).max(500),
});
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export const PolicyDraftSchema = z.object({
  preset: PolicyPresetSchema,
  // Bounded owner-approved nuance. Free text can never create actions,
  // durations, scopes, URLs, or permissions.
  nuance: z.string().max(500).default(""),
  blockedDomains: z.array(z.string().min(1).max(253)).max(50).default([]),
});
export type PolicyDraft = z.infer<typeof PolicyDraftSchema>;

export const PolicyPreviewSchema = z.object({
  preset: PolicyPresetSchema,
  effectiveSummary: z.string(),
  allowedHumanActions: z.array(ModerationActionSchema),
  blockedDomains: z.array(z.string()),
  automationEnabled: z.literal(false),
  warnings: z.array(z.string()),
});
export type PolicyPreview = z.infer<typeof PolicyPreviewSchema>;

export const PolicyVersionSchema = z.object({
  version: z.number().int().nonnegative(),
  preset: PolicyPresetSchema,
  nuance: z.string(),
  blockedDomains: z.array(z.string()),
  createdByUserId: z.string(),
  createdAt: z.string(),
});
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const CreateActionRequestSchema = z.object({
  incidentId: z.string().uuid(),
  action: ProposedActionSchema,
  // Exact targets resolved from stored evidence. A missing message id for a
  // delete is rejected — it must never be interpreted as clearing chat.
  targetMessageId: z.string().min(1).max(128).optional(),
  targetUserId: z.string().min(1).max(128),
  durationSeconds: z.number().int().min(1).max(1209600).optional(),
  expectedIncidentVersion: z.number().int().nonnegative(),
  expectedPolicyVersion: z.number().int().nonnegative(),
});
export type CreateActionRequest = z.infer<typeof CreateActionRequestSchema>;

export const ActionIntentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  incidentId: z.string().uuid(),
  operationKey: z.string(),
  action: ProposedActionSchema,
  targetMessageId: z.string().nullable(),
  targetUserId: z.string(),
  durationSeconds: z.number().int().nullable(),
  state: ActionIntentStateSchema,
  actorUserId: z.string(),
  policyVersion: z.number().int().nonnegative(),
  evidenceVersion: z.number().int().nonnegative(),
  mode: WorkspaceModeSchema,
  // Simulation-only in M0: never a confirmed live platform action.
  executor: z.enum(["simulation"]),
  expiresAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastOutcome: AttemptOutcomeSchema.nullable(),
  lastOutcomeDetail: z.string().nullable(),
});
export type ActionIntent = z.infer<typeof ActionIntentSchema>;

export const ApproveActionRequestSchema = z.object({
  expectedIncidentVersion: z.number().int().nonnegative(),
  expectedPolicyVersion: z.number().int().nonnegative(),
});
export type ApproveActionRequest = z.infer<typeof ApproveActionRequestSchema>;

// ---------------------------------------------------------------------------
// Workspace, health, stream issues
// ---------------------------------------------------------------------------

export const WorkspaceInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  channelId: z.string(),
  mode: WorkspaceModeSchema,
  paused: z.boolean(),
  policyVersion: z.number().int().nonnegative(),
  authorityVersion: z.number().int().nonnegative(),
  role: MembershipRoleSchema,
});
export type WorkspaceInfo = z.infer<typeof WorkspaceInfoSchema>;

export const HealthSchema = z.object({
  workspaceId: z.string().min(1),
  mode: WorkspaceModeSchema,
  paused: z.boolean(),
  connection: z.enum(["demo-replay", "disconnected"]),
  writesDisabled: z.boolean(),
  writesDisabledReason: z.string(),
  queueDepth: z.number().int().nonnegative(),
  receivedEvents: z.number().int().nonnegative(),
  deduplicatedDeliveries: z.number().int().nonnegative(),
  evaluatedEvents: z.number().int().nonnegative(),
  skippedEvents: z.number().int().nonnegative(),
  // Persisted processing-state breakdown (migration 003). Outbox handoff is
  // transport, not completion: coverage keys on these, never on queueDepth.
  classifiedEvents: z.number().int().nonnegative(),
  awaitingProcessing: z.number().int().nonnegative(),
  failedEvents: z.number().int().nonnegative(),
  outboxPending: z.number().int().nonnegative(),
  openIncidents: z.number().int().nonnegative(),
  classifier: z.enum(["fake-deterministic", "unavailable"]),
  lastProcessedAt: z.string().nullable(),
  // Human-readable coverage state; a green badge requires real evidence.
  coverage: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

export const StreamIssueCardSchema = z.object({
  workspaceId: z.string().min(1),
  distinctAccounts: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  windowMinutes: z.number().int().positive(),
  firstObservedAt: z.string().nullable(),
  lastObservedAt: z.string().nullable(),
  headline: z.string(),
  incidentId: z.string().uuid().nullable(),
  acknowledged: z.boolean(),
});
export type StreamIssueCard = z.infer<typeof StreamIssueCardSchema>;

// ---------------------------------------------------------------------------
// Demo auth (development only; production refuses these routes)
// ---------------------------------------------------------------------------

export const DemoLoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
});
export type DemoLoginRequest = z.infer<typeof DemoLoginRequestSchema>;

export const DemoSessionSchema = z.object({
  token: z.string(),
  userId: z.string(),
  displayName: z.string(),
  workspaceId: z.string(),
  role: MembershipRoleSchema,
});
export type DemoSession = z.infer<typeof DemoSessionSchema>;

// ---------------------------------------------------------------------------
// Workspace update stream (SSE payload)
// ---------------------------------------------------------------------------

export const WorkspaceUpdateSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(["incident", "action", "health", "stream_issue", "policy", "mode"]),
  refId: z.string(),
  at: z.string(),
});
export type WorkspaceUpdate = z.infer<typeof WorkspaceUpdateSchema>;
