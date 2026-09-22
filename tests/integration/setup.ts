import pg from "pg";
import { __resetPoolForTests, getPool, migrate } from "@livestream/db";

// Suite setup (runs in the worker process before test files): point the
// shared pool at the isolated test database, create + migrate it.
const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://livestream:livestream@localhost:5432/livestream_m0_test";

function maintenanceUrl(): string {
  const u = new URL(TEST_URL);
  u.pathname = "/postgres";
  return u.toString();
}

function dbName(): string {
  return new URL(TEST_URL).pathname.replace(/^\//, "");
}

async function ensureDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName()}"`);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code !== "42P04") {
      throw err;
    }
    // 42P04 = already exists.
  } finally {
    await client.end();
  }
}

process.env.DATABASE_URL = TEST_URL;
process.env.NODE_ENV = "test";
process.env.DEMO_ENABLED = "true";
process.env.LOG_LEVEL = "error";
__resetPoolForTests();

await ensureDatabase();
const pool = getPool(TEST_URL);
const client = await pool.connect();
try {
  await migrate(client);
} finally {
  client.release();
}
