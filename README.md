# Livestream Copilot

**Keep the chat moving. Put the right problems in front of the right moderator.**

Working product name for `livestream-jev`. Jev is the TypeSafe AI decision model used by the proposed service, not our own model or an affiliation claim. Final commercial naming is undecided.

## Status

**M0 implemented on branch `codex/m0-replay-workspace` (base `06cd24b`) — local demo only, not production.**

What works now (tested, see [Testing](#verification)):

- Deterministic synthetic replay through durable intake, deduplication, bounded context, incident grouping, policy evaluation, and persisted action intents — no dashboard fixtures.
- Usable moderator inbox (stable priority list), evidence detail with bounded context, claim/release/dismiss/resolve workflow, policy preview + versioned save, health/coverage states, and a compact chat-reported stream-problem card.
- Unmistakable Demo environment with two isolated workspaces (`demo-alpha`, `demo-beta`) and seeded identities.
- Preview (zero writes, enforced and tested) plus an explicit demo Assist transition enabling human-approved **simulated** delete/timeout actions through a simulation-only executor and ledger.

What is simulated (never a live action):

- Classification is a deterministic fake (`fake-deterministic`); it proves pipeline behavior, never model quality.
- All action outcomes come from the simulation ledger; unknown outcomes reconcile from the ledger, never by blind retry.

What is blocked / not yet built:

- Real Twitch intake, OAuth, webhooks, and moderation (M1/M2); Jev provider calls; billing; cloud deployment; automatic bans/timeouts; accessibility audit beyond baseline semantics; production auth (cookies/CSRF), TLS, secrets management, and backups.

Numeric targets elsewhere in these docs remain acceptance targets, never measured results.

## The product

A cloud-hosted moderation copilot for streamers and their human moderator teams. It turns fast-moving chat into a prioritized incident inbox, groups related spam and harassment, provides the relevant evidence, and helps moderators act without losing context. A small creator view surfaces important chat-reported stream problems without showing a wall of moderation noise.

Start with **Twitch**, **English-language evaluation**, and **Preview**: observe and show recommendations without platform writes. Add human-approved moderation next. Offer narrowly scoped automatic message deletion only after the safety gates pass and the creator explicitly enables it. Permanent bans remain human-approved. Kick, YouTube, Story Mode, and a conversational evidence assistant are staged extensions, not launch claims.

The service requires no streamer-side installation, OBS changes, local model, or video relay. Existing native moderation and bots stay in place. Receiving a chat event is not the same as intercepting a message before viewers see it.

## Start here

| Document | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Mandatory instructions for coding agents |
| [Product](docs/product.md) | Revised description, audience, scope, and changes to the supplied concept |
| [UX](docs/ux.md) | Onboarding, moderator workspace, creator view, and recovery states |
| [Architecture](docs/architecture.md) | Chosen stack, boundaries, reliability, and operating model |
| [Contracts](docs/contracts.md) | Tenant-scoped data, APIs, event and action lifecycles |
| [Platforms](docs/platforms.md) | Verified API facts, authorization design, and integration gates |
| [Jev](docs/jev.md) | Provider contract, limits, evidence, and evaluation discipline |
| [Policy](docs/policy.md) | Deterministic decision and automation authority |
| [Security](SECURITY.md) | Threat model, privacy, retention, and launch blockers |
| [Testing](docs/testing.md) | Acceptance tests, quality evaluation, and performance targets |
| [Roadmap](docs/roadmap.md) | Ordered milestones and definition of done |
| [Go to market](docs/go-to-market.md) | Positioning, pilot, pricing hypotheses, and validation |
| [Sources](docs/sources.md) | Dated primary references and unresolved checks |
| [Agent kickoff](docs/agent-kickoff.md) | Copyable first implementation assignment |
| [Demo guide](docs/demo.md) | M0 setup, seed/replay, demo procedure, and teardown |
| [Contributing](CONTRIBUTING.md) | Change and verification workflow |

## Implementation direction

TypeScript throughout; Node.js 24 LTS; npm workspaces; React/Vite web client; Fastify API; a separate worker from the same codebase; PostgreSQL and pg-boss. Share runtime-validated contracts. Keep the classifier behind a narrow provider interface. Start with deterministic synthetic replay and no credentials.

The first implementation milestone is **M0 in the roadmap**, not the whole vision: a working, persisted replay-to-incident-to-simulated-action slice with a usable dashboard and safety tests. The next milestone introduces real Twitch intake in Preview.

## Development

Prerequisites: Node.js 24 LTS, npm 11, and PostgreSQL 16 (local service or `docker compose up db`). No API keys or platform credentials are needed — or accepted — in M0.

```powershell
cp .env.example .env
npm ci
docker compose up -d db        # or start your local PostgreSQL 16
node scripts/db-ensure.mjs     # create DATABASE_URL database if missing
npm run db:migrate             # apply versioned migrations
npm run db:seed                # two demo workspaces + test identities
npm run dev:api                # Fastify API on http://localhost:3001
npm run dev:worker             # pg-boss outbox dispatcher + pipeline
npm run dev:web                # React client on http://localhost:5173
npm run replay:basic           # deterministic synthetic chat for demo-alpha
```

Then open http://localhost:5173, choose Alice (owner, Alpha), and follow the [demo guide](docs/demo.md). Safe teardown: `docker compose down` (add `-v` to drop demo data too) or `npm run db:reset` for a clean local database.

Pinned releases (see lockfile): TypeScript 5.6, React 18.3, Vite 5.4, Fastify 4.28, pg-boss 10.4, Vitest 2.1, Playwright 1.49, Zod 3.23, PostgreSQL 16.

## Verification

| Command | What it proves |
| --- | --- |
| `npm run lint` | ESLint, zero warnings |
| `npm run typecheck` | Strict `tsc --noEmit` per workspace |
| `npm run test` | Unit tests (contracts, domain, classifier, adapters) |
| `npm run test:integration` | Real-PostgreSQL integration: duplicates, races, stale approvals, restart recovery, unknown outcomes, injection, Preview zero-write |
| `npm run test:e2e` | Playwright browser journey: replay → grouped incident → claim → simulated action → refresh recovery, plus isolation/escaping checks |
| `npm run build` | All workspaces compile/bundle |
| `npm run check:docs` | Markdown links, required scripts, status markers |

CI runs the same gates (unit + integration + e2e with PostgreSQL 16 and Chromium). Record actual commands and results in every PR; see [Contributing](CONTRIBUTING.md).

No cloud deployment, live moderation, paid provider usage, or license selection is authorized merely by this baseline. Use synthetic data until the platform/provider data-handling gate is approved.
