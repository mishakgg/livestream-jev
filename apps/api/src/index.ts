import "dotenv/config";
import { getPool, closePool } from "@livestream/db";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? "3001");

async function main(): Promise<void> {
  getPool(); // fail fast when DATABASE_URL is missing
  const app = await buildApp();
  await app.listen({ port, host: "127.0.0.1" });
  app.log.info({ port }, "api listening (demo environment)");

  const shutdown = async (): Promise<void> => {
    app.log.info("shutting down");
    await app.close();
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
