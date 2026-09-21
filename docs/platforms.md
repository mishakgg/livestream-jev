# Platform integrations and capability gates

Reviewed 2026-09-22 against the primary references in [sources](sources.md). These are documentation findings and design decisions, not live integrations. Reverify before implementation and record observed behavior from an authorized test channel.

## Cross-platform rules

Official APIs/OAuth only. No scraping, browser automation of moderator tools, copied session cookies, stream keys, or undocumented private endpoints. API availability does not establish permission to send chat to an external AI processor; [SECURITY](../SECURITY.md) defines that launch gate.

An adapter declares receive_messages, observe_deletions, observe_moderation, delete_message, timeout_user, ban_user, reverse_sanction, and native_hold_handling separately. Availability depends on implementation, grant, role, and channel. Unsupported means unavailable, never fake success. Do not show future-platform Connect buttons as working integrations.

Incoming chat events normally arrive after publication. An app inbox is not a native held-message queue. Do not promise pre-publication filtering or restore deleted messages. The initial product does not manipulate AutoMod approvals or native safety settings.

## Twitch: first implementation

### Verified facts

Twitch's EventSub chat subscription contract permits app-token webhook subscriptions using the chat-reading user's `user:read:chat` and `user:bot` grants, plus broadcaster `channel:bot` approval or the required moderator relationship [S1, S2]. Token type and grant identity matter; an app token does not become a user token with moderation powers.

For moderation, `moderator:manage:chat_messages` supports deletion, and `moderator:manage:banned_users` supports timeout/ban operations. The token subject must match the endpoint's moderator identity and be permitted in that broadcaster's channel. Deletion has message-age and protected-author restrictions; always supply the exact `message_id`, because omission can mean clearing chat [S3, S4].

Webhook verification uses the raw body and Twitch's signed delivery metadata. Retries can repeat a delivery, so signature validation and deduplication are separate requirements [S5]. Native AutoMod holds are distinct from already-published messages [S3].

### Chosen authorization design

Production intake uses signed EventSub webhooks and a service-owned Twitch bot identity, provisioned once by the operator. Obtain the bot's chat-read/bot grants and each channel owner's `channel:bot` consent. Do not request chat-write merely to read. A silent bot is acceptable; 'no installation' must not become a false promise that the integration has no bot identity.

Owner onboarding uses Twitch identity to verify the broadcaster ID. Optional team enablement requests the owner's `moderation:read` permission for current moderator-roster verification. A moderator invitation grants no platform role. Match the invited immutable ID and the current platform role before allowing workspace access.

Manual moderation uses that human's own user token, requesting delete and/or ban-management scopes only when needed. Set `moderator_id` from the validated token subject. Guarded auto-delete uses the channel owner's explicit user grant and an owner-approved rule. Never substitute the service bot or owner token for a failed human action. Document the acting identity in UI/audit.

Preview does not require moderation-write scopes and cannot write even if a previously granted token retains them. Runtime capabilities are the intersection of product permission, current grant, platform role, and adapter support. An OAuth grant may be broader than an app action toggle; explain both, and request the narrowest available scope.

### Required intake/action tests

Verify subscription challenge, signature/replay rejection, revoke notification, duplicate and out-of-order delivery, quiet/offline channels, resubscription, token expiry/refresh, wrong broadcaster/subject, moderator removal, missing scope, message already deleted, stale message, protected targets, 429, and ambiguous post-submission failure. Never fall back to a full-chat clear when an ID is missing.

Use targeted native deletion/clear and authorized moderation events to suppress stale proposals. Subscribe only to needed events and document each event version and required scopes. Full moderator history, account age, ban-evasion identity, IP/device signals, and bot settings are not assumed available from a chat event. Display unknown where absent; enrich only from permitted endpoints with a demonstrated need and budget.

The operator must confirm callback TLS/public reachability, app/client ownership, bot provisioning, quotas/subscription capacity, and applicable reviews. Do not design capacity around obtaining a special verification or limit increase that has not been granted.

## YouTube: later adapter

The official `liveChatMessages.streamList` provides a server-streaming feed with a continuation token for reconnection; it includes initial recent history rather than an unlimited archive [S8]. Separate historical intake from fresh moderation eligibility.

Message deletion and temporary/permanent live-chat bans are documented APIs, with OAuth and role requirements [S9, S10]. Select the correct live broadcast/liveChatId and handle ended/disabled chat, history bounds, reconnection, quota exhaustion, and token refresh. If a polling fallback is introduced, respect the API's supplied polling interval.

Before enabling: validate the chosen transport/client, exact scopes and moderator/owner behavior, project quotas and any OAuth verification, action semantics, and YouTube data retention/deletion/user-control policies [S11]. Broad OAuth scopes must not be described as granular permissions. No assumption of Twitch-equivalent events, private-history access, or guard automation policy approval.

## Kick: later adapter

The official Chat API documents `DELETE /public/v1/chat/{message_id}` with `moderation:chat_message:manage` [S6]. The official index also lists OAuth, scopes, moderation, event subscriptions, and webhook-security documentation [S7]. Some detailed pages were inaccessible during this review: ban/unban semantics, exact webhook verification, event replay behavior, and current limits remain implementation verification items, not certified contracts.

The supplied concept proposes `events:subscribe`, `chat.message.sent`, and `moderation:ban`. Preserve them as candidates to verify against accessible current docs/OpenAPI and an authorized test, not assumptions to hard-code. Validate signing keys, raw-byte signature algorithm, replay/freshness policy, message/channel binding, role/grant semantics, delete/timeout/ban behavior, and reconciliation before advertising support.

## Exit gate for any live adapter

Create a dated capability matrix with endpoint/event version, scope, token subject, required channel role, limits, error semantics, and tested evidence. Link the approved data-use review and operator setup steps. A mocked contract test alone does not satisfy live verification. Where access is unavailable, keep the adapter disabled and report the exact prerequisite.
