// Database migration CLI: `node scripts/db-migrate.mjs up|reset`.
// Uses DATABASE_URL. `reset` drops the public schema and re-applies all
// migrations; it refuses to run in production.
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, "..", "packages", "db", "migrations");

function connectionString() {
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    console.error("DATABASE_URL is not set. See .env.example.");
    process.exit(1);
  }
  return cs;
}

async function migrate(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const newly = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newly.push(file);
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
  if (newly.length === 0) console.log("database is up to date");
  return newly;
}

const cmd = process.argv[2] ?? "up";
const { Client } = pg;
const client = new Client({ connectionString: connectionString() });
await client.connect();
try {
  if (cmd === "reset") {
    if (process.env.NODE_ENV === "production") {
      console.error("refusing to reset a production database");
      process.exit(1);
    }
    console.log("dropping public schema...");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrate(client);
    console.log("reset complete");
  } else if (cmd === "up") {
    await migrate(client);
  } else {
    console.error(`unknown command: ${cmd} (expected up|reset)`);
    process.exit(1);
  }
} finally {
  await client.end();
}
