# Testing and acceptance evidence

These are release gates and target measurements, not completed tests. The first agent creates runnable tooling and records real results. Unit CI uses synthetic fixtures and no paid APIs.

## Mandatory invariant suite

| Boundary | Required cases |
| --- | --- |
| Preview/replay | Zero real adapter writes with valid grants, queued jobs, retries, malformed inputs, and mode changes; replay cannot obtain live credentials |
| Identity/tenant | Cross-workspace IDs/cursors, wrong OAuth subject/channel, expired invite, removed moderator, revoked token, role change with open SSE, forged role fields |
| Intake | Valid/invalid raw signatures, old/replayed delivery, duplicate IDs, identical distinct messages, reorder, database failure before ack, deletion tombstone, historical replay |
| Policy | Version changes after approval, arbitrary action/duration injection, unknown targets, unsupported language, protected targets, mode downgrade, cap hit |
| Concurrency | Double click, refresh after lost ack, two moderators, worker crash before/after dispatch, native action race, pause/disconnect versus pending work |
| Provider | 429, timeout, stalled response, malformed/missing answers, invalid probabilities, model version change, contradictory signals, budget exhaustion |
| Security/output | Prompt injection in chat/name/title/history, HTML/Markdown payloads, malicious URLs, raw private-info leakage, unsafe redirects, CSRF, secrets in errors |
| Lifecycle | Bounded queues/history, cancellation, SSE cleanup, DB connection cleanup, fair scheduling, retention deleting copies/jobs, restore applying tombstones |

Policy tests assert actual platform-adapter call counts and targets; checking a UI badge or source string is insufficient. Database tests use an isolated real PostgreSQL database to exercise uniqueness, transactions, leases, and races.

## Evaluation dataset

Start with synthetic, labelled transcripts and deterministic expected invariants. At minimum cover benign roasting of the streamer, reciprocal jokes, quoted abuse, criticism, repeated targeted attacks, near-duplicate scam variants, authorized promotion, ordinary shared links, false-positive private-information patterns, actual fictional private-information disclosure, spoilers versus permitted hints, chat-reported audio problems, emoji/Unicode obfuscation, and multilingual/unsupported content.

Each case records provenance, category, policy, context availability, supported language, expected incident grouping, acceptable dispositions, prohibited actions, and reviewer rationale. Ambiguous cases can allow several safe outcomes. Include adversarial text claiming to be an owner/system instruction or requesting a ban. No real personal information in fixtures.

Synthetic tests prove software behavior, not real-world model quality. Build a separately approved and minimized pilot dataset with at least two reviewers for disputed/high-impact cases. Split by channel/incident and near-duplicate campaign, not random messages that leak into both train/tuning and test. Keep a held-out set unchanged while tuning. Do not label an unflagged message safe without review.

## Quality gates

For Preview/Assist: report per-category precision, recall, abstention, grouping precision, and false-positive burden; compare review time to a baseline using the same scenarios. Record disagreement and confidence intervals rather than a single 'accuracy' percentage. Unsupported-language results do not justify supported-language claims.

For M3 Guarded: deterministic rules only; zero unauthorized/stale/Preview writes in the invariant suite, no unresolved critical security defects, owner approval, live sandbox action verification, and a shadow review of at least 500 independent eligible message decisions with no incorrect proposed deletions. Report the sample design, channels and uncertainty; 500 successes do not prove zero risk. Correlated copies of one campaign do not constitute 500 independent safety observations. If the sample cannot be obtained, remain Assist.

AI-only automatic moderation is outside this release; a later proposal must define its own category-specific false-positive budget and evaluation gate. Never meet a target by removing hard cases or relabeling disagreement as agreement.

## Performance targets

Measure on disclosed hardware/build/dataset, with warm/cold and mocked/live-provider conditions separate:

- Webhook durable acknowledgement: p95 under 500 ms under the stated test load, without a model call.
- Application receive-to-incident visibility: p95 under 2 seconds for admitted contextual candidates; report skipped work and backlog separately. This excludes unknown upstream delivery time and is not a 'message never seen' guarantee.
- Reference load: 20 channels × 5 messages/second for 10 minutes, plus one-channel 500 messages/second for 60 seconds. The burst test expects bounded degradation, not every message sent to AI.
- During the burst, no duplicate logical admissions, no cross-channel starvation of control actions, and no queued stale automatic punishment. Report memory, queue age, dropped/skipped analysis, DB connections, and provider request/token usage.

These are initial engineering objectives, not a sold capacity tier. CI should assert bounded behavior and regressions, not brittle absolute timing on shared runners. Provider emulation must include the configured global quota and realistic latency.

## Browser and pilot evidence

Cover demo → incident → context → simulated action → reload recovery, list stability during new events, two simultaneous moderator sessions, no-action Preview, disabled capabilities, empty/offline/degraded states, masked sensitive text, keyboard navigation, focus restoration, 1440px/390px layouts, and 200% zoom. Use deterministic fixtures and an accessible test user flow.

Live tests require explicit owner authorization and controlled accounts/messages, not unsuspecting viewers. Report each endpoint actually exercised and untested prerequisites. Keep production credentials out of CI; do not run destructive tests automatically against a connected streamer.

Expected future root scripts: lint, typecheck, test, test:integration, test:e2e, build, check:docs; add eval and load commands when their harnesses exist. The completion report must say which commands ran and what passed, failed, or was skipped.
