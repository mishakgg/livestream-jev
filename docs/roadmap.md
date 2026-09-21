# Delivery roadmap

This is an ordered implementation plan, not a delivery-date promise. The repository currently contains specifications only. Each milestone must report implemented, simulated, live-tested, and blocked work separately. Refer to [testing](testing.md) for gates and [go to market](go-to-market.md) for demand validation.

## M0 — A useful local replay product

**First coding-agent assignment. No real platform credentials, provider calls, billing, or cloud deployment.**

Build a small, working vertical slice rather than scaffolding every future feature:

1. Establish the TypeScript/npm workspace, pinned supported dependencies, React/Vite client, Fastify API, worker, PostgreSQL migrations, and pg-boss job processing described in [architecture](architecture.md). Provide local Docker Compose for dependencies and one documented startup path. Implement only packages needed by this slice.
2. Define runtime-validated tenant/channel/event/incident/policy/action contracts. Seed two isolated demo workspaces and synthetic test identities through an explicitly development-only path; production must refuse demo authentication and replay mutation routes.
3. Implement a deterministic ReplayAdapter and FakeClassifier. Send synthetic events through the same durable intake, deduplication, context, incident, policy, and action-intent services that later adapters will use. No direct dashboard-fixture bypass. Preserve event IDs, timestamps, provenance, and duplicate delivery behavior.
4. Ship a usable demo workspace: stable priority inbox, grouped spam and harassment examples, evidence detail, observed-history limits, claim/dismiss/resolve, policy preview, connection/coverage status, and a small chat-reported stream-problem card. Every count must derive from persisted events. Keep the creator card lightweight; no analytics subsystem.
5. Demonstrate Preview and human-approved **simulated** delete/timeout flows. Keep the simulation action ledger and executor unmistakably separate from real platform dispatch. Preview must never invoke a write adapter; fake actions require an explicit demo Assist transition. Do not implement real automatic deletion, real bans, or approval shortcuts.
6. Make refresh, double-click, duplicate delivery, two moderators, worker restart, pause, stale policy, missing IDs, and unknown simulated outcomes safe. Expose typed errors and recover existing operations rather than silently creating new ones.
7. Add meaningful unit, real-PostgreSQL integration, and browser tests. Add a documentation-link checker, accurate setup instructions, environment example without secrets, CI, and a reproducible demonstration script. Report actual commands and results.

**Acceptance:** a reviewer can run the documented setup without API keys, replay a fixture, inspect a grouped incident and its original evidence, claim it, approve a simulated action, refresh, and see one persisted logical action. A second workspace cannot access it. Restarting a worker neither loses accepted work nor duplicates a simulated side effect. Injection fixtures cannot change policy or invoke tools. No outgoing live moderation path exists in M0.

Do not claim that the fake classifier validates Jev quality or that local replay measures platform delivery latency. The M0 README must explicitly label these limits.

## M1 — Twitch Preview, with explicit readiness gates

Implement the dated Twitch capability/authorization matrix and operator setup in [platforms](platforms.md). Verify OAuth identity, service-bot read grants, channel consent, raw-body signed webhook challenge/delivery handling, durable intake, deletion/clear observations, token lifecycle, reconnection, and coverage states.

Real channel intake requires the platform data-use, privacy, credentials, and operator gates in [SECURITY](../SECURITY.md), even when no AI provider is called. External-provider processing requires an additional approved provider data-handling review. Until that review is complete, do not send real chat to Jev or silently substitute fake judgments for real analysis. Show which analysis is unavailable.

Add the pinned Jev adapter first against synthetic inputs, validate schema/errors/deadlines/rate limits, then enable approved minimized real-data evaluation in Preview only. Record actual model/version/usage and evidence references. Run the held-out evaluation procedure; do not infer quality from successful API responses.

**Acceptance:** one expressly authorized test channel has verified live read-only intake, honest health/coverage, permission revocation behavior, bounded retention, and a useful inbox. Preview has zero platform writes under all action routes and retained-token scenarios. Missing external access is a named blocker, not a successful live test.

## M2 — Human Assist and a small creator pilot

Add progressively authorized individual delete, timeout, and explicitly confirmed ban actions using the initiating human's own platform identity. Implement invitation/current-role verification, claims and version conflicts, action intent/attempt ledger, native-action reconciliation, unknown-outcome handling, pause fencing, and full audit attribution. No bulk sanctions.

Complete accessible moderator workflows and a compact creator view. Chat-reported technical problems remain reports, not verified diagnoses. Collect explicit feedback without automatic retraining or policy edits. Implement workspace disconnect/deletion, TTL jobs, backup deletion semantics, operational limits, observability without chat bodies, and the incident response runbook.

**Acceptance:** controlled live tests exercise authorized action successes and failures, wrong identities, revoked moderators, ambiguous submission, and already-handled messages. Security and retention gates pass. Run an opt-in, closely supported pilot only after deployment and operator approval. Collect actual moderation-time and trust evidence; record costs and non-adoption as well as successes.

## M3 — Narrow Guarded deletion

Only owner-approved deterministic repetition rules and explicitly confirmed scam-domain rules are eligible. AI-only harassment, private-information, spoiler, timeout, and ban automation are excluded. See the exact policy matrix and expiry/cap defaults in [policy](policy.md).

Require the shadow-review sample and other gates in [testing](testing.md), explicit category/rule consent, native-role checks, per-channel and global pause, action freshness, bounded rates, audited changes, and an operational rollback drill. A newly changed rule needs fresh validation. More deletions are not a success metric.

**Acceptance:** the selected rule family meets the declared evidence gate; opt-in cannot be enabled by a moderator, a classifier, an imported policy, or billing state. Exceeding a limit downgrades to review with a visible reason. If evidence is insufficient, remain in Assist rather than weakening the gate.

## After pilot evidence

Story Mode is a review-first beta with explicit game/progress settings and masked suspected spoilers. Evaluate false positives and uncertainty before any broader claims. Do not add livestream video/audio ingestion to make the initial chat product work.

Kick and YouTube are separate adapter milestones, each with its own current API, role, quota, data-policy, and live-test gate. Prioritize the platform requested by retained pilot teams; do not build both merely to populate a landing page. Multistream incidents must retain platform-specific identity and action boundaries.

A conversational evidence assistant needs a separate generative capability: Jev is not a text-generation model. Start read-only, return linked channel-scoped evidence, and keep sanctions outside conversational execution. Consider billing only after a retained workflow, measured unit economics, and a validated offer exist.

## Definition of done for every milestone

Code and migrations run from a clean checkout; contracts and UI reflect actual capability; tests cover normal, adversarial, and recovery paths; bounded resource/cost behavior is measured; documentation states exact commands and known limits; no credentials or real chat fixtures enter Git; the PR reports its base SHA and verification evidence. Production readiness is a separate reviewed decision, never inferred from a merged PR.
