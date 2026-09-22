import { defineConfig } from "vitest/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tsJsExtensionPlugin, workspaceAliases } from "../vitest-shared.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  root,
  plugins: [tsJsExtensionPlugin()],
  resolve: { alias: workspaceAliases(root) },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: [join(root, "tests", "integration", "setup.ts")],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One shared test database: run everything serially in a single worker.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    sequence: { concurrent: false },
  },
});
