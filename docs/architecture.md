# Architecture and implementation decisions

All components below are planned. See [contracts](contracts.md), [policy](policy.md), [platforms](platforms.md), and [SECURITY](../SECURITY.md).

## Selected stack

Use a modular TypeScript monorepo with npm workspaces: React/Vite client, Fastify HTTP API, and a separate Node.js worker process sharing the same domain packages. Node.js 24 LTS is the baseline [S14](sources.md). Use PostgreSQL for durable state and pg-boss for jobs [S15](sources.md), with versioned SQL migrations and `pg` for explicit queries. Pick and pin compatible supported releases during M0; commit one lockfile.

Use one shared runtime schema library (Zod), strict TypeScript, Vitest for unit/integration tests, and Playwright for browser tests. The choice is a project decision, not a claim that other stacks cannot work.

The web application and `/api` should be served under one origin. The API owns sessions and authorization. Use SSE for dashboard updates and normal authenticated HTTP mutations. Long-lived intake/work must not depend on a browser tab or request-scoped serverless function.

Proposed boundaries:

```
apps/web/                 onboarding, inbox, details, creator view
apps/api/                 sessions, OAuth, webhooks, queries, commands, SSE
apps/worker/              classification, incidents, action dispatch, retention
packages/contracts/      runtime schemas and shared API/event types
packages/domain/         context, grouping, policy, state machines
packages/db/             queries, migrations, outbox integration
packages/platforms/      Twitch and deterministic replay adapters
packages/classifier/     Jev adapter and deterministic test provider
fixtures/                synthetic chat and labelled evaluation cases
```

Do not create all folders as empty scaffolding. M0 should implement only the modules needed for its working slice. No Kubernetes, Kafka, Redis, vector database, Python service, generic autonomous agent framework, or video pipeline initially. Add infrastructure only after a demonstrated limit.

## Data path

`Verified event → durable intake/outbox → bounded context + deterministic features → selective Jev evaluation → typed signals → incident/policy → approved action ledger → platform adapter → reconciliation → UI`

Webhook handling validates the raw signature, replay metadata, schema, subscription, and channel binding. Persist the deduplicated event and outbox row in one transaction; acknowledge only durable acceptance, without waiting for AI. Duplicate verified deliveries return success without new work. Database failure must not return a misleading success.

An outbox dispatcher sends stable job identifiers to pg-boss; a crash between sending and marking the outbox delivered may duplicate a job, so domain handlers remain idempotent. Use bounded retry, expiry, dead-letter handling, and an operator-visible backlog. Validate the actual queue library transaction/lease behavior; do not assume a library's job-delivery guarantee covers Twitch side effects.

Process channel-local context in event-time order within a bounded reorder window. Keep provider event time, received time, processed time, and gaps separately. Late/replayed events may support review but must not trigger delayed punishment. Use channel-scoped serialized state updates or explicit optimistic versions rather than a global lock.

## Context, grouping, and cost

Use bounded recent/reply/target context and observed channel-local history. Provisional initial ceilings: 30 nearby messages, a 15-minute behavioral window, and 4,000 provider-input tokens per evaluated state. Preserve the relevant message and rule before optional context; expose truncation. These are tunable engineering defaults, not provider limits or validated accuracy settings.

Perform normalization, URL/domain extraction without fetching, counts, intervals, repetition, and exact matching in code. Group by validated features, target/reply links, and time window; AI may help judge relevance but cannot prove shared account control. Store original text separately and retain which messages justify grouping.

Do not send every incoming message separately to Jev. Apply bounded candidate selection, share compact context, and prioritize severe candidates. Evaluate an unbiased sample of otherwise unflagged messages during approved quality review to detect blind spots. Sampled-out or over-budget messages are 'not AI evaluated', not 'safe'. Repeated benign text can be cached only with channel, policy, model, context, and language versions in the key.

Enforce provider request and token limits across the whole deployment, plus fair per-channel budgets. A single-channel attack must not starve others. Reduce optional analysis first under overload; keep admission, deterministic safeguards, health reporting, and authorized manual controls available where infrastructure permits. Never silently increase moderation aggressiveness to reduce queue length.

## Dispatch and reconciliation

An ActionIntent is durable before submission. Resolve exact target IDs from stored evidence; never accept arbitrary model parameters. Revalidate every invariant in the policy contract immediately before dispatch. Use application idempotency keys, per-target action serialization, and database uniqueness/versions.

The pause/disconnect endpoint and dispatch gate share a serialized per-channel authority boundary. Record an incrementing authority version. A worker must atomically pass the current gate before transitioning to submitting. Pause confirmation guarantees no later action passes the automatic gate; it cannot retract an already-submitting network call. Record and show that boundary rather than promising instantaneous reversal.

Timeouts, dropped responses, and crashes after submission produce `unknown`, not automatic success/failure. Reconcile through allowed platform reads/events where possible. Do not blindly retry a timeout or ban and extend a sanction. Native actions can supersede pending work. A content-free tombstone prevents deleted evidence being recreated by late delivery.

## UI updates and persistence

Persist a scoped monotonically increasing update cursor. SSE reconnect uses the last acknowledged cursor; duplicates are harmless. An expired cursor requests a new authorized snapshot, not an unlimited replay. Paginate incidents/history and bound each stream's backlog. Disconnect slow consumers, close streams after revoked membership, and reauthorize resumed snapshots.

Never share a mutable tenant context across requests. Separate service health from 'no chat activity'. Track callback/subscription status, queue age, classifier status, action failures, and dashboard connectivity. Correlation IDs must work without logging raw speech.

## Deployment direction, not deployment authorization

Containerize API and worker as separate entrypoints from a shared image; serve static web assets through the same-origin application/reverse proxy. Use a single small deployment plus PostgreSQL for the pilot; size it from tests, not guesses about unlimited channels. Production needs TLS, durable storage, encrypted backups, secrets management, supervision, readiness checks, and a restore runbook. No provider or cloud account has been chosen or configured.

Shutdown stops new admissions as appropriate, drains bounded work, and leaves durable work recoverable. Monitor DB connections, worker leases, file descriptors, queue depth, event age, model cost, and retry count. Add a global operational write-disable. Use migrations tested against a populated database and a documented rollback/forward-fix path.

## Decisions to revisit only with evidence

Twitch first; one channel/workspace; TypeScript throughout; PostgreSQL/pg-boss before extra infrastructure; signed webhooks for production Twitch intake; synthetic replay before real credentials; pinned Jev behind an interface; no generative model in the initial hot path; no cross-channel identities. Record rationale and consequences when changing these decisions.
