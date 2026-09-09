// A fixed companion resource, merged only by the desktop test/release builder.
// Ordinary frontend builds and SDK-free CI do not require the Adobe package.
import { mkdir, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const companion = join(root, "premiere-companion/dist/SauceBunnyPremiere.ccx");
if (!(await lstat(companion)).isFile()) throw new Error("Build the Premiere companion CCX before bundling.");
const config = join(root, "src-tauri/target/premiere-bundle/tauri.premiere.conf.json");
await mkdir(dirname(config), { recursive: true });
await writeFile(config, JSON.stringify({ bundle: { resources: { [companion]: "companion/SauceBunnyPremiere.ccx" } } }, null, 2) + "\n");
console.log(config);
