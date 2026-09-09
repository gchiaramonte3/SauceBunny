import { readFile, mkdir, copyFile, chmod, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
export const manifest = JSON.parse(await readFile(new URL("./ndi-runtime-manifest.json", import.meta.url), "utf8"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function verifyVendorRuntime(file) {
  // Trust services must be reachable. Never waive a failed signature check
  // or re-sign an unverified input merely to make the later verifier pass.
  execFileSync("codesign", ["--verify", "--strict", file], { stdio: "pipe" });
  const signature = spawnSync("codesign", ["-dvv", file], { encoding: "utf8" });
  if (signature.status !== 0 || !signature.stderr.includes(`TeamIdentifier=${manifest.vendorTeamId}`)) {
    throw new Error("The NDI runtime does not carry the approved vendor identity.");
  }
}

export async function prepareNdiBundle({ sdk, staging = path.join(root, "src-tauri/target/ndi-bundle"), approved = manifest, verifySignature = verifyVendorRuntime } = {}) {
  if (!sdk || !path.isAbsolute(sdk)) throw new Error("Set SAUCE_NDI_SDK_DIR to the absolute NDI SDK for Apple folder. End users do not install the SDK.");
  const runtime = path.join(sdk, "lib/macOS/libndi.dylib");
  const notices = path.join(sdk, "lib/macOS/libndi_licenses.txt");
  const [version, runtimeBytes, noticesBytes, licenseBytes] = await Promise.all([
    readFile(path.join(sdk, "Version.txt"), "utf8"), readFile(runtime), readFile(notices), readFile(path.join(sdk, "NDI SDK License Agreement.pdf")),
  ]);
  if (version.trim() !== approved.sdkVersionText) throw new Error("NDI SDK version changed. Review its license and update the approved runtime manifest before bundling.");
  for (const [label, bytes, hash] of [["runtime", runtimeBytes, approved.runtimeSha256], ["notices", noticesBytes, approved.noticesSha256], ["SDK license", licenseBytes, approved.sdkLicenseSha256]]) {
    if (digest(bytes) !== hash) throw new Error(`NDI ${label} checksum differs from the approved standard SDK. No bundle was prepared.`);
  }
  verifySignature(runtime);
  // Only these two vendor files are distributable payloads here. No SDK
  // headers, examples, Tools, Adobe plugin, or global runtime installer.
  await mkdir(staging, { recursive: true });
  const stagedRuntime = path.join(staging, "libndi.dylib");
  const stagedNotices = path.join(staging, "libndi_licenses.txt");
  await copyFile(runtime, stagedRuntime); await chmod(stagedRuntime, 0o755);
  await copyFile(notices, stagedNotices);
  if (digest(await readFile(stagedRuntime)) !== approved.runtimeSha256 || digest(await readFile(stagedNotices)) !== approved.noticesSha256) {
    throw new Error("The NDI input changed during staging. Refusing to create a bundle configuration.");
  }
  const provenance = path.join(staging, "ndi-runtime-provenance.json");
  await writeFile(provenance, JSON.stringify(approved, null, 2) + "\n");
  const config = path.join(staging, "tauri.ndi.conf.json");
  await writeFile(config, JSON.stringify({ bundle: {
    macOS: { frameworks: [stagedRuntime] },
    resources: {
      [stagedNotices]: "licenses/libndi_licenses.txt",
      [provenance]: "licenses/ndi-runtime-provenance.json",
      [path.join(root, "licenses/NDI-RUNTIME-TERMS.txt")]: "licenses/NDI-RUNTIME-TERMS.txt",
    },
  } }, null, 2) + "\n");
  return config;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(await prepareNdiBundle({ sdk: process.env.SAUCE_NDI_SDK_DIR })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
