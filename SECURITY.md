# Security, privacy, and responsible operation

Planning requirements, not a compliance certification. No real-channel pilot until the applicable gates below are satisfied. See [platforms](docs/platforms.md), [policy](docs/policy.md), and [tests](docs/testing.md).

## Reporting

Do not publish tokens, raw private evidence, or exploit details. Use GitHub private vulnerability reporting if the repository has it enabled; otherwise contact the repository owner through an existing private channel. No dedicated security email or response SLA has been established. Establish both before public launch.

## Trust and access

The service handles viewer speech and credentials capable of deleting messages and banning people. Treat a compromised moderator account, malicious viewer, cross-tenant request, forged webhook, stale permission, malicious URL, poisoned history, and compromised AI response as explicit threats.

Use server-side OAuth authorization-code flows; validate single-use state and exact redirect allowlists; use PKCE where the provider supports it. Never request platform passwords or stream keys. Protect mutations with authenticated sessions and CSRF/origin checks. Cookies must be Secure, HttpOnly, appropriately SameSite, rotated, and revocable. No platform or AI tokens in browser storage.

Encrypt tokens using authenticated encryption with managed key custody in production; separate key material from the database, support rotation, and redact all secrets. A production configuration must fail startup rather than use demo encryption keys, development identities, or bypass flags. Grant and refresh credentials per principal; serialize refreshes and handle revocation.

Every read, event stream, mutation, export, background job, and cache key is workspace/channel scoped. Scope comes from authenticated membership and verified subscriptions, not request bodies. Invitations are single-use, short-lived, and bound to the intended immutable platform user ID. MVP roles are Owner and Moderator; owner approval plus current Twitch moderator status is required for a moderator's access. Revocation closes active sessions/streams and blocks queued work.

Signed webhooks are verified against raw bytes before parsing. Reject mismatched channel/subscription bindings and enforce replay checks. Escape chat as text; do not render raw HTML, fetch viewer-supplied URLs, create link previews, or remotely load arbitrary images. No model-generated SQL or executable tools. Use explicit bounded queries and fixed egress destinations. Retain original evidence separately from normalized matching text.

## Privacy defaults to implement

These are proposed maximum product defaults, subject to stricter platform terms and legal review:

| Data | Proposed retention / behavior |
| --- | --- |
| Ordinary chat text and surrounding context | 24 hours |
| Minimal evidence selected for an incident | Up to 7 days, no whole-channel archive |
| Action/audit metadata | Up to 30 days, no raw chat; identifiers still treated as personal data |
| OAuth tokens | Only while authorized; revoke/delete on disconnect where supported |
| Operational logs | Up to 14 days; structured, without message bodies or credentials |
| Backups | Bounded 30-day window; encrypted; restore must reapply deletion tombstones |

Offer shorter retention; zero/short-lived raw retention must still have an honest reduced-history experience. Disconnect immediately stops new intake/AI processing/writes and invalidates queued work. Provide a separate, clear Delete my workspace data operation; target active-store deletion within 24 hours and disclose bounded backup expiry. Scheduled deletion must cover job payloads, caches, search indexes, exports, and incident copies, not only the chat table. Never claim total immediate erasure while backups remain.

Do not retain or redistribute third-party deleted content by default. Apply platform deletion/clear signals to stored text and evidence unless an explicitly reviewed platform-permitted exception exists. Retain a content-free tombstone for reconciliation. Display 'Evidence removed or expired', not a reconstructed quotation.

Doxxing candidates are masked on cards, notifications, and the creator view. Authorized moderators may deliberately reveal minimal evidence, with an audit record. Do not send exact addresses/contact details to a provider merely to detect that private information may be present: redact deterministic identifiers and preserve only the context needed. No viewer profiling across channels, inferred sensitive traits, public suspect lists, or training on customer chat.

## External processing and launch blockers

Before sending any real chat to TypeSafe or another processor, the owner must approve documented platform data-use compatibility, provider processing terms, retention, subprocessors, geographic processing, and required notices/consent or other applicable basis. OAuth permission alone does not establish these rights. No promise of zero provider retention without an applicable agreement.

Publish a real privacy notice, terms, contact/deletion process, and subprocessor disclosure before a real-user pilot. Verify platform app registration, quotas, required reviews, and operational ownership. Check the provider agreement and platform developer terms; unresolved or inaccessible terms remain blockers. YouTube has additional developer-policy obligations [S11 in sources](docs/sources.md).

Review accessibility, credential rotation, backup restore, deletion drills, incident response, dependency risks, and abuse reports before public release. Provide a global operational write-disable as well as channel-level pause. Production support access to evidence must be least-privilege and audited.
