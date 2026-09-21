# Moderation policy and authority

This contract is mandatory for every adapter and UI. It is a proposed implementation specification, not evidence of model reliability.

## Policy owns actions

A model never returns an executable action. It returns bounded signals about supplied evidence. Code maps them to ignore/review/escalate or an eligible deterministic auto-delete rule. A human may approve an exact action in Assist/Guarded subject to their current permissions.

A policy version contains: category review sensitivity, allowed contextual language, approved blocked domains, deterministic repetition criteria, permitted human actions/durations, mode, per-rule automation enablement, per-channel rate caps, and owner-approved optional nuance. Free text cannot create a new action, duration, scope, URL, or permission. No 'strict' preset silently enables automation.

## MVP category behavior

| Category | Default | Guarded allowance |
| --- | --- | --- |
| Repeated exact/normalized spam | Group and review | Specific-message auto-delete only under tested deterministic criteria |
| Owner-confirmed blocked domain | Review with extracted domain | Specific-message auto-delete for an explicitly approved exact-domain rule |
| AI-suspected scam or malicious link | Review/escalate | No automatic enforcement based solely on AI or an unreviewed list |
| Targeted harassment | Contextual review | Human delete/timeout/ban only |
| Possible private information | Mask and escalate urgently | Human action only; no guarantee of prevention |
| Spoilers / unsolicited hints | Deferred beta, review | No MVP automatic enforcement |
| Ordinary banter, disagreement, criticism | Usually no incident unless another supported issue exists | Never punish merely for negative sentiment |
| Stream audio/video reports | Separate operational card | No moderation action |

Automatic rule matches are not proof that every participant in a grouped incident violated a rule. Recheck each exact message target. Subscriber/VIP status is not an automatic bypass; broadcaster/moderator/service identities are protected from automatic actions and platform-prohibited targets are rejected. Unknown identity/role means review, not escalation of punishment.

## Dispatch checklist

All must hold immediately before a real request:

1. Live-origin evidence, active workspace, connected channel, valid authority generation, no global/channel write-disable.
2. Mode permits the action: Preview never writes; Assist requires current human approval; Guarded auto-delete requires the exact enabled deterministic rule.
3. Authenticated actor still belongs to the workspace; manual actor is still an authorized platform moderator/owner. The selected token's subject, scopes, and target channel match the endpoint contract.
4. Policy and evidence versions are current. The target message/user exists in scoped records; action parameters equal the approved parameters. No unresolved target inferred from a display name.
5. Evidence is fresh, no conflicting native/human action has superseded it, and platform action restrictions are satisfied.
6. The action ledger has no conflicting in-flight/unknown operation, current rate/budget limits permit dispatch, and the expiry deadline has not passed.

A failure yields an explicit refusal, expiry, supersession, or review state. Never compensate by using a broader token, different channel, stronger punishment, or quieter failure message.

Initial engineering defaults to test: automatic candidates expire 15 seconds after provider event time; human approvals expire after 120 seconds and must be refreshed against current evidence; automatic deletion is capped at 10 messages/minute/channel and a cap hit pauses that rule and alerts moderators. These values are conservative starting limits, not validated optimal settings. Platform limits always apply independently. Clock uncertainty or missing event times prevent automation.

## Human workflow and reversal

Humans choose specific delete, an explicit timeout duration (initial UI presets 60 seconds and 10 minutes), or individually confirmed permanent ban. No bulk bans or automatic timeout escalation in the MVP. Native API permissions remain necessary even when the creator authorizes the product feature.

Feedback changes future proposals only after a reviewed policy/evaluation update. A human dismissal suppresses the same unchanged proposal; material new evidence can reopen it with explanation. Do not undo a human unban or timeout cancellation because old evidence replays.

Pause is a server-authority fence for new automated submissions, not a browser flag. Already-submitting requests remain visible. Disconnect fences all actions and processing. Unknown network outcomes are reconciled; repeated timeouts must not extend an already-applied penalty. Removing a timeout or ban is a new authorized action, never a promise to restore deleted messages.

## Calibration and safety

High model probability alone is insufficient authorization. Thresholds depend on the category, language, channel policy, model version, and held-out evaluation. Do not write '0.95 means 95% correct' without empirical calibration. No production AI-only enforcement threshold is approved in this baseline.

Platform-native protections stay active. Never auto-approve held AutoMod messages, change native moderation settings, or learn a new allowed behavior from an attacker's repeated messages. Unsupported language, ambiguous sarcasm, missing conversation, or a provider failure stays unclassified/reviewable with clear coverage, not confidently safe.
