// Manual e2e stack runner: prepares the e2e database, then starts the API,
// worker, and web client together for local inspection or debugging.
// Usage: node scripts/start-e2e.mjs   (Ctrl+C stops everything)
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E_URL =
  process.env.LIVESTREAM_E2E_DATABASE_URL ??
  "postgres://livestream:livestream@localhost:5432/livestream_m0_e2e";
const env = {
  ...process.env,
  DATABASE_URL: E2E_URL,
  NODE_ENV: "test",
  DEMO_ENABLED: "true",
  PORT: "3001",
  CORS_ORIGINS: "http://localhost:5173",
};

execFileSync("node", ["scripts/db-ensure.mjs"], { cwd: root, env, stdio: "inherit" });
execFileSync("node", ["scripts/db-migrate.mjs", "up"], { cwd: root, env, stdio: "inherit" });
execFileSync("node", ["scripts/db-seed.mjs"], { cwd: root, env, stdio: "inherit" });

const children = [
  spawn("npx", ["tsx", "--tsconfig", "apps/api/tsconfig.json", "apps/api/src/index.ts"], { cwd: root, env, stdio: "inherit", shell: true }),
  spawn("npx", ["tsx", "--tsconfig", "apps/worker/tsconfig.json", "apps/worker/src/index.ts"], { cwd: root, env, stdio: "inherit", shell: true }),
  spawn("npm", ["run", "dev", "-w", "@livestream/web"], { cwd: root, env, stdio: "inherit", shell: true }),
];

const stop = () => {
  for (const c of children) c.kill("SIGINT");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("e2e stack running: api http://localhost:3001, web http://localhost:5173");
await new Promise(() => {});
