# Contributing

Read [AGENTS.md](AGENTS.md) and the [roadmap](docs/roadmap.md). This is a private planning baseline; no open-source license has been selected. Do not add one without the owner's approval.

Use a scoped branch and PR. Explain the user problem, affected contract, and acceptance evidence. Review current main and open PRs first. Avoid unrelated formatting, dependency upgrades, deployment changes, and speculative abstractions.

Each implementation PR must include:

1. Base SHA and milestone; what changed and what explicitly did not.
2. Reproduction or acceptance scenario and automated tests, including failure/race cases.
3. Database/configuration changes and rollback or forward-fix procedure.
4. Actual verification commands/results, screenshots when captured, and limitations.
5. Updated setup, status, and contract documentation.

Use synthetic chat in tests. Keep serious-threat, private-information, and abuse examples fictional and minimally necessary. Do not paste real streamer chat, credentials, or personal information into issues.

Document new external facts in [sources](docs/sources.md), with a review date and primary reference. Keep product decisions and targets separate from demonstrated results. Security issues follow [SECURITY.md](SECURITY.md), not public reproduction posts.
