import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyNdiPackage } from "./verify-ndi-package.mjs";

async function fixture(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sauce-ndi-package-verifier-"));
  const app = path.join(dir, "Sauce Bunny.app");
  const licenses = path.join(app, "Contents/Resources/licenses");
  const runtime = path.join(app, "Contents/Frameworks/libndi.dylib");
  await mkdir(licenses, { recursive: true });
  await mkdir(path.dirname(runtime), { recursive: true });
  await mkdir(path.join(app, "Contents/MacOS"));
  const approvedManifest = { version: "fixture", noticesSha256: createHash("sha256").update("vendor notices").digest("hex"), uuids: { arm64: "ABCD-1234" } };
  await writeFile(runtime, "fixture runtime");
  await writeFile(path.join(licenses, "ndi-runtime-provenance.json"), JSON.stringify(approvedManifest));
  await writeFile(path.join(licenses, "libndi_licenses.txt"), "vendor notices");
  await writeFile(path.join(licenses, "NDI-RUNTIME-TERMS.txt"), await readFile(new URL("../licenses/NDI-RUNTIME-TERMS.txt", import.meta.url)));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (overrides[command]) return overrides[command](args);
    if (command === "dwarfdump") return "UUID: ABCD-1234 (arm64) fixture";
    if (command === "otool") return "fixture:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1)";
    if (command === "strings") return "NDI runtime could not be loaded";
    return "";
  };
  return { app, licenses, runtime, calls, options: { approvedManifest, run } };
}

test("accepts a complete isolated package and runs signature/build/dependency/bridge checks", async () => {
  const f = await fixture();
  assert.deepEqual(await verifyNdiPackage(f.app, f.options), { version: "fixture", architectures: ["arm64"] });
  assert.deepEqual(f.calls.map(([command]) => command), ["codesign", "dwarfdump", "otool", "otool", "strings"]);
});
for (const file of ["ndi-runtime-provenance.json", "libndi_licenses.txt", "NDI-RUNTIME-TERMS.txt"]) {
  test(`rejects altered ${file}`, async () => {
    const f = await fixture(); await writeFile(path.join(f.licenses, file), "{}");
    await assert.rejects(verifyNdiPackage(f.app, f.options), /provenance|notices|terms/);
    assert.equal(f.calls.length, 0);
  });
}
for (const file of ["NDIToolsInstaller.pkg", "NDI_Transmit_AdobeCC.bundle", "Processing.NDI.Lib.h", "libndi_advanced.dylib"]) {
  test(`rejects accidentally bundled ${file}`, async () => {
    const f = await fixture(); await writeFile(path.join(f.app, "Contents/Resources", file), "forbidden fixture");
    await assert.rejects(verifyNdiPackage(f.app, f.options), /Forbidden|exactly one/);
  });
}
test("rejects a runtime symlink even when its target exists", async () => {
  const f = await fixture(), external = path.join(path.dirname(f.app), "external.dylib");
  await rename(f.runtime, external); await symlink(external, f.runtime);
  await assert.rejects(verifyNdiPackage(f.app, f.options), /external symlink/);
});
test("does not waive a nested runtime signature failure", async () => {
  const f = await fixture({ codesign: () => { throw new Error("invalid signature"); } });
  await assert.rejects(verifyNdiPackage(f.app, f.options), /invalid signature/);
});
test("rejects a different runtime build", async () => {
  const f = await fixture({ dwarfdump: () => "UUID: ABCD-9999 (arm64) fixture" });
  await assert.rejects(verifyNdiPackage(f.app, f.options), /approved runtime/);
});
test("rejects developer SDK dependencies", async () => {
  const f = await fixture({ otool: () => "fixture:\n\t/Library/NDI SDK for Apple/lib/macOS/libndi.dylib (compatibility version 1)" });
  await assert.rejects(verifyNdiPackage(f.app, f.options), /external dependency/);
});
test("rejects launch-time app linkage to the runtime", async () => {
  const f = await fixture({ otool: args => args[1].endsWith("sauce-bunny") ? "fixture:\n\t@rpath/libndi.dylib (compatibility version 1)" : "fixture:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1)" });
  await assert.rejects(verifyNdiPackage(f.app, f.options), /not link it at launch/);
});
test("rejects a build without the native bridge", async () => {
  const f = await fixture({ strings: () => "SDK-free fixture" });
  await assert.rejects(verifyNdiPackage(f.app, f.options), /bridge is absent/);
});
