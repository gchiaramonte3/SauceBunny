import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureSourcePaths, helperBuildComponents, helperSourceDestination, helperSourceScripts, observeCaptureSourceFiles,
  parseHelperUUID, prepareHelperBuild, recordHelperBuild, snapshotHelperSource,
  validateHelperBuild, verifyHelperBuild, verifyHelperSource } from './snapshot-obs-source.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-obs-source-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'obs-sidecar/include'), { recursive: true });
  mkdirSync(path.join(project, 'scripts'));
  writeFileSync(path.join(project, 'obs-sidecar/engine.mm'), '// fixture source\n');
  writeFileSync(path.join(project, 'obs-sidecar/include/obsconfig.h'), '#define FIXTURE 1\n');
  for (const script of helperSourceScripts) writeFileSync(path.join(project, script), '// fixture recipe\n');
  chmodSync(path.join(project, helperSourceScripts[0]), 0o755);
  return { root, project, destination: path.join(root, 'snapshot') };
}

function rewriteManifest(directory, callback) {
  const location = path.join(directory, 'helper-source-manifest.json');
  const record = JSON.parse(readFileSync(location, 'utf8'));
  callback(record);
  writeFileSync(location, JSON.stringify(record));
}

test('snapshot is deterministic, complete and independent of later checkout edits', t => {
  const { root, project, destination } = fixture(t);
  assert.equal(helperSourceDestination(project, destination), destination);
  writeFileSync(path.join(project, 'scripts/unrelated.mjs'), 'not selected\n');
  const first = snapshotHelperSource(project, destination);
  const second = snapshotHelperSource(project, path.join(root, 'second'));
  assert.deepEqual(first, second);
  assert.deepEqual(verifyHelperSource(destination), first);
  assert.equal(first.schema, 1);
  assert.equal(first.snapshotSha256, createHash('sha256').update(JSON.stringify(first.files)).digest('hex'));
  assert.deepEqual(first.files.map(file => file.path), [...first.files.map(file => file.path)].sort());
  assert.equal(first.files.length, helperSourceScripts.length + 2);
  assert.equal(first.files.find(file => file.path === helperSourceScripts[0]).mode, 0o755);
  assert(!JSON.stringify(first).includes(project));
  writeFileSync(path.join(project, 'obs-sidecar/engine.mm'), '// checkout changed\n');
  assert.deepEqual(verifyHelperSource(destination), first);
  assert.notEqual(snapshotHelperSource(project, path.join(root, 'third')).snapshotSha256, first.snapshotSha256);
});

test('new destination is absolute, normalized, exclusive and outside source directories', t => {
  const { root, project, destination } = fixture(t);
  for (const target of ['relative', `${root}/sub/../snapshot`, project,
    path.join(project, 'obs-sidecar/new'), path.join(project, 'scripts/new')]) {
    assert.throws(() => snapshotHelperSource(project, target));
  }
  symlinkSync(root, path.join(root, 'alias'));
  assert.throws(() => snapshotHelperSource(project, path.join(root, 'alias/new')), /alias/);
  symlinkSync(path.join(root, 'absent'), destination);
  assert.throws(() => snapshotHelperSource(project, destination), /already exists/);
  rmSync(destination);
  snapshotHelperSource(project, destination);
  assert.throws(() => snapshotHelperSource(project, destination), /already exists/);
  assert.throws(() => snapshotHelperSource(path.join(root, 'alias/project'), path.join(root, 'second')), /alias/);
});

test('source links, hard links, special files, binaries and invalid names fail closed', t => {
  const { root, project, destination } = fixture(t);
  const target = path.join(project, 'obs-sidecar/extra.mm');
  symlinkSync('engine.mm', target);
  assert.throws(() => snapshotHelperSource(project, destination), /links/);
  rmSync(target);
  linkSync(path.join(project, 'obs-sidecar/engine.mm'), target);
  assert.throws(() => snapshotHelperSource(project, destination), /unaliased/);
  rmSync(target);
  execFileSync('/usr/bin/mkfifo', [target]);
  assert.throws(() => snapshotHelperSource(project, destination), /special/);
  rmSync(target);
  for (const data of [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), Buffer.from([0xff, 0xfe])]) {
    writeFileSync(target, data);
    assert.throws(() => snapshotHelperSource(project, destination));
  }
  rmSync(target);
  const invalid = path.join(project, 'obs-sidecar/escape\\name.mm');
  writeFileSync(invalid, 'source');
  assert.throws(() => snapshotHelperSource(project, destination), /Unsafe/);
  rmSync(invalid);
  mkdirSync(path.join(project, 'obs-sidecar/empty'));
  assert.throws(() => snapshotHelperSource(project, destination), /Empty/);
  assert(!readFileSync(path.join(project, 'obs-sidecar/engine.mm'), 'utf8').includes(root));
});

test('input file size and file count are bounded', t => {
  const { project, destination } = fixture(t);
  const oversized = path.join(project, 'obs-sidecar/large.mm');
  writeFileSync(oversized, 'a'.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => snapshotHelperSource(project, destination), /size limit/);
  rmSync(oversized);
  for (let index = 0; index < 1024; index++) writeFileSync(path.join(project, `obs-sidecar/input-${index}.h`), '');
  assert.throws(() => snapshotHelperSource(project, destination), /file\/byte limit/);
});

test('independent verification rejects file, mode, path and manifest tampering', t => {
  const { root, project, destination } = fixture(t);
  const original = snapshotHelperSource(project, destination);
  const source = path.join(destination, 'obs-sidecar/engine.mm');
  writeFileSync(source, '// modified\n');
  assert.throws(() => verifyHelperSource(destination), /changed/);
  writeFileSync(source, '// fixture source\n');
  chmodSync(source, 0o700);
  assert.throws(() => verifyHelperSource(destination), /changed/);
  chmodSync(source, original.files.find(file => file.path === 'obs-sidecar/engine.mm').mode);
  symlinkSync(destination, path.join(root, 'alias'));
  assert.throws(() => verifyHelperSource(path.join(root, 'alias')), /alias/);
  const extra = path.join(destination, 'obs-sidecar/extra.h');
  writeFileSync(extra, 'extra\n');
  assert.throws(() => verifyHelperSource(destination), /changed/);
  rmSync(extra);
  mkdirSync(path.join(destination, 'unexpected'));
  assert.throws(() => verifyHelperSource(destination), /Unexpected/);
  rmSync(path.join(destination, 'unexpected'), { recursive: true });
  rewriteManifest(destination, record => { record.snapshotSha256 = '0'.repeat(64); });
  assert.throws(() => verifyHelperSource(destination), /digest/);
  writeFileSync(path.join(destination, 'helper-source-manifest.json'), JSON.stringify(original));
  rewriteManifest(destination, record => { record.files[0].path = '../escape'; });
  assert.throws(() => verifyHelperSource(destination), /Invalid/);
});

test('copy-time source edits and copied-byte corruption both fail closed', t => {
  const { root, project, destination } = fixture(t);
  const originalChmod = fs.fchmodSync;
  let changed = false;
  const sourceChange = t.mock.method(fs, 'fchmodSync', (...args) => {
    originalChmod(...args);
    if (!changed) {
      changed = true;
      writeFileSync(path.join(project, 'obs-sidecar/engine.mm'), '// source changed during copy\n');
    }
  });
  syncBuiltinESMExports();
  try { assert.throws(() => snapshotHelperSource(project, destination), /changed during snapshot/); }
  finally { sourceChange.mock.restore(); syncBuiltinESMExports(); }
  assert.throws(() => verifyHelperSource(destination), /ENOENT/);
  changed = false;
  const copyChange = t.mock.method(fs, 'fchmodSync', (...args) => {
    originalChmod(...args);
    if (!changed) {
      changed = true;
      fs.writeSync(args[0], Buffer.from('X'), 0, 1, 0);
    }
  });
  syncBuiltinESMExports();
  try { assert.throws(() => snapshotHelperSource(project, path.join(root, 'corrupted')), /changed or do not match/); }
  finally { copyChange.mock.restore(); syncBuiltinESMExports(); }
});

test('verification rejects undeclared scripts and linked manifests even with matching content', t => {
  const { root, project, destination } = fixture(t);
  snapshotHelperSource(project, destination);
  const extra = path.join(destination, 'scripts/undeclared.mjs');
  writeFileSync(extra, '// extra\n');
  assert.throws(() => verifyHelperSource(destination), /Unexpected or missing helper script/);
  rmSync(extra);
  const manifest = path.join(destination, 'helper-source-manifest.json');
  const copy = path.join(root, 'manifest.json');
  writeFileSync(copy, readFileSync(manifest));
  rmSync(manifest);
  symlinkSync(copy, manifest);
  assert.throws(() => verifyHelperSource(destination), /alias/);
});

const uuid = '12345678-1234-ABCD-5678-123456789ABC';
test('UUID parser accepts one arm64 image only and discards executable path', () => {
  assert.equal(parseHelperUUID(`UUID: ${uuid.toLowerCase()} (arm64) /private/example image\n`), uuid);
  for (const output of ['', `UUID: ${uuid} (x86_64) /example`, `UUID: ${uuid} (arm64) /one\nUUID: ${uuid} (arm64) /two`,
    `UUID: malformed (arm64) /image`]) assert.throws(() => parseHelperUUID(output), /exactly one arm64/);
});

test('build record validates source hash, core record hash and exact executable UUID set', t => {
  const { project, destination } = fixture(t);
  const snapshot = snapshotHelperSource(project, destination);
  const components = helperBuildComponents.map(file => ({ path: file, uuid }));
  const coreHash = 'b'.repeat(64);
  const captureSourceFiles = captureSourcePaths.map(file => ({ path: file, sha256: 'c'.repeat(64), size: 12, mode: 0o644 }));
  const record = { schema: 1, helperSourceSha256: snapshot.snapshotSha256, coreBuildInputsSha256: coreHash, captureSourceFiles, components };
  assert.deepEqual(validateHelperBuild(record, snapshot, components, coreHash, captureSourceFiles), record);
  for (const changed of [{ ...record, helperSourceSha256: 'a'.repeat(64) }, { ...record, coreBuildInputsSha256: 'a'.repeat(64) },
    { ...record, components: components.slice(1) }, { ...record, components: [...components].reverse() },
    { ...record, schema: 2 }, { ...record, compilerPath: '/private/compiler' }]) {
    assert.throws(() => validateHelperBuild(changed, snapshot, components, coreHash, captureSourceFiles));
  }
  const otherUUIDs = structuredClone(components);
  otherUUIDs[0].uuid = 'FFFFFFFF-1234-ABCD-5678-123456789ABC';
  assert.throws(() => validateHelperBuild(record, snapshot, otherUUIDs, coreHash, captureSourceFiles), /UUID association mismatch/);
  assert.throws(() => validateHelperBuild(record, snapshot, components, coreHash), /Incomplete capture/);
  const changedCapture = structuredClone(captureSourceFiles);
  changedCapture[0].sha256 = 'd'.repeat(64);
  assert.throws(() => validateHelperBuild(record, snapshot, components, coreHash, changedCapture), /changed since compilation/);
  assert.throws(() => validateHelperBuild(record, snapshot, components, coreHash, captureSourceFiles.slice(1)), /Incomplete capture/);
  assert.throws(() => verifyHelperBuild(project), /ENOENT/);
});

test('capture inputs are prepared before compilation and changed inputs cannot get a build record', t => {
  const { root, project } = fixture(t);
  const runtime = path.join(root, 'runtime');
  mkdirSync(path.join(runtime, 'source/mac-capture'), { recursive: true });
  snapshotHelperSource(project, path.join(runtime, 'source/helper'));
  writeFileSync(path.join(runtime, 'source/core-build-inputs.json'), '{"schema":1}\n');
  for (const file of captureSourcePaths) writeFileSync(path.join(runtime, file), '// transformed source\n');
  const backup = path.join(runtime, `${captureSourcePaths[0]}.orig`);
  writeFileSync(backup, '// original backup\n');
  assert.throws(() => recordHelperBuild(runtime), /ENOENT/);
  const observed = observeCaptureSourceFiles(runtime);
  assert.equal(observed.length, 5);
  assert(!observed.some(file => file.path.endsWith('.orig')));
  const prepared = prepareHelperBuild(runtime);
  assert.deepEqual(prepared.captureSourceFiles, observed);
  assert.throws(() => prepareHelperBuild(runtime), /EEXIST/);
  writeFileSync(backup, '// backup is not compiler input\n');
  assert.deepEqual(observeCaptureSourceFiles(runtime), observed);
  writeFileSync(path.join(runtime, captureSourcePaths[0]), '// changed after preparation\n');
  assert.throws(() => recordHelperBuild(runtime), /changed since preparation/);
  assert.throws(() => verifyHelperBuild(runtime), /changed since preparation/);
  writeFileSync(path.join(runtime, 'source/mac-capture/extra.m'), '// unexpected\n');
  assert.throws(() => observeCaptureSourceFiles(runtime), /Unexpected/);
  rmSync(path.join(runtime, 'source/mac-capture/extra.m'));
  rmSync(path.join(runtime, captureSourcePaths[1]));
  assert.throws(() => observeCaptureSourceFiles(runtime), /Missing/);
});

test('builder freezes before own inputs and verifies source and recipe before recording success', () => {
  const builder = readFileSync(new URL('./build-obs-probe.sh', import.meta.url), 'utf8');
  const freeze = builder.indexOf('project_root="$output_dir/source/helper"');
  assert(builder.indexOf('snapshot-obs-source.mjs" validate-destination') < builder.indexOf('mkdir "$output_dir"'));
  assert(freeze > builder.indexOf('snapshot-obs-source.mjs" snapshot'));
  assert(freeze < builder.indexOf('for patch_name in macos-no-global-input'));
  assert(freeze < builder.indexOf('check-obs-core.sh'));
  assert(freeze < builder.indexOf('--verify-core'));
  const prepare = builder.indexOf('snapshot-obs-source.mjs" prepare-build');
  assert(prepare > builder.indexOf('patch --batch --fuzz=0 -p1 -d "$capture_source"'));
  assert(prepare < builder.indexOf('clang -bundle'));
  assert(builder.includes('ditto "$core_build/core-build-inputs.json" "$output_dir/source/core-build-inputs.json"'));
  const record = builder.indexOf('snapshot-obs-source.mjs" record-build');
  assert(record > builder.indexOf('snapshot-obs-source.mjs" verify'));
  assert(record > builder.lastIndexOf('cmp "$original_build_script"', record));
  assert(record < builder.indexOf('inspect-obs-runtime.mjs'));
  assert(builder.lastIndexOf('cmp "$original_build_script"') > builder.indexOf('inspect-obs-runtime.mjs'));
  assert(!builder.includes('$original_project_root/obs-sidecar'));
  assert(!builder.includes('SAUCE_OBS_RUNTIME'));
  execFileSync('/bin/bash', ['-n', fileURLToPath(new URL('./build-obs-probe.sh', import.meta.url))]);
});

test('import performs no CLI work; malformed CLI invocation fails without artifacts', () => {
  const script = fileURLToPath(new URL('./snapshot-obs-source.mjs', import.meta.url));
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./snapshot-obs-source.mjs', import.meta.url).href)})`],
    { encoding: 'utf8' }), '');
  assert.throws(() => execFileSync(process.execPath, [script, 'unknown'], { stdio: 'pipe' }));
});
