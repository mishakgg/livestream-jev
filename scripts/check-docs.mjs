// Documentation checker: relative markdown links must resolve, root scripts
// required by AGENTS.md must exist, and milestone status must be explicit.
// Usage: node scripts/check-docs.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function mdFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...mdFiles(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

for (const file of mdFiles(root)) {
  const text = readFileSync(file, "utf8");
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)];
  for (const [, target] of links) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) failures.push(`${file}: broken link -> ${target}`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const name of ["lint", "typecheck", "test", "test:integration", "test:e2e", "build", "check:docs"]) {
  if (!pkg.scripts?.[name]) failures.push(`package.json: missing required root script "${name}"`);
}

const readme = readFileSync(join(root, "README.md"), "utf8");
for (const needle of ["M0", "synthetic", "Preview"]) {
  if (!readme.includes(needle)) failures.push(`README.md: expected to mention "${needle}"`);
}

if (failures.length > 0) {
  console.error("check:docs FAILED:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`check:docs OK (${mdFiles(root).length} markdown files, required scripts present)`);
