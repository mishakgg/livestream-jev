// Shared Vitest helpers (plain .mjs so configs load it without TS ambiguity).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Resolve NodeNext-style `./x.js` relative imports to `./x.ts(x)` sources. */
export function tsJsExtensionPlugin() {
  return {
    name: "ts-js-extension",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || typeof source !== "string") return null;
      if (!source.endsWith(".js") || !source.startsWith(".")) return null;
      const base = join(dirname(importer), source.slice(0, -3));
      for (const ext of [".ts", ".tsx"]) {
        if (existsSync(base + ext)) return base + ext;
      }
      return null;
    },
  };
}

/** Map workspace packages to their TS sources so tests run without a build. */
export function workspaceAliases(repoRoot) {
  const src = (pkg) => join(repoRoot, "packages", pkg, "src", "index.ts");
  return {
    "@livestream/contracts": src("contracts"),
    "@livestream/domain": src("domain"),
    "@livestream/classifier": src("classifier"),
    "@livestream/platforms": src("platforms"),
    "@livestream/db": src("db"),
  };
}
