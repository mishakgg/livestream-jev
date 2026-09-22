import type { PoolClient } from "pg";
import type { ReplayEvent, ReplayResult } from "@livestream/contracts";
import { normalizeText } from "@livestream/domain";

/**
 * Durable intake: persist the deduplicated event and its outbox row in one
 * transaction. The caller acknowledges only durable acceptance. Duplicate
 * verified deliveries return success without new work.
 */
export async function acceptReplayBatch(
  client: PoolClient,
  input: { workspaceId: string; channelId: string; events: ReplayEvent[] }
): Promise<ReplayResult> {
  let accepted = 0;
  let duplicates = 0;
  const eventIds: string[] = [];

  await client.query("BEGIN");
  try {
    for (const event of input.events) {
      // 1. Transport-delivery dedup.
      const delivery = await client.query(
        `INSERT INTO deliveries(workspace_id, delivery_id) VALUES ($1, $2)
         ON CONFLICT (workspace_id, delivery_id) DO NOTHING RETURNING delivery_id`,
        [input.workspaceId, event.deliveryId]
      );
      if ((delivery.rowCount ?? 0) === 0) {
        duplicates += 1;
        await client.query(
          `INSERT INTO duplicate_deliveries(workspace_id, delivery_id, platform_message_id, reason)
           VALUES ($1, $2, $3, 'duplicate_delivery_id')`,
          [input.workspaceId, event.deliveryId, event.platformMessageId]
        );
        continue;
      }
      // 2. Chat-event dedup (same message under a fresh delivery id).
      const normalized = normalizeText(event.text);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO chat_events(
           workspace_id, channel_id, platform_message_id, kind, author_id, author_name,
           original_text, normalized_text, reply_to_message_id, provider_time, origin, delivery_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'replay',$11)
         ON CONFLICT (workspace_id, channel_id, platform_message_id, kind) DO NOTHING
         RETURNING id`,
        [
          input.workspaceId,
          input.channelId,
          event.platformMessageId,
          event.kind,
          event.authorId,
          event.authorName,
          event.text,
          normalized,
          event.replyToMessageId ?? null,
          event.providerTime,
          event.deliveryId,
        ]
      );
      const row = inserted.rows[0];
      if (!row) {
        duplicates += 1;
        await client.query(
          `INSERT INTO duplicate_deliveries(workspace_id, delivery_id, platform_message_id, reason)
           VALUES ($1, $2, $3, 'duplicate_message_id')`,
          [input.workspaceId, event.deliveryId, event.platformMessageId]
        );
        continue;
      }
      await client.query(
        `INSERT INTO outbox(workspace_id, aggregate_type, aggregate_id, payload)
         VALUES ($1, 'chat_event', $2, $3)`,
        [input.workspaceId, row.id, JSON.stringify({ eventId: row.id })]
      );
      accepted += 1;
      eventIds.push(row.id);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  return { accepted, duplicates, eventIds };
}
