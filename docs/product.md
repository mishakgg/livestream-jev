# Product specification

**Revision:** 2026-09-22. Proposed product direction; implementation status is in [README](../README.md). Platform facts are separated in [platforms](platforms.md); commercial assumptions in [go to market](go-to-market.md).

## Revised product description

Livestream Copilot helps a streamer and a small moderator team keep up with a busy chat without handing their community over to a ban bot.

Connect Twitch, choose a few community preferences, and start in Preview. The service runs in the cloud while the streamer broadcasts normally. No desktop software, extension, OBS integration, video upload, or local AI model is required. The first useful experience is a moderator inbox, not a configuration panel or an empty AI chat box.

Related messages become one incident: a repeated scam campaign, a viewer being targeted, or a possible disclosure of private information. Each incident shows the relevant messages, the observed pattern, the channel rule, uncertainty, and what has already been done. Moderators can claim it, dismiss it, or take an authorized action without repeatedly searching chat or stepping on another moderator's work.

Creators remain in control. Preview makes no changes on Twitch. Assist lets authorized humans act. Guarded mode adds only explicitly enabled, narrowly defined automatic message deletion after validation. Timeouts and permanent bans require human approval in the MVP. A visible pause stops new automatic dispatch, and every action has an honest result and audit trail.

The product complements native moderation and existing bots. It does not promise to intercept every message before publication, eliminate every spoiler, identify the people behind accounts, or understand a channel perfectly. It helps humans notice meaningful problems sooner, process repetitive work with less effort, and see when coverage is limited.

A compact creator view can also report repeated chat concerns such as 'Several distinct viewers report an audio problem.' These are reports from chat, not verified measurements of the broadcast. Stream-health signals are kept separate from abuse alerts and never punish viewers for giving negative feedback.

## Audience and job to be done

Primary pilot audience: Twitch streamers whose chat sometimes outruns a small human moderator team, and the lead moderators who select their tools. Select by moderation pain and message rate, not an assumed follower-count threshold. A channel with no meaningful moderation workload may not need a paid product.

The streamer buys confidence, low setup effort, and a calmer broadcast. The moderator uses evidence, prioritization, collaboration, and reliable controls. Do not optimize the product solely for the person who pays while making volunteer moderators' work harder.

Primary job: **'When chat gets busy, show my team what actually needs attention, why, and what has already been handled.'** Secondary job: 'Tell me when chat is repeatedly reporting a stream problem without making me read every message.'

## Product principles

1. An incident inbox, not another full chat firehose. Keep routine chatter out of the default view, but allow bounded context and ordinary chat inspection.
2. Earn trust before automation. Prefer an honest uncertainty label to a confident wrong ban.
3. Explain with evidence and plain language. Do not expose raw confidence sliders or AI terminology during normal onboarding.
4. Work alongside existing tools. Observe only events and settings that are actually available and authorized; do not claim automatic import or control of every bot.
5. Show coverage. Disconnected, behind, AI-unavailable, partially analyzed, and platform-write-disabled are different conditions.
6. Preserve channel culture without granting permission for harassment or ignoring platform rules. Badges, subscriptions, popularity, or donations do not establish innocence.

## MVP scope

| Capability | Initial useful behavior |
| --- | --- |
| Connection | One Twitch channel per workspace; owner identity verified; service health and revoke controls |
| Onboarding | Credential-free demo, Preview by default, three clear community presets plus optional nuances |
| Incident inbox | Grouped spam/scam candidates, targeted-harassment candidates, masked private-information alerts |
| Context | Bounded nearby/reply messages, observed channel-local history, exact evidence references, known prior actions |
| Collaboration | Owner and invited verified moderators, claim/release, resolution notes, concurrent-action protection |
| Human actions | Specific-message delete, bounded timeout, individually confirmed ban, dismiss/resolve; capability gated |
| Automation | Later MVP gate: only approved deterministic repeat-spam and owner-confirmed blocked-domain message deletion |
| Feedback | Correct/incorrect/uncertain plus reason; feedback does not silently rewrite policy or retrain anything |
| Creator value | Separate, optional chat-reported audio/video issue cards and a factual post-stream summary |
| Trust controls | Pause automation, disconnect, retention controls, audit history, clear limited-coverage states |

M0 is a synthetic vertical slice; M1 is real Preview; M2 is the human-action pilot; M3 is narrow Guarded automation. Do not implement the entire table in the first PR.

## Simple channel policy

Presets: Balanced, Banter-friendly, and Strict. All start with no automatic enforcement. They primarily change review sensitivity and permitted-language context, not platform settings or authority.

Optional text: 'Swearing and jokes about me are fine; repeated personal attacks on viewers are not.' Store this as bounded owner-approved context. Structured controls remain the source of truth for allowed actions, timeout lengths, domains, and category behavior. A preview summarizes the effective policy before the owner saves a version. Conflicting or unrepresentable text is flagged, not silently converted into enforcement.

## Modes and session controls

- **Preview** (the original Shadow concept): observes, prioritizes, and supports feedback; no platform writes at all. Compare recommendations with observed human actions only where data exists.
- **Assist** (Copilot): manual, explicit human approval for platform actions; automatic enforcement off.
- **Guarded**: Assist plus approved deterministic auto-delete rules. No automatic timeouts or bans in the MVP.

'Pause automation' is available in Guarded and leaves authorized manual actions available. 'Disconnect' stops all intake and dispatch. Neither can retract a request already accepted by Twitch. Do not call any mode Autopilot or imply that the stream can safely be left unattended.

## Story Mode and future extensions

Story Mode is a differentiated beta after the core pilot. The creator explicitly sets the game, progress, and policy ('no story spoilers', 'no unsolicited hints', or 'hints allowed'). Uncertain progress means uncertain detection. Default to review; conceal spoiler text from creator-facing cards. Deletion after receipt cannot guarantee no one saw it. No game-state transcription or vision in the MVP.

Kick and YouTube are later adapters with independent authorization, testing, and data-policy gates. Multistreaming must not merge viewer identities or claim equal capabilities across platforms. The later conversational assistant is read-only evidence retrieval, with citations and missing-history warnings; it cannot ban by conversation. A separate generative model would be required for free-form replies.

Defer: all-platform launch, autonomous bans, bulk punishment, automatic native Shield Mode/settings changes, video/audio ingestion, overlays/plugins, general chatbot replies, giveaways, monetization analytics, global suspect databases, and an all-purpose community-management suite.

## Changes to the supplied concept

| Supplied direction | Revision and rationale |
| --- | --- |
| Three platform connect buttons | Twitch first; future platforms clearly unavailable until implemented and authorized |
| Contextual intelligence above existing tools | Retained, with capability-based signals rather than assumed universal integrations |
| Moderator priority inbox and grouped incidents | Promoted to the primary product and demo rather than one feature among many |
| Shadow, Copilot, Guarded, Autopilot | Three understandable modes; no Autopilot promise; Preview is technically write-disabled |
| AI translating arbitrary channel instructions | Bounded natural-language context plus explicit structured rules and approval |
| High-confidence automated timeouts/spoiler hiding | Human timeouts in MVP; spoiler beta with post-publication limitations |
| User history and coordinated accounts | Only observed/permitted channel history; 'related pattern' is not proof of shared control |
| Conversational Jev assistant | Deferred; Jev classifies, it does not generate free-form answers |
| Community intelligence | Retained as a small opt-in stream-issue view, not broad sentiment surveillance |
| No visible bot necessary | No chat announcements required, but the chosen Twitch cloud intake uses a service-owned bot account |

## Success and non-success

Measure incident precision/recall, moderator handling time, duplicate work, appeal/overturn outcomes, repeat usage, trust, and sustainable cost. Do not optimize bans issued, messages deleted, alerts created, or time spent in the dashboard. See [testing](testing.md) for quality gates and [go to market](go-to-market.md) for validation hypotheses.
