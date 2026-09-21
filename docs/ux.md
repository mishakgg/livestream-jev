# User experience contract

The default screen is a useful inbox. No prompt engineering, model picker, numerical confidence setup, or sprawling analytics dashboard is required. Design requirements below are not implemented UI.

## First session

1. Landing: 'Keep up with chat without handing it over to a ban bot.' Explain human control, Twitch-first availability, and no installation. Primary CTA: **Try the demo**; secondary: **Connect Twitch**. Demo uses labeled fictional chat and no OAuth.
2. Connect: explain exactly what will be read and that Preview cannot moderate. Verify channel ownership and show the selected channel visibly. Refused scopes, wrong accounts, revoked tokens, offline channels, and an unreachable callback have specific recovery states.
3. Preferences: Balanced/Banter-friendly/Strict, optional bounded nuance, and optional moderator invitation. All start in Preview. Present the effective policy in normal language before saving.
4. Workspace: show connection health immediately; do not call an offline channel broken. 'Connected; waiting for messages' differs from 'No incidents' and 'Not receiving events'. Show synthetic replay as a distinct alternative, never mixed into real history.
5. After observed usage: show reviewed examples, disagreements, insufficient evidence, and coverage. The owner may enable Assist and grant the permissions needed for a chosen action. Guarded requires its separate safety gate and a per-rule confirmation.

Target for testing: a first useful demo incident in under 60 seconds, and owner setup in under five minutes excluding platform delays. These are targets, not promises. Public marketing must wait for measurement.

## Moderator workspace

Desktop: compact channel/status header; prioritized incident list; stable detail panel. A creator-view toggle and review/history are secondary navigation. Mobile: list and details become separate screens with a reliable Back action; no horizontal dependence.

A card shows severity, category, concise evidence-derived summary, first/last observed time, distinct-account/message counts, owner/claim status, and resolution/action state. Use 'Possible coordinated spam' rather than asserting a botnet. Counts come from code. Never duplicate private information or spoilers into notification text.

Sorting is severity then recency, with deduplication. Selecting or focusing an incident freezes its position; newly arriving cards do not move controls under the cursor. New high-priority work gets a bounded announcement. Let moderators pause live list movement without pausing backend protection. Grouping uses a fixed explainable window and allows split/merge correction later; do not put unrelated viewers together because their language or mood is similar.

Details show original message text, bounded chronological context, reply relationships, channel rule, observed pattern, known native actions, and plain-language uncertainty. Distinguish 'No prior action observed since connection' from 'Never warned'. Show provider/evaluation details only in an expandable diagnostic view. Context can be incomplete or expired.

Actions: dismiss as acceptable, mark uncertain, claim/release, resolve with a reason, delete the specific message, timeout with explicit duration, or ban with an extra confirmation. Avoid one-button permanent bans. The UI names the exact user and channel; text changes cannot silently retarget an action. Missing permission presents **Enable this action** or **Open native moderation**, not a generic failure.

Two moderators acting simultaneously must converge on one durable operation or a clear conflict. A claimed case is a collaboration aid, not a replacement for server concurrency control. Display 'Handled by another moderator' and update in place. Do not immediately remove a card in a way that makes the next accidental click act on someone else.

## Action feedback and control

Use explicit states: proposed, awaiting approval, queued, submitting, platform confirmed, handled elsewhere, outcome unknown, refused, expired, or cancelled before submission. A button click is not success. On disconnect or refresh, recover the existing operation ID; do not submit again automatically.

Deletion is not undoable by restoring a public message. Where supported, offer separately authorized 'End timeout' or 'Unban' after showing the current state and warning that this does not restore deleted chat. No generic Undo toast that promises otherwise.

An always-visible Guarded indicator lists active auto-delete rules. Pause is one action with acknowledgement from the server. Distinguish automation paused, all platform writes disabled, and disconnected. Explain any already-in-flight requests honestly.

## Creator view

Show at most a few high-value, masked cards: unresolved severe incident requiring the owner, a chat-reported stream problem, and service health. The creator should not have to read harassment to continue streaming. Sound is off by default; optional notifications are rate-limited.

A technical-issue card says '6 distinct accounts reported audio problems in the last 2 minutes' only when those counts were actually observed. Allow acknowledge, snooze, and dismiss; do not assert that the microphone is broken. Repeated reports by one account do not become six viewers. Keep technical complaints out of toxicity enforcement.

Post-stream review summarizes observed incidents, actions, disagreements, coverage gaps, and elapsed handling time. No invented 'hours saved' or AI-generated praise. A quiet stream can accurately show no incidents.

## Accessibility, privacy, and resilience

Dark-first visual design with a usable light theme; semantic HTML; keyboard navigation; visible focus; accessible labels; severity conveyed beyond color; reduced-motion support; readable contrast and long names. Shortcuts are optional, documented, and inactive while typing. Destructive shortcuts require confirmation. Dialogs trap and restore focus appropriately.

Test at 1440px and 390px, 200% zoom, long text, narrow height, keyboard-only operation, and screen-reader announcements. Do not auto-scroll details away from what the moderator is reading. Bound rendered history and clean up event streams/listeners on navigation.

Required states: loading, empty, offline, reconnecting, partial history, AI unavailable, queue behind, permission revoked, quota exhausted, data expired, operation unknown, and read-only demo. Explain a next safe action for each. A green badge requires actual health evidence, not merely a successful page load.
