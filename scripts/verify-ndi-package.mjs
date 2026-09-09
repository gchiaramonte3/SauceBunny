import { readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const approved = JSON.parse(await readFile(new URL("./ndi-runtime-manifest.json", import.meta.url), "utf8"));
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function verifyNdiPackage(app, { approvedManifest = approved, run = execFileSync } = {}) {
  const approved = approvedManifest;
  app = await realpath(app);
  const runtime = path.join(app, "Contents/Frameworks/libndi.dylib");
  if (await realpath(runtime) !== runtime) throw new Error("NDI runtime must be a real in-bundle file, not an external symlink.");
  const licenses = path.join(app, "Contents/Resources/licenses");
  const provenance = JSON.parse(await readFile(path.join(licenses, "ndi-runtime-provenance.json"), "utf8"));
  if (JSON.stringify(provenance) !== JSON.stringify(approved)) throw new Error("NDI runtime provenance does not match the approved manifest.");
  if (hash(await readFile(path.join(licenses, "libndi_licenses.txt"))) !== approved.noticesSha256) throw new Error("Vendor NDI notices are missing or altered.");
  if (!Buffer.from(await readFile(path.join(licenses, "NDI-RUNTIME-TERMS.txt"))).equals(await readFile(path.join(root, "licenses/NDI-RUNTIME-TERMS.txt")))) throw new Error("NDI component terms are missing or stale.");

  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (/^libndi.*\.dylib$/i.test(entry.name)) found.push(file);
      if (/^(NDI_Transmit_AdobeCC\.bundle|NDIToolsInstaller\.pkg|libNDI_for_Mac\.pkg|Install_NDI_SDK.*|NDI SDK for Apple|NDI Tools|Processing\.NDI\..*\.h)$/i.test(entry.name)) throw new Error(`Forbidden NDI SDK/Tools payload: ${path.relative(app, file)}`);
      if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(app);
  if (found.length !== 1 || found[0] !== runtime) throw new Error("The package must contain exactly one standard NDI runtime, and no Advanced runtime.");

  // Signing may change signature bytes. Verify code signing and the approved
  // per-architecture build UUIDs; the original whole-file SHA is checked
  // before bundling, with that provenance carried into the sealed resources.
  run("codesign", ["--verify", "--strict", runtime], { stdio: "pipe" });
  const uuids = run("dwarfdump", ["--uuid", runtime], { encoding: "utf8" });
  const architectures = [...uuids.matchAll(/UUID: ([A-F0-9-]+) \(([^)]+)\)/g)];
  if (!architectures.length || architectures.some(([, uuid, arch]) => approved.uuids[arch] !== uuid)) throw new Error("Bundled NDI architecture/build does not match the approved runtime.");
  const deps = run("otool", ["-L", runtime], { encoding: "utf8" });
  for (const line of deps.split("\n").filter(line => /^\s+/.test(line))) {
    const dependency = line.trim().split(" (")[0];
    if (dependency !== "@rpath/libndi.dylib" && !dependency.startsWith("/System/Library/") && !dependency.startsWith("/usr/lib/")) throw new Error(`NDI runtime has an external dependency: ${dependency}`);
  }
  const executable = path.join(app, "Contents/MacOS/sauce-bunny");
  const appDeps = run("otool", ["-L", executable], { encoding: "utf8" });
  if (/libndi/i.test(appDeps)) throw new Error("Sauce Bunny must dynamically load NDI only when requested, not link it at launch.");
  const symbols = run("strings", [executable], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (!symbols.includes("NDI runtime could not be loaded")) throw new Error("The native NDI bridge is absent from the application.");
  return { version: approved.version, architectures: architectures.map(([, , arch]) => arch) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log("NDI package verified:", await verifyNdiPackage(process.argv[2])); }
  catch (error) { console.error("NDI package verification failed:", error.message); process.exitCode = 1; }
}
