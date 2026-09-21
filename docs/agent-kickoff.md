# Initial coding-agent assignment

The text below is the first implementation prompt. This is a request for **M0 only**, not authorization to deploy or moderate real viewers.

---

Work in `https://github.com/mishakgg/livestream-jev` and implement **M0: a useful local replay product**.

First inspect current `origin/main`, record its SHA, read existing code and open PRs, and create a scoped branch such as `codex/m0-replay-workspace`. Preserve intervening work. Read `AGENTS.md` and `README.md`, followed by `docs/product.md`, `docs/roadmap.md`, `docs/ux.md`, `docs/architecture.md`, `docs/contracts.md`, `docs/policy.md`, `SECURITY.md`, and `docs/testing.md`. Consult `docs/platforms.md`, `docs/jev.md`, and `docs/sources.md` for integration boundaries; do not implement later milestones now.

The product is an incident-first moderation copilot, not another chatbot or a replacement for human moderators. Build an actually usable end-to-end local application with persisted evidence and recovery behavior, not a decorative dashboard with hard-coded counts.

Use the chosen TypeScript stack: Node.js 24 LTS, npm workspaces, React/Vite, Fastify, a separate worker from the same codebase, PostgreSQL, pg-boss, runtime-validated shared contracts, and focused browser/integration tests. Pin supported dependency versions and commit the lockfile. Add only the packages and infrastructure needed for this slice. Do not introduce Redis, Kafka, Kubernetes, a vector database, or a second backend language.

Implement a deterministic ReplayAdapter and FakeClassifier that pass synthetic chat through the real domain pipeline: durable intake and outbox, deduplication, bounded context, incident grouping, policy evaluation, persisted action intents, and dashboard updates. Build a stable incident list, evidence detail, claim/dismiss/resolve workflow, policy preview, health/coverage states, and one compact chat-reported stream-problem card. Use synthetic fixtures covering coordinated spam variants, channel-appropriate banter, repeated targeted hostility, ordinary conversation, and a reported audio problem. Counts and timelines must come from persisted events.

Show an unmistakable Demo label. Provide development-only seeded identities in two isolated workspaces; production must refuse demo auth and replay mutation endpoints. Preview must never call an action executor. After an explicit demo Assist transition, allow a human to approve simulated delete/timeout requests through a simulation-only executor and ledger. No real tokens, Twitch writes, Jev calls, automatic bans, payments, or cloud deployment. Simulated outcomes must never look like confirmed live actions.

Treat chat, usernames, model outputs, and quoted rules as untrusted evidence. Only server-side validated authority can create an action. Bind every operation to its workspace, channel, initiating actor, exact target, policy version, and current permissions. A second click or refresh must recover the original operation, not create a duplicate. Missing message IDs must be rejected, never interpreted as clearing chat. Unknown outcomes must not be blindly retried. A pause must block new dispatch admission while honestly distinguishing work already submitted.

Exercise the complete workflow in a real browser and PostgreSQL-backed integration tests: replay events, inspect one grouped incident, claim it, approve one simulated action, refresh, and retain one logical action. Test duplicate and out-of-order events, cross-tenant access, two moderators racing, stale approvals, worker restart, unknown simulated effects, prompt injection, escaped malicious text, permission denial, and Preview's zero-write invariant. Do not replace database concurrency tests with mocks or claim fake classification proves model quality.

Provide a documented clean-checkout setup using local Docker Compose dependencies, migrations, seed/replay steps, environment examples without secrets, and a safe teardown. Add root scripts for `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `build`, and `check:docs`, with CI for implemented checks. Update README and roadmap status to reflect exactly what works; clearly distinguish planned commands and features from tested ones.

Make small, reviewable commits and open a PR; do not merge or deploy. In the PR report the base SHA, working user journey, actual commands/results, browser checks, database migration/cleanup behavior, safety invariants, and remaining blockers. Include a short demo procedure and screenshots when supported. Deliver the coherent M0 slice; do not hide missing backend behavior behind UI fixtures or describe later milestones as completed.
