#!/usr/bin/env node
// Build artifacts only. Never stamps a version, invokes Tauri, or modifies dist/.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "sauce-catalog-build-"));
if (!process.argv[2]) {
  const build = spawnSync(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.config.ts", "--outDir", output], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    process.exit(build.status ?? 1);
  }
}
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const files = walk(output);
if (!files.some((file) => relative(output, file) === "index.html") || !files.some((file) => file.endsWith(".js"))) {
  throw new Error("Expected a real frontend production build, not an empty artifact directory.");
}
const unexpected = files.filter((file) => /design-system|design-catalog/.test(relative(output, file)) ||
  (/\.(?:html|js|css)$/.test(file) && /cp-ds-|participant-trigger-compact|One app\. A shared design language/.test(readFileSync(file, "utf8"))));
if (unexpected.length) throw new Error(`Catalog leaked into production:\n${unexpected.join("\n")}`);
console.log(`PASS: ${files.length} production artifacts; no catalog HTML, fixture code, or styles.`);
console.log(`Frontend verification output: ${output}`);
