// Deterministic demo seed: two isolated workspaces + test identities.
// Idempotent (safe to re-run). Refuses to run in production.
// Usage: DATABASE_URL=... node scripts/db-seed.mjs
import pg from "pg";

if (process.env.NODE_ENV === "production") {
  console.error("refusing to seed a production database");
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const WORKSPACES = [
  { id: "demo-alpha", name: "Demo Alpha (synthetic)", channelId: "channel-alpha" },
  { id: "demo-beta", name: "Demo Beta (synthetic)", channelId: "channel-beta" },
];

const USERS = [
  { id: "user-alice", displayName: "Alice Owner", platformUserId: "twitch-owner-alpha", username: "alice" },
  { id: "user-bob", displayName: "Bob Mod", platformUserId: "twitch-mod-alpha-1", username: "bob" },
  { id: "user-cara", displayName: "Cara Mod", platformUserId: "twitch-mod-alpha-2", username: "cara" },
  { id: "user-dave", displayName: "Dave Owner", platformUserId: "twitch-owner-beta", username: "dave" },
  { id: "user-erin", displayName: "Erin Mod", platformUserId: "twitch-mod-beta-1", username: "erin" },
];

const MEMBERSHIPS = [
  ["demo-alpha", "user-alice", "owner"],
  ["demo-alpha", "user-bob", "moderator"],
  ["demo-alpha", "user-cara", "moderator"],
  ["demo-beta", "user-dave", "owner"],
  ["demo-beta", "user-erin", "moderator"],
];

const { Client } = pg;
const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  for (const w of WORKSPACES) {
    await client.query(
      `INSERT INTO workspaces(id, name, channel_id, mode, paused, policy_version, authority_version)
       VALUES ($1, $2, $3, 'preview', FALSE, 1, 1)
       ON CONFLICT (id) DO NOTHING`,
      [w.id, w.name, w.channelId]
    );
    await client.query(
      `INSERT INTO workspace_seq(workspace_id, seq) VALUES ($1, 0) ON CONFLICT (workspace_id) DO NOTHING`,
      [w.id]
    );
  }
  for (const u of USERS) {
    await client.query(
      `INSERT INTO users(id, display_name, platform_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [u.id, u.displayName, u.platformUserId]
    );
  }
  for (const [ws, user, role] of MEMBERSHIPS) {
    await client.query(
      `INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [ws, user, role]
    );
  }
  for (const [ws, owner] of [["demo-alpha", "user-alice"], ["demo-beta", "user-dave"]]) {
    await client.query(
      `INSERT INTO policy_versions(workspace_id, version, preset, nuance, blocked_domains, created_by_user_id)
       VALUES ($1, 1, 'balanced', '', '["scammy-claim.example"]', $2)
       ON CONFLICT (workspace_id, version) DO NOTHING`,
      [ws, owner]
    );
  }
  await client.query("COMMIT");
  console.log("seeded workspaces: demo-alpha, demo-beta");
  console.log("demo usernames: alice (owner α), bob/cara (mods α), dave (owner β), erin (mod β)");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
