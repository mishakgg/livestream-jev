# Shared data and API contracts

Specification, not implemented schemas. M0 must create executable runtime schemas in `packages/contracts` and test them. Store all identifiers as opaque strings; never use display names as identity.

## Tenant and identity

A Workspace has one connected Twitch channel in the MVP. Every channel-owned record carries `workspaceId` and `channelId`; uniqueness and foreign keys must prevent cross-workspace references. Membership is Owner or Moderator, keyed to the authenticated platform user ID. Server-derived scope is mandatory for all reads, writes, jobs, SSE cursors, and caches.

Keep `actorUserId` (the human or approved automation), `executorPlatformUserId` (token subject), and `subjectPlatformUserId` (moderation target) separate. Do not attribute owner-executed automation to a human moderator. Manual actions cannot silently borrow the owner's token.

## Core records

| Record | Minimum fields and invariants |
| --- | --- |
| PlatformConnection | platform, channel ID, owner subject, connection/authority version, status, verified capabilities, encrypted grant references, last health check |
| ChatEvent | internal ID, platform event/message IDs, kind, author ID, original text, normalized features, reply ID, provider/received times, origin live or replay, schema version, retention expiry |
| ContextSnapshot | evidence IDs, channel/policy version, event-time window, computed counts, language state, truncation/gap flags; no inherited authority |
| ClassifierEvaluation | model/requested and resolved version, schema/questions version, input digest, evidence IDs, typed answers, probability/confidence where supplied, latency/usage, validity/abstention/error |
| Incident | category, severity, evidence IDs, first/last observed times, distinct-account/message counts, exact target or unknown, state, claim, optimistic version |
| PolicyVersion | owner-approved structured policy, bounded nuance, created/approved by, effective time, parent version; immutable after approval |
| ActionIntent | operation/idempotency key, actor/executor/target IDs, exact action and parameters, evidence/incident versions, policy/authority versions, mode, expiry, approval record, state |
| ActionAttempt | intent ID, attempt number, request fingerprint, submitted/completed time, redacted provider result, outcome, reconciliation evidence |
| AuditEvent | actor, workspace, operation, prior/new state, time, rationale code, correlation ID; no raw message body |
| ReviewFeedback | evaluation/incident ID, reviewer, acceptable/violation/uncertain, reason, timestamp; not an automatic training label |
| CoverageWindow | interval, received/deduplicated/deterministic/AI-evaluated/skipped counts, source gaps, backlog, provider health |

Suggested event kinds: message, message_deleted, user_messages_cleared, moderation_observed, connection_changed. Add platform-specific fields only where sourced; unavailable values are null/unknown, not invented. A replay origin cannot be changed to live.

Deduplicate transport deliveries by platform + verified subscription/delivery ID; deduplicate chat events additionally by channel + provider message ID + kind. Preserve distinct intentional identical-text messages. Match counters count accepted unique events, not webhook retries. Deleted or expired evidence leaves a tombstone, not a fabricated transcript.

## Model-neutral signals

Use closed categories such as spam, scam_suspected, targeted_harassment, private_information_suspected, spoiler_suspected, stream_issue_report, ordinary, and unknown. Severity and probability are different fields. Multiple categories may apply; community feedback is not automatically abuse.

Retain source model fields with their actual semantics. A Noul value is not a provider `confidence` property. Missing answers, invalid distributions, inconsistent choices, out-of-range values, unresolved target identity, or incomplete context can force abstention. An explanation references evidence and rule IDs; it is not invented model reasoning.

## Incident and action states

Incident: `open → claimed → resolved` or `dismissed`; released claims return to open. New material can reopen with a new version and explanation. Closing a card is not proof of platform enforcement.

Action:

```
proposed → awaiting_approval → queued → submitting
                                      → succeeded
                                      → unknown → reconciled_succeeded / refused / expired
                   queued → cancelled / superseded / expired / refused
```

Automatic eligible actions may bypass awaiting_approval only under an already approved, current rule. Preview proposals never enter a dispatchable queue. Replay operations use a separate simulation ledger and adapter. `succeeded` requires a provider-confirmed result; a reconciliation event can confirm the desired state without falsely attributing who caused it. `handled_elsewhere` belongs in outcome metadata.

Do not resubmit an unknown action unless an operation-specific reconciliation establishes non-application and current authorization still allows it. Permanent failures are not retryable. Record approved timeout length in seconds and never rederive it from model text.

## Proposed HTTP surface

All channel routes are under `/api/workspaces/:workspaceId`; membership is mandatory. These names are implementation targets, not existing endpoints.

| Method/path | Contract |
| --- | --- |
| GET `/incidents?cursor=&status=` | Bounded page, stable cursor, no unbounded context payloads |
| GET `/incidents/:id` | Authorized evidence and current version; mask private text by default |
| POST `/incidents/:id/claim` | Expected incident version; conflict is explicit |
| POST `/incidents/:id/resolve` | Expected version, disposition, bounded reason |
| POST `/actions` | `Idempotency-Key`, exact approved action, stored evidence references, expected versions; returns operation ID |
| GET `/actions/:id` | Durable status for refresh/recovery; no reexecution |
| GET `/events` | Authorized SSE with bounded resume cursor and snapshot recovery |
| GET/POST `/policy` | Read/current draft; owner-only versioned save/approval |
| POST `/automation/pause` | Owner or authorized moderator can pause; only owner may re-enable |
| POST `/connection/disconnect` | Owner; authority fence, grant cleanup, stop processing |
| POST `/data-deletion` | Owner; queued deletion with observable completion status |

OAuth/session and signed-webhook routes are separate, narrow unauthenticated entry points with their own validation. Demo endpoints run only in a nonproduction, synthetic-only environment; they must not weaken production auth. Other platforms return unavailable, not a successful fake connection.

For actions, replay the existing operation when the same scoped key and request hash recur. Reject a reused key with changed parameters. Different intentional actions need different keys. Conflict responses expose current versions without leaking another tenant. Use structured errors such as permission_required, role_revoked, stale_evidence, policy_changed, rate_limited, outcome_unknown, and unsupported_capability. Never return secrets or provider raw bodies by default.

Validate size limits, timestamps, enums, action durations, IDs, cursors, and pagination at runtime. Route names, generated API documentation, and tests must stay in sync. Use parameterized queries and server-side allowlists; no user-controlled SQL filters or model-created URLs.
