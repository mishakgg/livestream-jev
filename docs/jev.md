# Jev integration and evaluation contract

Jev is the requested decision-model direction. Keep it replaceable behind a narrow classifier interface without changing policy or UI. No provider call has been made for this repository.

## What is verified

TypeSafe documents Jev as a structured evaluator with Choice, Score, and Noul questions, rather than a free-form text generator. Questions in a request evaluate the supplied state independently [S16]. Choice/Score include probability distributions and a derived confidence value; Noul provides a 0–1 value without that confidence field [S17].

The documented endpoint is `POST https://api.typesafe.ai/v1/systemone`; the official JavaScript package is `@typesafe-ai/sdk` [S18, S19]. Check the pinned SDK's actual interfaces instead of inventing OpenAI-compatible chat/completions parameters.

The model page reviewed on 2026-09-22 lists `jev-1.13.0`, text/structured-text input, US$0.042 per million input tokens, 1,200 requests/minute, and 250,000 tokens/second. It warns that limits may change. It describes 64k total request and 32k state-plus-longest-question limits, and stronger English performance [S20]. These are provider documentation figures, not account entitlements or application benchmarks.

Use a versioned production model ID and record the resolved response version; do not silently move moderation thresholds with a `latest` alias. Read the provider's known-limitation guidance for literal interpretation, counting, large context, adversarial input, and generation [S21]. No type-safety claim eliminates classification errors or prompt-injection risk.

## Adapter boundary

Proposed internal interface: `evaluate(boundedContext, abortSignal) -> ValidEvaluation | Abstention | ProviderFailure`. This is an application contract, not an SDK signature. Only the adapter knows provider request/response syntax.

The caller supplies owner-approved policy context, the selected messages as untrusted evidence, exact candidate IDs, code-computed counts and time relationships, explicit missing-context flags, and narrow questions. Do not include secrets, whole-channel history, irrelevant personal data, or previous model labels as established truth. Redact private identifiers before external processing where possible.

Ask atomic questions such as whether the selected text solicits an off-platform payment, directs repeated personal attacks at the explicitly identified viewer, or reports an audio problem. Do not ask 'Who should we ban?' or make one question depend on another answer from the same parallel request. Count users, compare times, determine actions, and resolve permissions in code.

If a model selects evidence/target IDs, constrain it to supplied candidates and independently validate membership and relevance. A selected ID is still a fallible inference, not authority. For the first slice, deterministic context selection and template explanations are sufficient.

## Output and explanation

Validate keys, question types, allowed values, numeric ranges, distributions, model version, and response completeness at runtime. Missing/invalid/contradictory answers and unresolved targets cause abstention. Never turn a provider timeout into a safe/ordinary label.

Human-facing explanations are templates based on verified facts and rule IDs: 'Repeated near-identical promotion from 6 observed accounts; review the linked messages.' They are not a claim to expose the model's reasoning. Do not ask Jev to write policy prose, summaries, or conversational answers. Counts and report totals are always computed.

A future evidence assistant needs a separately evaluated generative provider or deterministic search UI. It stays read-only, returns evidence references, respects tenant/retention boundaries, and cannot execute moderation from natural-language instructions.

## Resilience and cost

Bound input size, queue time, concurrent requests, total deadline, and spend. Initial test deadline: 1.5 seconds for the complete classifier operation, including any retry; no unbounded SDK/application retry multiplication. Honor rate-limit headers, use jitter and a circuit breaker, and label degraded coverage. The webhook handler never waits for this work.

The documented 1,200 requests/minute is approximately 20 requests/second sustained, by arithmetic. That can bind long before token cost for a busy multi-channel service. Use global and per-channel admission, selective analysis, and compact context. Do not split provider accounts to evade limits. Batching requires per-message result binding and latency/isolation tests, not merely combining unrelated chat into one state.

Cost model: `evaluated requests × mean billed input tokens/request × price per input token`, plus infrastructure, storage, operations, and support. Measure actual usage and question overhead; do not extrapolate from message text alone. Provider rates are configuration with a review date, never permanent pricing assumptions.

## Quality and release

Use [testing](testing.md): held-out incident-level examples, channel-separated splits, benign banter, quoted abuse, adversarial instructions, language variation, and sampled unflagged messages. Human actions and model-generated labels are not ground truth by default. Do not translate languages silently and assume equivalent accuracy.

Track precision/recall, calibration, abstention, coverage, latency, and cost by category/language/policy/model. The MVP has no approved AI-only auto-enforcement thresholds. A model/criteria change reruns evaluations and Preview before promotion. No online self-training or cross-channel feedback sharing.

Configuration to create during implementation: fake versus Jev provider, required API key in live mode, pinned model, deadline, concurrency, request/token budgets, and feature flags. Fake mode must be explicit and impossible to mistake for a real result. Real-chat processing remains blocked pending [security review](../SECURITY.md), even when an API key exists.
