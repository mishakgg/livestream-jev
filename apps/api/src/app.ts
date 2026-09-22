import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { getPool } from "@livestream/db";
import { demoEnabled } from "./errors.js";
import { demoRoutes } from "./routes/demo.js";
import { replayRoutes } from "./routes/replay.js";
import { incidentRoutes } from "./routes/incidents.js";
import { actionRoutes } from "./routes/actions.js";
import { policyRoutes } from "./routes/policy.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { eventRoutes } from "./routes/events.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 1024 * 1024,
  });

  const origins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, { origin: origins, credentials: false });

  app.get("/api/health", async () => {
    let db: "ok" | "down" = "down";
    let queueDepth = -1;
    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        db = "ok";
        const q = await client.query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM outbox WHERE delivered = FALSE"
        );
        queueDepth = Number(q.rows[0]?.n ?? "0");
      } finally {
        client.release();
      }
    } catch {
      db = "down";
    }
    return {
      status: db === "ok" ? "ok" : "degraded",
      demo: demoEnabled(),
      environment: "demo",
      db,
      queueDepth,
      writes: "simulation-only",
    };
  });

  await app.register(demoRoutes);
  await app.register(replayRoutes);
  await app.register(incidentRoutes);
  await app.register(actionRoutes);
  await app.register(policyRoutes);
  await app.register(workspaceRoutes);
  await app.register(eventRoutes);

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({ code: "not_found", message: "Not found." });
  });

  app.setErrorHandler((err, _req, reply) => {
    // Never leak raw bodies, SQL, or secrets in error responses.
    app.log.error({ err }, "request failed");
    const status = typeof (err as { statusCode?: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : 500;
    if (status < 500) {
      return reply.status(status).send({ code: "bad_request", message: "Invalid request." });
    }
    return reply.status(500).send({ code: "bad_request", message: "Internal error." });
  });

  return app;
}
