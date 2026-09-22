import { defineConfig } from "vitest/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tsJsExtensionPlugin } from "../../tests/vitest-shared.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tsJsExtensionPlugin()],
  resolve: {
    alias: {
      "@livestream/contracts": join(here, "..", "contracts", "src", "index.ts"),
      "@livestream/domain": join(here, "..", "domain", "src", "index.ts"),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
