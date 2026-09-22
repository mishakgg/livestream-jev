import { defineConfig } from "vitest/config";
import { tsJsExtensionPlugin } from "../../tests/vitest-shared.mjs";

export default defineConfig({
  plugins: [tsJsExtensionPlugin()],
  test: { include: ["src/**/*.test.ts"] },
});
