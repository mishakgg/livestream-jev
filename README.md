# Livestream Copilot

**Keep the chat moving. Put the right problems in front of the right moderator.**

Working product name for `livestream-jev`. Jev is the TypeSafe AI decision model used by the proposed service, not our own model or an affiliation claim. Final commercial naming is undecided.

## Status

**Planning baseline — 22 September 2026.** This repository currently contains product and engineering specifications, not a running application. No platform connection, AI accuracy, latency, customer adoption, deployment, or billing capability has been demonstrated. Numeric targets below are acceptance targets or commercial hypotheses, never measured results.

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
| [Contributing](CONTRIBUTING.md) | Change and verification workflow |

## Implementation direction

TypeScript throughout; Node.js 24 LTS; npm workspaces; React/Vite web client; Fastify API; a separate worker from the same codebase; PostgreSQL and pg-boss. Share runtime-validated contracts. Keep the classifier behind a narrow provider interface. Start with deterministic synthetic replay and no credentials.

The first implementation milestone is **M0 in the roadmap**, not the whole vision: a working, persisted replay-to-incident-to-simulated-action slice with a usable dashboard and safety tests. The next milestone introduces real Twitch intake in Preview.

## Development

There is no package manifest or executable setup command yet. The first coding agent must add the scaffold, lockfile, migrations, local configuration, test commands, and accurate quick-start instructions. Do not present planned commands as runnable until they exist.

No cloud deployment, live moderation, paid provider usage, or license selection is authorized merely by this planning baseline. Use synthetic data until the platform/provider data-handling gate is approved.
