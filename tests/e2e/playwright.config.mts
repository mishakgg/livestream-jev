import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const E2E_DATABASE_URL =
  process.env.LIVESTREAM_E2E_DATABASE_URL ??
  "postgres://livestream:livestream@localhost:5432/livestream_m0_e2e";

const serverEnv = {
  DATABASE_URL: E2E_DATABASE_URL,
  NODE_ENV: "test",
  DEMO_ENABLED: "true",
  PORT: "3001",
  CORS_ORIGINS: "http://localhost:5173",
  LOG_LEVEL: "error",
};

export default defineConfig({
  testDir: here,
  testMatch: ["**/*.spec.mts"],
  globalSetup: join(here, "global-setup.mts"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx --tsconfig apps/api/tsconfig.json apps/api/src/index.ts",
      cwd: root,
      port: 3001,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: serverEnv,
    },
    {
      command: "npx tsx --tsconfig apps/worker/tsconfig.json apps/worker/src/index.ts",
      cwd: root,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: serverEnv,
    },
    {
      command: "npm run dev -w @livestream/web",
      cwd: root,
      port: 5173,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: serverEnv,
    },
  ],
});
