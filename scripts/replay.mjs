// Deterministic synthetic replay client. Posts a fixture through the real
// durable intake endpoint (no dashboard bypass, no direct DB writes).
// Usage: node scripts/replay.mjs <fixture> [--workspace=demo-alpha]
//        [--user=alice] [--api=http://localhost:3001] [--preserve-order]
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fixturePath = args.find((a) => !a.startsWith("--"));
if (!fixturePath) {
  console.error("usage: node scripts/replay.mjs <fixture.json> [--workspace=..] [--user=..] [--api=..] [--preserve-order]");
  process.exit(1);
}
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const workspace = opt("workspace", "demo-alpha");
const username = opt("user", "alice");
const api = opt("api", process.env.API_BASE_URL ?? "http://localhost:3001");
const preserveOrder = args.includes("--preserve-order");

const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
const events = raw.map((e) => {
  const { _note: _ignored, ...rest } = e;
  void _ignored;
  return rest;
});

// Deterministic replay order: providerTime, then deliveryId — unless tests ask
// for exact fixture order (duplicates/out-of-order preserved).
if (!preserveOrder) {
  events.sort((a, b) =>
    a.providerTime < b.providerTime ? -1 : a.providerTime > b.providerTime ? 1 : a.deliveryId < b.deliveryId ? -1 : 1
  );
}

const loginRes = await fetch(`${api}/api/demo/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username }),
});
if (!loginRes.ok) {
  console.error(`login failed for ${username}: ${loginRes.status} ${await loginRes.text()}`);
  process.exit(1);
}
const session = await loginRes.json();
if (session.workspaceId !== workspace) {
  console.error(`user ${username} belongs to ${session.workspaceId}, not ${workspace}`);
  process.exit(1);
}

const res = await fetch(`${api}/api/workspaces/${workspace}/replay`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
  body: JSON.stringify({ events }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`replay failed: ${res.status} ${body}`);
  process.exit(1);
}
console.log(`replayed ${events.length} deliveries -> ${body}`);
