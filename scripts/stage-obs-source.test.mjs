import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { copyMaterialFiles, materialFiles, sourceMaterialManifest, stageObsSourceMaterials,
  validateMaterialInventory, verifyObsSourceMaterials } from './stage-obs-source.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-obs-material-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'source'));
  mkdirSync(path.join(root, 'licenses'));
  writeFileSync(path.join(root, 'source/source.cpp'), '// preferred source\n');
  writeFileSync(path.join(root, 'licenses/COPYING'), 'test notice\n');
  writeFileSync(path.join(root, 'runtime-inventory.json'), '{}\n');
  return root;
}

test('enumerates content, permissions and exact resource paths without binaries', t => {
  const root = fixture(t);
  const files = materialFiles(root, ['source', 'licenses', 'runtime-inventory.json']);
  assert.deepEqual(files.map(file => file.path), ['licenses/COPYING', 'runtime-inventory.json', 'source/source.cpp']);
  assert(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  chmodSync(path.join(root, 'source/source.cpp'), 0o700);
  const next = materialFiles(root, ['source', 'licenses', 'runtime-inventory.json']);
  assert.equal(next.at(-1).mode, 0o700);
  assert.notDeepEqual(files, next);
  writeFileSync(path.join(root, 'source/extra.cpp'), '// extra\n');
  assert.equal(materialFiles(root, ['source']).length, 2);
});

for (const type of ['symlink', 'directory-link', 'hardlink', 'binary', 'invalid-utf8', 'special-mode', 'oversized']) {
  test(`rejects ${type} material instead of silently including or ignoring it`, t => {
    const root = fixture(t), file = path.join(root, 'source/bad');
    if (type === 'symlink') symlinkSync('../licenses/COPYING', file);
    if (type === 'directory-link') symlinkSync('../licenses', file);
    if (type === 'hardlink') linkSync(path.join(root, 'licenses/COPYING'), file);
    if (type === 'binary') writeFileSync(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]));
    if (type === 'invalid-utf8') writeFileSync(file, Buffer.from([0xff, 0xff]));
    if (type === 'special-mode') {
      writeFileSync(file, 'text'); chmodSync(file, 0o1755);
      assert.equal(fs.statSync(file).mode & 0o7000, 0o1000, 'Special mode fixture was not applied');
    }
    if (type === 'oversized') { writeFileSync(file, ''); truncateSync(file, 2 * 1024 * 1024 + 1); }
    assert.throws(() => materialFiles(root, ['source']));
  });
}

test('rejects empty directories and case aliases', t => {
  const root = fixture(t);
  mkdirSync(path.join(root, 'source/empty'));
  assert.throws(() => materialFiles(root, ['source']), /Empty material/);
  rmSync(path.join(root, 'source/empty'), { recursive: true });
  assert.throws(() => materialFiles(root, ['source', 'source']), /alias/);
});

test('does not present prebuilt archives as complete dependency source', t => {
  const root = fixture(t);
  const files = materialFiles(root, ['source', 'licenses']);
  const manifest = sourceMaterialManifest(files, { snapshot: { snapshotSha256: 'a'.repeat(64) } });
  assert.equal(manifest.distributionReady, false);
  assert.equal(manifest.internalOnly, true);
  assert.equal(manifest.coverage.dependencies, 'incomplete-prebuilt-inputs-only');
  assert.equal(manifest.coverage.rebuild, 'not-run');
  assert.equal(manifest.coverage.application, 'not-included');
  assert.match(manifest.inputs[1].role, /not-complete-source/);
  assert.notEqual(sourceMaterialManifest([...files].reverse(), { snapshot: { snapshotSha256: 'a'.repeat(64) } })
    .materialsSha256, manifest.materialsSha256);
  assert.throws(() => sourceMaterialManifest([], {}), /Empty/);
});

test('compares destination bytes to expected inputs before allowing a manifest', t => {
  const root = fixture(t), target = path.join(root, 'copied'); mkdirSync(target);
  const copies = materialFiles(root, ['source', 'licenses']).map(file => ({ file, from: path.join(root, file.path) }));
  const original = fs.fchmodSync;
  let corrupted = false;
  const change = t.mock.method(fs, 'fchmodSync', (...args) => {
    original(...args);
    if (!corrupted) { corrupted = true; fs.writeSync(args[0], Buffer.from('X'), 0, 1, 0); }
  });
  syncBuiltinESMExports();
  try { assert.throws(() => copyMaterialFiles(copies, target), /differs from expected input/); }
  finally { change.mock.restore(); syncBuiltinESMExports(); }
  assert(corrupted);
  assert.equal(existsSync(path.join(target, 'source-materials.json')), false);
});

test('offline inventory requires valid unique metadata and every recorded binary', () => {
  const component = { path: 'MacOS/helper', sha256: 'b'.repeat(64), architectures: ['arm64'], dependencies: [], rpaths: [] };
  const association = { core: { components: [] }, helper: { components: [{ path: component.path }] } };
  const inventory = { schema: 1, profile: 'diagnostic', internalOnly: true, distributionReady: false, components: [component] };
  assert.doesNotThrow(() => validateMaterialInventory(inventory, association));
  for (const components of [[], [component, component], [{ ...component, sha256: 'invalid' }],
    [{ ...component, path: 'MacOS/other' }], [{ ...component, architectures: ['x86_64'] }],
    [{ ...component, dependencies: ['/opt/homebrew/lib/untrusted.dylib'] }]]) {
    assert.throws(() => validateMaterialInventory({ ...inventory, components }, association));
  }
});

test('refuses old runtime without a frozen source snapshot before creating output', t => {
  const root = fixture(t), destination = path.join(path.dirname(root), `${path.basename(root)}-output`);
  assert.throws(() => stageObsSourceMaterials(root, 'missing.tar.gz', 'missing.tar.xz', destination));
  assert.equal(existsSync(destination), false);
});

test('refuses existing and nested destinations without inspecting executable code', t => {
  const root = fixture(t);
  assert.throws(() => stageObsSourceMaterials(root, '', '', root), /outside/);
  assert.throws(() => stageObsSourceMaterials(root, '', '', path.join(root, 'new')), /outside/);
  assert.throws(() => stageObsSourceMaterials(root, '', '', path.dirname(root)), /already exists/);
});

test('offline verifier rejects extra package files before reading records', t => {
  const root = fixture(t);
  assert.throws(() => verifyObsSourceMaterials(root), /Unexpected source package/);
});

const runtime = process.env.SAUCE_OBS_SOURCE_TEST_RUNTIME;
const source = process.env.SAUCE_OBS_SOURCE_TEST_ARCHIVE;
const deps = process.env.SAUCE_OBS_SOURCE_TEST_DEPS;
test('native source association stages pinned materials and rejects offline tampering', {
  skip: !(runtime && source && deps), timeout: 120000,
}, t => {
  const root = fixture(t), destination = path.join(root, 'materials');
  const report = stageObsSourceMaterials(runtime, source, deps, destination);
  assert(report.files > 100);
  assert.equal(report.distributionReady, false);
  assert.equal(report.dependencySources, 'incomplete');
  assert.equal(report.rebuild, 'not-run');
  assert.equal(verifyObsSourceMaterials(destination).helperSourceSha256, report.helperSourceSha256);
  const notice = path.join(destination, 'licenses/OBS-COPYING');
  const original = readFileSync(notice);
  writeFileSync(notice, 'tampered notice');
  assert.throws(() => verifyObsSourceMaterials(destination), /manifest mismatch/);
  writeFileSync(notice, original);
  const manifest = path.join(destination, 'source-materials.json');
  const record = JSON.parse(readFileSync(manifest)); record.distributionReady = true;
  writeFileSync(manifest, JSON.stringify(record));
  assert.throws(() => verifyObsSourceMaterials(destination), /manifest mismatch/);
  cpSync(path.join(runtime, 'source/helper/obs-sidecar'), path.join(destination, 'extra'), { recursive: true });
  assert.throws(() => verifyObsSourceMaterials(destination), /Unexpected/);
});
