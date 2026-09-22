import "dotenv/config";
import PgBoss from "pg-boss";
import { getPool, closePool } from "@livestream/db";
import { SimulationExecutor } from "@livestream/platforms";
import { dispatchAction, processEvent } from "./pipeline.js";
import { startWithRetry } from "./startup.js";

const PROCESS_QUEUE = "m0-process-event";
const DISPATCH_QUEUE = "m0-dispatch-action";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  const pool = getPool(connectionString);
  const executor = new SimulationExecutor();

  // Bounded start retries: the database may not exist yet when the worker
  // boots (e2e global setup provisions it concurrently; compose orders the
  // same way). Each attempt uses a fresh instance so a failed start leaves
  // no half-open state behind.
  const boss = await startWithRetry(
    {
      attempts: 60,
      delayMs: 1000,
      onAttemptFailed: (attempt, err) =>
        console.error(`[worker] pg-boss start failed (attempt ${attempt}/60), retrying`, err),
    },
    async () => {
      const candidate = new PgBoss({ connectionString, max: 4 });
      candidate.on("error", (err) => console.error("[worker] pgboss error", err));
      try {
        await candidate.start();
        return candidate;
      } catch (err) {
        try {
          await candidate.stop();
        } catch {
          // Best-effort cleanup of the failed instance; the retry matters.
        }
        throw err;
      }
    }
  );
  await boss.createQueue(PROCESS_QUEUE);
  await boss.createQueue(DISPATCH_QUEUE);

  await boss.work<{ eventId: string }>(
    PROCESS_QUEUE,
    { batchSize: 4, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const client = await pool.connect();
        try {
          await processEvent(client, job.data.eventId);
        } finally {
          client.release();
        }
      }
    }
  );

  await boss.work<{ intentId: string }>(
    DISPATCH_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const client = await pool.connect();
        try {
          await dispatchAction(client, job.data.intentId, executor);
        } finally {
          client.release();
        }
      }
    }
  );

  // Outbox dispatcher: stable job ids per outbox row; a crash between send
  // and mark-delivered may duplicate a job, so handlers stay idempotent.
  let stopped = false;
  const pump = async (): Promise<void> => {
    if (stopped) return;
    try {
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ id: string; aggregate_type: string; aggregate_id: string }>(
          `SELECT id, aggregate_type, aggregate_id FROM outbox
           WHERE delivered = FALSE ORDER BY created_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`
        );
        for (const row of rows) {
          try {
            if (row.aggregate_type === "chat_event") {
              await boss.send(
                PROCESS_QUEUE,
                { eventId: row.aggregate_id },
                { singletonKey: `outbox:${row.id}`, retryLimit: 3 }
              );
            } else if (row.aggregate_type === "action_intent") {
              await boss.send(
                DISPATCH_QUEUE,
                { intentId: row.aggregate_id },
                { singletonKey: `outbox:${row.id}`, retryLimit: 3 }
              );
            } else {
              continue;
            }
            await client.query("UPDATE outbox SET delivered = TRUE WHERE id = $1", [row.id]);
          } catch (err) {
            console.error("[worker] outbox row failed, will retry", row.id, err);
          }
        }
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("[worker] outbox pump failed", err);
    }
    if (!stopped) setTimeout(() => void pump(), 1000);
  };
  void pump();

  console.log("[worker] started (demo simulation executor; no live writes exist in M0)");

  const shutdown = async (): Promise<void> => {
    stopped = true;
    await boss.stop({ graceful: true, timeout: 10_000 });
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
