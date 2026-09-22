import type { PoolClient } from "pg";
import { emitUpdate, recordAudit } from "@livestream/db";
import type { PolicyPreset, SignalCategory } from "@livestream/contracts";
import {
  GROUP_WINDOW_MS,
  checkDispatch,
  evaluatePolicy,
  groupKey,
  requestHash,
  severityFor,
  type DispatchState,
} from "@livestream/domain";
import { FAKE_MODEL_VERSION, FAKE_PROVIDER, fakeEvaluate } from "@livestream/classifier";
import { SimulationExecutor } from "@livestream/platforms";

// ---------------------------------------------------------------------------
// Domain pipeline: durable intake -> bounded context -> fake classification ->
// incident grouping -> policy evaluation -> persisted updates. Later adapters
// (Twitch) feed this same pipeline; only the executor differs.
// ---------------------------------------------------------------------------

const GROUPABLE: ReadonlySet<SignalCategory> = new Set([
  "spam",
  "scam_suspected",
  "targeted_harassment",
  "spoiler_suspected",
  "stream_issue_report",
]);

const TITLES: Record<string, string> = {
  spam: "Possible coordinated spam",
  scam_suspected: "Suspected scam pattern",
  targeted_harassment: "Possible targeted hostility",
  private_information_suspected: "Possible private-information disclosure",
  spoiler_suspected: "Suspected spoiler",
  stream_issue_report: "Chat-reported stream problem",
};

function summarize(
  category: SignalCategory,
  messageCount: number,
  accountCount: number
): string {
  switch (category) {
    case "spam":
      return `Repeated near-identical promotion from ${accountCount} observed account(s) across ${messageCount} message(s); review the linked messages. Coordination is not proven.`;
    case "scam_suspected":
      return `Messages matching a scam template from ${accountCount} observed account(s); verify before anyone clicks.`;
    case "targeted_harassment":
      return `${messageCount} message(s) directed at one viewer; check context for consent, reciprocity, and whether the target asked it to stop.`;
    case "private_information_suspected":
      return `A message matches a private-information pattern. Evidence is masked; confirm from the masked evidence before acting.`;
    case "spoiler_suspected":
      return `A message matches a spoiler template. Uncertain without verified game progress.`;
    case "stream_issue_report":
      return `${accountCount} distinct account(s) reported an audio/video problem. Reports only — not a verified diagnosis.`;
    default:
      return "";
  }
}

interface ChatEventRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  platform_message_id: string;
  kind: string;
  author_id: string;
  author_name: string;
  original_text: string;
  normalized_text: string;
  reply_to_message_id: string | null;
  provider_time: Date;
  processed_time: Date | null;
}

/** Resolve an @mention to a recent author id (bounded, fallible inference). */
async function resolveMention(
  client: PoolClient,
  workspaceId: string,
  text: string
): Promise<string[]> {
  const names = [...text.matchAll(/@([A-Za-z0-9_]{2,32})/g)].map((m) => (m[1] ?? "").toLowerCase());
  if (names.length === 0) return [];
  const { rows } = await client.query<{ author_id: string; author_name: string }>(
    `SELECT DISTINCT ON (author_id) author_id, author_name FROM chat_events
     WHERE workspace_id = $1 ORDER BY author_id, provider_time DESC LIMIT 200`,
    [workspaceId]
  );
  const byName = new Map(rows.map((r) => [r.author_name.toLowerCase(), r.author_id]));
  const out: string[] = [];
  for (const n of names.slice(0, 3)) {
    const id = byName.get(n);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Process one accepted chat event. Idempotent: reprocessing a processed event
 * is a no-op, so outbox redelivery and worker restarts are safe.
 */
export async function processEvent(client: PoolClient, eventId: string): Promise<{ status: "processed" | "duplicate" | "ignored" }> {
  await client.query("BEGIN");
  try {
    const locked = await client.query<ChatEventRow>(
      "SELECT * FROM chat_events WHERE id = $1 FOR UPDATE",
      [eventId]
    );
    const event = locked.rows[0];
    if (!event) {
      await client.query("COMMIT");
      return { status: "ignored" };
    }
    if (event.processed_time) {
      await client.query("COMMIT");
      return { status: "duplicate" };
    }

    const ws = await client.query<{ policy_version: number }>(
      "SELECT policy_version FROM workspaces WHERE id = $1",
      [event.workspace_id]
    );
    const policyVersion = ws.rows[0]?.policy_version ?? 1;
    const pol = await client.query<{ preset: PolicyPreset; blocked_domains: string[] }>(
      "SELECT preset, blocked_domains FROM policy_versions WHERE workspace_id = $1 AND version = $2",
      [event.workspace_id, policyVersion]
    );
    const policy = pol.rows[0] ?? { preset: "balanced" as PolicyPreset, blocked_domains: [] as string[] };

    // Non-message kinds are observations, not reviewable content.
    if (event.kind !== "message") {
      await client.query("UPDATE chat_events SET processed_time = now(), skipped = TRUE WHERE id = $1", [eventId]);
      await client.query("COMMIT");
      return { status: "processed" };
    }

    // Bounded author context: last 5 normalized texts by this author.
    const recent = await client.query<{ normalized_text: string }>(
      `SELECT normalized_text FROM chat_events
       WHERE workspace_id = $1 AND author_id = $2 AND id != $3
       ORDER BY provider_time DESC LIMIT 5`,
      [event.workspace_id, event.author_id, eventId]
    );
    let replyToAuthorId: string | null = null;
    if (event.reply_to_message_id) {
      const target = await client.query<{ author_id: string }>(
        "SELECT author_id FROM chat_events WHERE workspace_id = $1 AND platform_message_id = $2 LIMIT 1",
        [event.workspace_id, event.reply_to_message_id]
      );
      replyToAuthorId = target.rows[0]?.author_id ?? null;
    }
    const mentioned = await resolveMention(client, event.workspace_id, event.original_text);

    const signal = fakeEvaluate({
      text: event.original_text,
      authorId: event.author_id,
      authorName: event.author_name,
      blockedDomains: policy.blocked_domains ?? [],
      recentAuthorTexts: recent.rows.map((r) => r.normalized_text),
      replyToAuthorId,
      mentionedUserIds: mentioned,
    });

    const evaluation = {
      provider: FAKE_PROVIDER,
      modelVersion: FAKE_MODEL_VERSION,
      category: signal.category,
      score: signal.score,
      targetUserId: signal.targetUserId,
      hasBlockedDomain: signal.hasBlockedDomain,
      injectionAttempt: signal.injectionAttempt,
      abstained: signal.abstained,
      explanation: signal.explanation,
    };
    await client.query(
      "UPDATE chat_events SET processed_time = now(), category = $2, evaluation = $3 WHERE id = $1",
      [eventId, signal.category, JSON.stringify(evaluation)]
    );

    if (signal.category === "ordinary" || signal.category === "unknown") {
      await client.query("COMMIT");
      return { status: "processed" };
    }

    // Grouping: match an open/claimed incident on the same key within the
    // fixed explainable window (event-time based, order independent).
    const key = groupKey({
      category: signal.category,
      normalizedText: event.normalized_text,
      targetUserId: signal.targetUserId,
    });
    const windowMs = GROUP_WINDOW_MS[signal.category] ?? 0;
    let incidentId: string | null = null;

    if (key && GROUPABLE.has(signal.category) && windowMs > 0) {
      const match = await client.query<{ id: string }>(
        `SELECT id FROM incidents
         WHERE workspace_id = $1 AND category = $2 AND group_key = $3
           AND state IN ('open','claimed')
           AND ABS(EXTRACT(EPOCH FROM (last_observed_at - $4::timestamptz))) * 1000 <= $5
         ORDER BY last_observed_at DESC LIMIT 1 FOR UPDATE`,
        [event.workspace_id, signal.category, key, event.provider_time.toISOString(), windowMs]
      );
      incidentId = match.rows[0]?.id ?? null;
    }

    if (!incidentId) {
      const decision = evaluatePolicy({
        category: signal.category,
        policy: { preset: policy.preset, nuance: "", blockedDomains: policy.blocked_domains ?? [], version: policyVersion },
        accountCount: 1,
        messageCount: 1,
        hasBlockedDomain: signal.hasBlockedDomain,
      });
      const severity = severityFor(signal.category, { accountCount: 1, preset: policy.preset });
      const created = await client.query<{ id: string }>(
        `INSERT INTO incidents(
           workspace_id, channel_id, category, severity, title, summary, state, version,
           group_key, first_observed_at, last_observed_at, message_count, account_count,
           target_user_id, recommended_action, channel_rule, observed_pattern, uncertainty,
           eligible_actions, policy_version
         ) VALUES ($1,$2,$3,$4,$5,$6,'open',1,$7,$8,$8,1,1,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          event.workspace_id,
          event.channel_id,
          signal.category,
          severity,
          TITLES[signal.category] ?? "Needs review",
          summarize(signal.category, 1, 1),
          key,
          event.provider_time.toISOString(),
          signal.targetUserId,
          decision.recommendedAction,
          decision.channelRule,
          signal.explanation,
          decision.uncertainty,
          JSON.stringify(decision.eligibleActions),
          policyVersion,
        ]
      );
      const newId = created.rows[0]?.id;
      if (!newId) throw new Error("incident insert returned no row");
      incidentId = newId;
      await client.query("INSERT INTO incident_events(incident_id, chat_event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
        incidentId,
        eventId,
      ]);
    } else {
      await client.query("INSERT INTO incident_events(incident_id, chat_event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
        incidentId,
        eventId,
      ]);
      const counts = await client.query<{ messages: string; accounts: string; first: Date; last: Date }>(
        `SELECT COUNT(*)::text AS messages,
                COUNT(DISTINCT e.author_id)::text AS accounts,
                MIN(e.provider_time) AS first, MAX(e.provider_time) AS last
         FROM incident_events ie JOIN chat_events e ON e.id = ie.chat_event_id
         WHERE ie.incident_id = $1`,
        [incidentId]
      );
      const c = counts.rows[0];
      const messageCount = Number(c?.messages ?? "1");
      const accountCount = Number(c?.accounts ?? "1");
      const decision = evaluatePolicy({
        category: signal.category,
        policy: { preset: policy.preset, nuance: "", blockedDomains: policy.blocked_domains ?? [], version: policyVersion },
        accountCount,
        messageCount,
        hasBlockedDomain: signal.hasBlockedDomain,
      });
      await client.query(
        `UPDATE incidents SET message_count = $2, account_count = $3,
           first_observed_at = LEAST(first_observed_at, $4), last_observed_at = GREATEST(last_observed_at, $5),
           severity = $6, summary = $7, recommended_action = $8, eligible_actions = $9,
           version = version + 1, updated_at = now()
         WHERE id = $1`,
        [
          incidentId,
          messageCount,
          accountCount,
          c?.first ?? event.provider_time,
          c?.last ?? event.provider_time,
          severityFor(signal.category, { accountCount, preset: policy.preset }),
          summarize(signal.category, messageCount, accountCount),
          decision.recommendedAction,
          JSON.stringify(decision.eligibleActions),
        ]
      );
    }

    await emitUpdate(client, event.workspace_id, signal.category === "stream_issue_report" ? "stream_issue" : "incident", incidentId);
    await client.query("COMMIT");
    return { status: "processed" };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Simulated dispatch. Revalidates every invariant immediately before calling
// the simulation-only executor. Preview can never reach the executor: the
// checklist refuses first, and tests assert zero executor calls.
// ---------------------------------------------------------------------------

interface IntentRow {
  id: string;
  workspace_id: string;
  incident_id: string;
  operation_key: string;
  action: "delete_message" | "timeout_user" | "ban_user";
  target_message_id: string | null;
  target_user_id: string;
  duration_seconds: number | null;
  state: string;
  actor_user_id: string;
  policy_version: number;
  evidence_version: number;
  authority_version: number;
  mode: string;
  expires_at: Date;
  created_at: Date;
}

export async function dispatchAction(
  client: PoolClient,
  intentId: string,
  executor: SimulationExecutor
): Promise<{ status: "done" | "duplicate" | "recovered" | "refused"; state: string }> {
  // Recovery path: an intent left `submitting` by a crash is reconciled by
  // re-reading the ledger — never by re-executing.
  {
    const probe = await client.query<IntentRow>("SELECT * FROM action_intents WHERE id = $1", [intentId]);
    const current = probe.rows[0];
    if (!current) return { status: "duplicate", state: "missing" };
    if (current.state !== "queued" && current.state !== "submitting") {
      return { status: "duplicate", state: current.state };
    }
    if (current.state === "submitting") {
      return await recoverSubmitting(client, current, executor);
    }
  }

  let admitted: {
    operationKey: string;
    action: string;
    targetMessageId: string | null;
    targetUserId: string;
    durationSeconds: number | null;
  } | null = null;
  await client.query("BEGIN");
  try {
    const locked = await client.query<IntentRow>(
      "SELECT * FROM action_intents WHERE id = $1 FOR UPDATE",
      [intentId]
    );
    const intent = locked.rows[0];
    if (!intent || intent.state !== "queued") {
      await client.query("ROLLBACK");
      return { status: "duplicate", state: intent?.state ?? "missing" };
    }
    const ws = await client.query<{
      mode: string;
      paused: boolean;
      policy_version: number;
      authority_version: number;
    }>("SELECT mode, paused, policy_version, authority_version FROM workspaces WHERE id = $1", [intent.workspace_id]);
    const w = ws.rows[0];
    if (!w) {
      await client.query("ROLLBACK");
      return { status: "duplicate", state: "missing" };
    }
    const member = await client.query<{ user_id: string }>(
      "SELECT user_id FROM memberships WHERE workspace_id = $1 AND user_id = $2",
      [intent.workspace_id, intent.actor_user_id]
    );
    const inc = await client.query<{ version: number; state: string; eligible_actions: string[] }>(
      "SELECT version, state, eligible_actions FROM incidents WHERE id = $1",
      [intent.incident_id]
    );
    const incident = inc.rows[0];

    let targetExists = false;
    if (incident) {
      if (intent.action === "delete_message" && intent.target_message_id) {
        const t = await client.query<{ id: string }>(
          `SELECT e.id FROM chat_events e JOIN incident_events ie ON ie.chat_event_id = e.id
           WHERE ie.incident_id = $1 AND e.workspace_id = $2 AND e.platform_message_id = $3`,
          [intent.incident_id, intent.workspace_id, intent.target_message_id]
        );
        targetExists = Boolean(t.rows[0]);
      } else if (intent.action === "timeout_user") {
        const t = await client.query<{ id: string }>(
          `SELECT e.id FROM chat_events e JOIN incident_events ie ON ie.chat_event_id = e.id
           WHERE ie.incident_id = $1 AND e.workspace_id = $2 AND e.author_id = $3 LIMIT 1`,
          [intent.incident_id, intent.workspace_id, intent.target_user_id]
        );
        targetExists = Boolean(t.rows[0]);
      }
    }

    const recent = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM action_attempts a
       JOIN action_intents i ON i.id = a.intent_id
       WHERE i.workspace_id = $1 AND a.created_at > now() - interval '60 seconds'`,
      [intent.workspace_id]
    );
    const competing = await client.query<{ id: string }>(
      `SELECT id FROM action_intents
       WHERE workspace_id = $1 AND id != $2 AND target_user_id = $3 AND action = $4
         AND state IN ('queued','submitting','unknown') LIMIT 1`,
      [intent.workspace_id, intent.id, intent.target_user_id, intent.action]
    );

    const checklist: DispatchState = {
      mode: (w.mode === "assist" ? "assist" : "preview"),
      paused: w.paused,
      writeDisabled: w.mode !== "assist",
      actorAuthorized: Boolean(member.rows[0]),
      policyCurrent: w.policy_version === intent.policy_version,
      evidenceCurrent: incident?.version === intent.evidence_version,
      targetExists,
      paramsEqualApproved: true,
      evidenceFresh: intent.expires_at.getTime() > Date.now(),
      superseded: incident?.state === "resolved" || incident?.state === "dismissed",
      conflictingInFlight: Boolean(competing.rows[0]),
      withinRateCap: Number(recent.rows[0]?.n ?? "0") < 10,
      notExpired: intent.expires_at.getTime() > Date.now(),
      authorityCurrent: w.authority_version === intent.authority_version,
    };
    const verdict = checkDispatch(checklist);
    if (!verdict.ok) {
      const terminal =
        verdict.code === "expired"
          ? "expired"
          : verdict.code === "policy_changed" || verdict.code === "stale_evidence" || verdict.code === "conflict"
            ? "superseded"
            : "refused";
      await transitionTo(client, intent, terminal, verdict.code, verdict.reason);
      await client.query("COMMIT");
      return { status: "refused", state: terminal };
    }

    // Admitted: move to submitting. The executor call + ledger insert happen
    // in the same follow-up transaction so a crash leaves `submitting`, which
    // redelivery reconciles without re-executing.
    await client.query("UPDATE action_intents SET state = 'submitting', updated_at = now() WHERE id = $1", [intent.id]);
    await client.query("COMMIT");
    admitted = {
      operationKey: intent.operation_key,
      action: intent.action,
      targetMessageId: intent.target_message_id,
      targetUserId: intent.target_user_id,
      durationSeconds: intent.duration_seconds,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  // The simulation executor performs no I/O; invoking it here keeps the
  // submit-then-record window minimal and crash-safe (see recoverSubmitting).
  const call = admitted;
  if (!call) throw new Error("dispatch admitted no intent");
  const executed = await executor.execute({
    operationKey: call.operationKey,
    action: call.action,
    targetMessageId: call.targetMessageId,
    targetUserId: call.targetUserId,
    durationSeconds: call.durationSeconds,
  });

  await client.query("BEGIN");
  try {
    const locked = await client.query<IntentRow>(
      "SELECT * FROM action_intents WHERE id = $1 FOR UPDATE",
      [intentId]
    );
    const intent = locked.rows[0];
    if (!intent || intent.state !== "submitting") {
      // Lost a race with recovery: the recorded outcome stands.
      await client.query("ROLLBACK");
      return { status: "duplicate", state: intent?.state ?? "missing" };
    }
    const next = executed.outcome === "succeeded" ? "succeeded" : "unknown";
    await insertAttempt(client, intent, executed.outcome, executed.applied, executed.detail);
    await client.query(
      `UPDATE action_intents SET state = $2, last_outcome = $3, last_outcome_detail = $4, updated_at = now() WHERE id = $1`,
      [intent.id, next, executed.outcome, executed.detail]
    );
    await recordAudit(client, {
      workspaceId: intent.workspace_id,
      actorUserId: intent.actor_user_id,
      operation: next === "succeeded" ? "action.succeed" : "action.unknown",
      entityType: "action_intent",
      entityId: intent.id,
      prevState: "submitting",
      newState: next,
    });
    await emitUpdate(client, intent.workspace_id, "action", intent.id);
    await client.query("COMMIT");
    return { status: "done", state: next };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function recoverSubmitting(
  client: PoolClient,
  intent: IntentRow,
  executor: SimulationExecutor
): Promise<{ status: "recovered"; state: string }> {
  // The executor may or may not have run before the crash. Re-read the
  // deterministic ledger instead of submitting again.
  const found = await executor.reconcile({
    targetMessageId: intent.target_message_id,
    targetUserId: intent.target_user_id,
  });
  await client.query("BEGIN");
  try {
    const locked = await client.query<IntentRow>(
      "SELECT * FROM action_intents WHERE id = $1 FOR UPDATE",
      [intent.id]
    );
    const current = locked.rows[0];
    if (!current || current.state !== "submitting") {
      await client.query("ROLLBACK");
      return { status: "recovered", state: current?.state ?? "missing" };
    }
    if (found.applied === null) {
      await insertAttempt(client, current, "unknown", null, `Recovered after restart; still ambiguous. ${found.detail}`);
      await client.query(
        `UPDATE action_intents SET state = 'unknown', last_outcome = 'unknown',
           last_outcome_detail = $2, updated_at = now() WHERE id = $1`,
        [current.id, found.detail]
      );
      await emitUpdate(client, current.workspace_id, "action", current.id);
      await client.query("COMMIT");
      return { status: "recovered", state: "unknown" };
    }
    const next = found.applied ? "succeeded" : "refused";
    await insertAttempt(
      client,
      current,
      found.applied ? "succeeded" : "refused",
      found.applied,
      `Recovered after restart without re-execution. ${found.detail}`
    );
    await client.query(
      `UPDATE action_intents SET state = $2, last_outcome = $3, last_outcome_detail = $4, updated_at = now() WHERE id = $1`,
      [current.id, next, found.applied ? "succeeded" : "refused", found.detail]
    );
    await recordAudit(client, {
      workspaceId: current.workspace_id,
      actorUserId: current.actor_user_id,
      operation: "action.recover",
      entityType: "action_intent",
      entityId: current.id,
      prevState: "submitting",
      newState: next,
    });
    await emitUpdate(client, current.workspace_id, "action", current.id);
    await client.query("COMMIT");
    return { status: "recovered", state: next };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function insertAttempt(
  client: PoolClient,
  intent: IntentRow,
  outcome: string,
  applied: boolean | null,
  detail: string
): Promise<void> {
  const { rows } = await client.query<{ n: string }>(
    "SELECT COALESCE(MAX(attempt_no), 0)::text AS n FROM action_attempts WHERE intent_id = $1",
    [intent.id]
  );
  const attemptNo = Number(rows[0]?.n ?? "0") + 1;
  const fingerprint = requestHash(`${intent.id}:${attemptNo}:${intent.action}:${intent.target_message_id ?? ""}:${intent.target_user_id}`);
  await client.query(
    `INSERT INTO action_attempts(intent_id, attempt_no, fingerprint, outcome, applied, detail)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (intent_id, attempt_no) DO NOTHING`,
    [intent.id, attemptNo, fingerprint, outcome, applied, detail]
  );
}

async function transitionTo(
  client: PoolClient,
  intent: IntentRow,
  terminal: string,
  outcome: string,
  detail: string
): Promise<void> {
  await insertAttempt(client, intent, outcome, false, detail);
  await client.query(
    `UPDATE action_intents SET state = $2, last_outcome = $3, last_outcome_detail = $4, updated_at = now() WHERE id = $1`,
    [intent.id, terminal, outcome, detail]
  );
  await recordAudit(client, {
    workspaceId: intent.workspace_id,
    actorUserId: intent.actor_user_id,
    operation: "action.refuse",
    entityType: "action_intent",
    entityId: intent.id,
    prevState: intent.state,
    newState: terminal,
    rationale: outcome,
  });
  await emitUpdate(client, intent.workspace_id, "action", intent.id);
}
