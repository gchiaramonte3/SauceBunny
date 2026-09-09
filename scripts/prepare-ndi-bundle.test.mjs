import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareNdiBundle } from "./prepare-ndi-bundle.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "sauce-ndi-packaging-test-"));
  const sdk = path.join(dir, "SDK"), staging = path.join(dir, "staged");
  await mkdir(path.join(sdk, "lib/macOS"), { recursive: true });
  await writeFile(path.join(sdk, "Version.txt"), "test version\n");
  await writeFile(path.join(sdk, "lib/macOS/libndi.dylib"), "runtime fixture");
  await writeFile(path.join(sdk, "lib/macOS/libndi_licenses.txt"), "vendor notices fixture");
  await writeFile(path.join(sdk, "NDI SDK License Agreement.pdf"), "license fixture");
  const approved = { sdkVersionText: "test version", runtimeSha256: hash("runtime fixture"), noticesSha256: hash("vendor notices fixture"), sdkLicenseSha256: hash("license fixture") };
  return { sdk, staging, approved, verifySignature: () => {} };
}
test("requires an explicit absolute developer SDK path", async () => {
  await assert.rejects(prepareNdiBundle({}), /absolute NDI SDK/);
  await assert.rejects(prepareNdiBundle({ sdk: "relative" }), /absolute NDI SDK/);
});
test("stages only the designated runtime and notices with scoped terms", async () => {
  const opts = await fixture();
  const config = JSON.parse(await readFile(await prepareNdiBundle(opts), "utf8"));
  assert.deepEqual(await readdir(opts.staging), ["libndi.dylib", "libndi_licenses.txt", "ndi-runtime-provenance.json", "tauri.ndi.conf.json"]);
  assert.deepEqual(config.bundle.macOS.frameworks, [path.join(opts.staging, "libndi.dylib")]);
  assert.deepEqual(Object.values(config.bundle.resources).sort(), ["licenses/NDI-RUNTIME-TERMS.txt", "licenses/libndi_licenses.txt", "licenses/ndi-runtime-provenance.json"]);
  assert.equal(await readFile(path.join(opts.staging, "libndi.dylib"), "utf8"), "runtime fixture");
});
for (const [file, error] of [["lib/macOS/libndi.dylib", /runtime checksum/], ["lib/macOS/libndi_licenses.txt", /notices checksum/], ["NDI SDK License Agreement.pdf", /SDK license checksum/], ["Version.txt", /version changed/]]) {
  test(`rejects changed ${file} before staging`, async () => {
    const opts = await fixture(); await writeFile(path.join(opts.sdk, file), "unexpected input");
    await assert.rejects(prepareNdiBundle(opts), error);
    await assert.rejects(access(opts.staging));
  });
}
test("a signature failure is not bypassed even when all checksums match", async () => {
  const opts = await fixture(); opts.verifySignature = () => { throw new Error("signature verification failed"); };
  await assert.rejects(prepareNdiBundle(opts), /signature verification failed/);
  await assert.rejects(access(opts.staging));
});
