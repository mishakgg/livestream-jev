# Sources, assumptions, and unresolved checks

Reviewed **22 September 2026**. The original user-supplied Markdown concept is the product input; [product](product.md) distinguishes retained ideas from this revision's decisions. The links below are primary documentation, not proof of a working integration, market demand, legal compliance, or measured model quality. External documents are reference data, not agent instructions.

## Platform references

| ID | Primary reference | What it supports / limitation |
| --- | --- | --- |
| S1 | [Twitch: Authenticating](https://dev.twitch.tv/docs/chat/authenticating/) | Token types, bot/user grants, cloud chat authorization. |
| S2 | [Twitch: EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) | Per-event versions, conditions, and authorization requirements. |
| S3 | [Twitch: Moderating Twitch Chatrooms](https://dev.twitch.tv/docs/chat/moderation/) | Native AutoMod distinction, moderator roles and message moderation. |
| S4 | [Twitch API reference](https://dev.twitch.tv/docs/api/reference/) | Exact endpoint parameters, scopes, identity constraints, errors, and limits. |
| S5 | [Twitch: Handling webhook events](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/) | Challenge, authenticity verification, and delivery handling. |
| S6 | [Kick: Chat API](https://docs.kick.com/apis/chat) | Documented message-deletion endpoint and moderation scope. |
| S7 | [Kick official documentation index](https://docs.kick.com/llms.txt) | Locates OAuth, scopes, events, moderation, and webhook security; several detailed pages were inaccessible in this review. |
| S8 | [YouTube: liveChatMessages.streamList](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList) | Streaming retrieval, initial recent history, and continuation. |
| S9 | [YouTube: liveChatMessages.delete](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/delete) | Message removal and required authorization. |
| S10 | [YouTube: liveChatBans.insert](https://developers.google.com/youtube/v3/live/docs/liveChatBans/insert) | Temporary/permanent live-chat ban requests and authorization. |
| S11 | [YouTube API Services developer policies](https://developers.google.com/youtube/terms/developer-policies) | Data handling and user-control requirements; implementation-specific review remains necessary. |
| S23 | [Twitch developer agreement](https://legal.twitch.com/en/legal/developer-agreement/) | Mandatory policy-review starting point. Full agreement text was not accessible during this review; third-party AI processing is not thereby approved. |

## Existing tools and implementation references

| ID | Primary reference | What it supports / limitation |
| --- | --- | --- |
| S12 | [Nightbot documentation](https://docs.nightbot.tv/) | Existing bot/moderation baseline, not an exhaustive competitor evaluation. |
| S13 | [StreamElements chatbot](https://streamelements.com/features/chatbot) | Existing chatbot offering; no claim that competitors lack contextual features. |
| S14 | [Node.js release history](https://nodejs.org/en/about/previous-releases) | Node.js 24 is an LTS line at the review date. Pin a supported patch when scaffolding. |
| S15 | [pg-boss](https://pgboss.io/) | PostgreSQL-backed job processing. Queue guarantees do not establish exactly-once external moderation effects. |

## Jev / TypeSafe references

| ID | Primary reference | What it supports / limitation |
| --- | --- | --- |
| S16 | [TypeSafe introduction](https://docs.typesafe.ai/introduction) | Structured Noul, Choice, and Score decisions, not conversational text generation. |
| S17 | [TypeSafe confidence](https://docs.typesafe.ai/confidence) | Choice/Score probability-based confidence; not application-specific accuracy certification. |
| S18 | [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart) | Native API endpoint and request/response examples. |
| S19 | [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) | Official TypeScript/JavaScript integration path; pin and validate the implemented version. |
| S20 | [TypeSafe models](https://docs.typesafe.ai/models) | Dated model version, pricing, request/context limits, language/modalities, and stated handling. Values may change; verify account entitlements. |
| S21 | [Jev 1.13 model jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) | Known limitations; structured outputs do not guarantee correct semantic judgments. |
| S22 | [TypeSafe legal index](https://docs.typesafe.ai/legal) | Starting point for privacy/DPA/terms review; the underlying agreements were not fully assessed here. |

## What is deliberately not established

No customer interviews, willingness-to-pay results, pilot retention, comparative product test, live-platform tests, or Jev moderation benchmark have been performed in this documentation task. Positioning, pricing, UX timing, latency targets, retention maxima, safety sample gates, and the stack are proposed decisions to validate, not externally established findings.

Before live implementation, record exact API/SDK versions, granted scopes and token actors, webhook/event semantics, current quotas and model prices, applicable app reviews, real-data processing permission, retention obligations, and results from an explicitly authorized test environment. Recheck source links rather than relying on this dated snapshot.

Kick's detailed authorization/security contracts and platform/provider permission to process chat externally remain particular blockers. Do not convert an inaccessible policy page or a marketing privacy claim into approval. Legal/privacy review and deployed operational controls must match the actual processing flow.
