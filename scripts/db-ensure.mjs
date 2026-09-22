// Ensure a PostgreSQL database exists (used by e2e setup and local dev).
// Usage: DATABASE_URL=postgres://user:pass@host:port/dbname node scripts/db-ensure.mjs
import pg from "pg";

const target = process.env.DATABASE_URL;
if (!target) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const url = new URL(target);
const dbName = url.pathname.replace(/^\//, "");
url.pathname = "/postgres";

const { Client } = pg;
const client = new Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query(`CREATE DATABASE "${dbName}"`);
  console.log(`created database ${dbName}`);
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "42P04") {
    console.log(`database ${dbName} already exists`);
  } else {
    throw err;
  }
} finally {
  await client.end();
}
