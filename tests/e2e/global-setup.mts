import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

export const E2E_DATABASE_URL =
  process.env.LIVESTREAM_E2E_DATABASE_URL ??
  "postgres://livestream:livestream@localhost:5432/livestream_m0_e2e";

async function globalSetup(): Promise<void> {
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL, NODE_ENV: "test", DEMO_ENABLED: "true" };
  console.log(`[e2e] preparing database ${E2E_DATABASE_URL.replace(/:[^:@/]+@/, ":***@")}`);
  execFileSync("node", ["scripts/db-ensure.mjs"], { cwd: root, env, stdio: "inherit" });
  execFileSync("node", ["scripts/db-migrate.mjs", "up"], { cwd: root, env, stdio: "inherit" });
  // Fresh deterministic state for every e2e run: truncate + reseed.
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE workspaces, users, memberships, demo_sessions, chat_events, deliveries,
        duplicate_deliveries, outbox, incidents, incident_events, policy_versions, action_intents,
        action_attempts, audit_events, workspace_seq, workspace_updates CASCADE`
    );
  } finally {
    await client.end();
  }
  execFileSync("node", ["scripts/db-seed.mjs"], { cwd: root, env, stdio: "inherit" });
  console.log("[e2e] database ready");
}

export default globalSetup;
