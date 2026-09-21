# Positioning and validation plan

All segment sizes, prices, conversion criteria, and targets here are hypotheses. No interviews, customers, competitor testing, revenue, or willingness-to-pay evidence has been collected for this repository.

## Positioning

**For streamers and moderator teams whose chat moves faster than they can review, Livestream Copilot groups the important problems, brings the evidence together, and keeps humans in control.**

Lead with a visible result: a flood of related spam becomes one reviewable incident; two moderators do not perform duplicate work; repeated personal targeting has context. Do not lead with model speed, token prices, 'fully autonomous moderation', or unsupported claims that all other bots lack AI.

Twitch already offers AutoMod and moderator tooling; Nightbot documents automated moderation and StreamElements offers a chatbot [S3, S12, S13 in sources](sources.md). The proposed differentiation is the incident/evidence/team workflow. Whether it is sufficiently better to buy must be tested, not asserted as an empty market.

## Initial customer and packaging

Recruit creators with a repeated moderation problem and their lead moderators together. A moderator can try the synthetic demo and recommend it without granting channel authority. The owner connects the real channel. Do not charge per moderator seat: that discourages the teamwork the product should improve.

Initial offer: one Twitch channel, its moderator team, incident inbox, evidence, preview review, creator issue view, and transparent usage limits. Start with one simple paid channel plan after the pilot; defer elaborate tiers and annual commitments.

Test a **US$19/channel/month** founding-plan offer as a pricing hypothesis. A **US$39** higher-usage offer is a later test only if cost/usage warrants it. These are not published prices or approved billing configuration. No checkout, paid subscriptions, or payment-provider integration is in M0–M3.

Measure retained bytes, worker usage, provider input tokens/requests, burst handling, payment fees, support time, and moderation review burden before setting quotas. Do not promise unlimited chat because model tokens look cheap. A raid should not cause a surprise bill or silently remove core controls: display degraded AI coverage, retain manual controls/native tools, and apply the agreed fair-use policy without automatic overage charges.

## Validation before a broad launch

A short discovery cycle is intended to prevent building for months without evidence. Proposed recruitment: 8–12 creator/moderator teams with distinct moderation styles. Ask about the last difficult stream, current workaround, duplicate actions, false positives, and setup tolerance. Obtain explicit permission before recording sessions or retaining examples.

Demo a synthetic 60–90 second scenario: noisy chat, grouped incident, evidence, a second moderator opening it, safe action status, and a creator audio-report card. Show normal banter being left alone. Then test a real read-only pilot only after the security/data gates.

Suggested decision criteria, to revise openly before the experiment: at least five teams complete the demo; at least three voluntarily return for multiple streams; at least three agree to the paid offer; and observed review time improves without a worse serious false-positive pattern. Small samples are directional, not market-size proof. Record withdrawals and 'I already get this from my current tools' as valuable failures.

Pilot metrics: setup completion, first useful incident, useful-incident share, review time versus the team's baseline, missed serious incidents from sampled unflagged chat, repeated use, trust/comfort, false-positive appeals, per-stream cost, and explicit willingness to pay. Do not infer a purchase from a compliment or infer safety from a low alert count.

## Acquisition experiments

Create a short evidence-first demo and a public page that honestly labels Preview and planned features. Recruit through individually relevant creator business contacts and moderator communities where product research is allowed. Seek permission for a workflow walkthrough rather than posting promotional chat messages during streams. No bulk scraping, spam DMs, bought followers, or platform-evasion growth tactics.

Use real pilot quotes or anonymized before/after examples only with permission. 'Works alongside your current tools' is a workflow promise to test, not a claim of built integrations with every named vendor. Story Mode can become a second demo hook only after its limitations are clear and beta evidence supports it.

If teams do not return, fix inbox usefulness and setup friction before adding Kick, YouTube, an assistant, or billing. Continue with the narrower recurring pain demonstrated by the pilot, not feature count.
