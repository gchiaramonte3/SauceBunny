// Freeze helper-owned source before compilation. This records source association,
// not a claim of reproducible binaries or distribution clearance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const helperSourceScripts = Object.freeze([
  'build-obs-core.sh', 'build-obs-probe.sh', 'check-obs-core.sh',
  'inspect-obs-runtime.mjs', 'obs-source-inputs.mjs', 'sign-obs-runtime.mjs',
  'snapshot-obs-source.mjs', 'stable-signing.sh', 'stage-obs-runtime.mjs',
  'verify-obs-owner.mjs', 'verify-obs-probe.mjs',
].map(file => `scripts/${file}`).sort());
export const helperBuildComponents = Object.freeze([
  'MacOS/obs-capture-config-tests', 'MacOS/saucebunny-obs-audio-buffer-tests',
  'MacOS/saucebunny-obs-capture-health-tests', 'MacOS/saucebunny-obs-capture-overlap-probe',
  'MacOS/saucebunny-obs-capture-probe', 'MacOS/saucebunny-obs-capture-service',
  'MacOS/saucebunny-obs-capture-worker', 'MacOS/saucebunny-obs-media-probe',
  'MacOS/saucebunny-obs-media-worker', 'MacOS/saucebunny-obs-probe',
  'MacOS/saucebunny-obs-window-probe',
  'PlugIns/sauce-obs-capture.plugin/Contents/MacOS/sauce-obs-capture',
].sort());
export const captureSourcePaths = Object.freeze([
  'mac-sck-common.h', 'mac-sck-common.m', 'mac-sck-video-capture.m', 'window-utils.h', 'window-utils.m',
].map(file => `source/mac-capture/${file}`));
const manifestName = 'helper-source-manifest.json';
const limits = { files: 1024, entries: 2048, fileBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, depth: 16 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ordered = values => [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
const below = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const canonicalFiles = files => files.map(({ path: name, sha256, size, mode }) => ({ path: name, sha256, size, mode }));
const sourceManifest = files => ({ schema: 1, files, snapshotSha256: digest(JSON.stringify(files)) });

function absolute(value) {
  assert(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value &&
    !value.includes('\0'), 'Expected a normalized absolute path');
  return value;
}

function realDirectory(value) {
  absolute(value);
  assert(lstatSync(value).isDirectory() && realpathSync(value) === value, 'Directory must not be an alias');
  return value;
}

function portableName(name) {
  assert(/^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..', 'Unsafe source file name');
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

function regularFile(file, maximum = limits.fileBytes, text = true) {
  assert(realpathSync(file) === file, 'Source file path must not be an alias');
  const initial = lstatSync(file, { bigint: true });
  assert(initial.isFile() && initial.nlink === 1n && !(initial.mode & 0o7000n), 'Source must be an unaliased regular file');
  assert(initial.size <= BigInt(maximum), 'Source file exceeds size limit');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert(sameFile(initial, fstatSync(descriptor, { bigint: true })), 'Source changed before reading');
    const bytes = readFileSync(descriptor);
    assert(bytes.length <= maximum && sameFile(initial, fstatSync(descriptor, { bigint: true })) &&
      sameFile(initial, lstatSync(file, { bigint: true })) && realpathSync(file) === file, 'Source changed while reading');
    if (text) {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assert(!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content), 'Source must contain text, not binary data');
    }
    return { bytes, size: bytes.length, mode: Number(initial.mode & 0o777n), sha256: digest(bytes) };
  } finally { closeSync(descriptor); }
}

function enumerate(root, snapshot = false) {
  realDirectory(root);
  const records = [];
  const directories = [];
  const names = new Set();
  let count = 0; let total = 0;
  function visit(relative, depth = 0) {
    assert(depth <= limits.depth && ++count <= limits.entries, 'Source tree exceeds entry/depth limit');
    relative.split('/').forEach(portableName);
    assert(!names.has(relative.toLowerCase()), 'Source path alias');
    names.add(relative.toLowerCase());
    const location = path.join(root, relative);
    const stat = lstatSync(location);
    if (stat.isDirectory()) {
      assert(realpathSync(location) === location, 'Source directory alias');
      directories.push(relative);
      const children = ordered(readdirSync(location));
      assert(children.length > 0, 'Empty source directories are not supported');
      for (const child of children) visit(`${relative}/${child}`, depth + 1);
      return;
    }
    assert(stat.isFile(), 'Source links and special files are forbidden');
    const data = regularFile(location);
    assert(records.length < limits.files && (total += data.size) <= limits.totalBytes, 'Source exceeds file/byte limit');
    records.push({ path: relative, ...data });
  }
  if (snapshot) {
    const top = ordered(readdirSync(root));
    assert(JSON.stringify(top) === JSON.stringify([manifestName, 'obs-sidecar', 'scripts']), 'Unexpected snapshot contents');
    visit('obs-sidecar'); visit('scripts');
  } else {
    visit('obs-sidecar');
    realDirectory(path.join(root, 'scripts'));
    for (const name of helperSourceScripts) visit(name);
  }
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assert(records.some(record => record.path.startsWith('obs-sidecar/')), 'Missing helper source');
  assert(JSON.stringify(records.filter(record => record.path.startsWith('scripts/')).map(record => record.path)) ===
    JSON.stringify(helperSourceScripts), 'Unexpected or missing helper script');
  return { records, directories };
}

function validateManifest(record) {
  assert(record && record.schema === 1 && Array.isArray(record.files) && record.files.length <= limits.files &&
    JSON.stringify(ordered(Object.keys(record))) === JSON.stringify(['files', 'schema', 'snapshotSha256']), 'Invalid helper source manifest');
  for (const file of record.files) {
    assert(file && JSON.stringify(ordered(Object.keys(file))) === JSON.stringify(['mode', 'path', 'sha256', 'size']) &&
      typeof file.path === 'string' && /^(obs-sidecar|scripts)\//.test(file.path) &&
      /^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.size) && file.size >= 0 &&
      file.size <= limits.fileBytes && Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777,
    'Invalid helper source file record');
    file.path.split('/').forEach(portableName);
  }
  const files = canonicalFiles(record.files);
  assert(JSON.stringify(files.map(file => file.path)) === JSON.stringify(ordered(new Set(files.map(file => file.path)))) &&
    files.reduce((total, file) => total + file.size, 0) <= limits.totalBytes, 'Unsorted, duplicate or oversized helper manifest');
  assert(record.snapshotSha256 === digest(JSON.stringify(files)), 'Helper source manifest digest mismatch');
  return sourceManifest(files);
}

export function verifyHelperSource(directory) {
  realDirectory(directory);
  const recorded = validateManifest(JSON.parse(regularFile(path.join(directory, manifestName)).bytes.toString('utf8')));
  const observed = sourceManifest(canonicalFiles(enumerate(directory, true).records));
  assert(JSON.stringify(recorded) === JSON.stringify(observed), 'Helper source snapshot files changed or do not match manifest');
  return observed;
}

export function helperSourceDestination(projectRoot, newDestination) {
  realDirectory(projectRoot); absolute(newDestination);
  realDirectory(path.dirname(newDestination));
  assert(!below(path.join(projectRoot, 'obs-sidecar'), newDestination) &&
    !below(path.join(projectRoot, 'scripts'), newDestination), 'Snapshot destination must be outside selected sources');
  let exists = true;
  try { lstatSync(newDestination); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  assert(!exists, 'Snapshot destination already exists');
  return newDestination;
}

export function snapshotHelperSource(projectRoot, newDestination) {
  helperSourceDestination(projectRoot, newDestination);
  const { records } = enumerate(projectRoot);
  // Non-recursive mkdir is exclusive, including dangling links. No existing path is overwritten.
  mkdirSync(newDestination, { mode: 0o700 });
  for (const record of records) {
    const target = path.join(newDestination, record.path);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, record.mode);
    try { writeFileSync(descriptor, record.bytes); fchmodSync(descriptor, record.mode); }
    finally { closeSync(descriptor); }
  }
  const manifest = sourceManifest(canonicalFiles(records));
  assert(JSON.stringify(manifest.files) === JSON.stringify(canonicalFiles(enumerate(projectRoot).records)),
    'Helper source changed during snapshot');
  writeFileSync(path.join(newDestination, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  assert.deepEqual(verifyHelperSource(newDestination), manifest, 'Copied source failed verification');
  return manifest;
}

export function parseHelperUUID(output) {
  const lines = output.trim().split('\n');
  assert(lines.length === 1, 'Expected exactly one arm64 Mach-O UUID');
  const match = lines[0].match(/^UUID: ([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}) \(arm64\) .+$/);
  assert(match, 'Expected exactly one arm64 Mach-O UUID');
  return match[1].toUpperCase();
}

function observeHelperUUIDs(runtime) {
  realDirectory(runtime);
  assert.deepEqual(ordered(readdirSync(path.join(runtime, 'MacOS'))),
    helperBuildComponents.filter(file => file.startsWith('MacOS/')).map(file => path.basename(file)), 'Unexpected helper executable set');
  return helperBuildComponents.map(file => {
    const location = path.join(runtime, file);
    const stat = lstatSync(location, { bigint: true });
    assert(stat.isFile() && stat.nlink === 1n && realpathSync(location) === location, 'Helper executable must not be aliased');
    const uuid = parseHelperUUID(execFileSync('/usr/bin/dwarfdump', ['--uuid', location],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }));
    assert(sameFile(stat, lstatSync(location, { bigint: true })), 'Helper executable changed during UUID inspection');
    return { path: file, uuid };
  });
}

function validateCaptureSourceFiles(files) {
  assert(Array.isArray(files) && files.length === captureSourcePaths.length, 'Incomplete capture source files');
  files.forEach((file, index) => {
    assert(file && JSON.stringify(ordered(Object.keys(file))) === JSON.stringify(['mode', 'path', 'sha256', 'size']) &&
      file.path === captureSourcePaths[index] && /^[0-9a-f]{64}$/.test(file.sha256) &&
      Number.isSafeInteger(file.size) && file.size > 0 && file.size <= limits.fileBytes &&
      Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, 'Invalid capture source file');
  });
  return files;
}

export function observeCaptureSourceFiles(runtime) {
  const directory = realDirectory(path.join(realDirectory(runtime), 'source/mac-capture'));
  const expected = captureSourcePaths.map(file => path.basename(file));
  const entries = ordered(readdirSync(directory));
  const primary = [];
  for (const file of entries) {
    if (expected.includes(file)) primary.push(file);
    else assert(file.endsWith('.orig') && expected.includes(file.slice(0, -5)), 'Unexpected capture source file');
    const info = lstatSync(path.join(directory, file));
    assert(info.isFile() && info.nlink === 1, 'Capture sources and backups must be unaliased regular files');
  }
  assert.deepEqual(primary, expected, 'Missing capture source file');
  return validateCaptureSourceFiles(canonicalFiles(captureSourcePaths.map(file => ({ path: file,
    ...regularFile(path.join(runtime, file)) }))));
}

function helperInputs(runtime, snapshot = verifyHelperSource(path.join(realDirectory(runtime), 'source/helper'))) {
  return { schema: 1, helperSourceSha256: snapshot.snapshotSha256,
    coreBuildInputsSha256: regularFile(path.join(runtime, 'source/core-build-inputs.json')).sha256,
    captureSourceFiles: observeCaptureSourceFiles(runtime) };
}

function preparedHelperInputs(runtime) {
  return JSON.parse(regularFile(path.join(runtime, 'source/helper-build-prepared.json')).bytes.toString('utf8'));
}

export function prepareHelperBuild(runtime) {
  const prepared = helperInputs(runtime);
  writeFileSync(path.join(runtime, 'source/helper-build-prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 });
  assert.deepEqual(helperInputs(runtime), prepared, 'Helper inputs changed during preparation');
  return prepared;
}

export function validateHelperBuild(record, snapshot, observedUUIDs, coreBuildInputsSha256, captureSourceFiles) {
  validateManifest(snapshot);
  assert(/^[0-9a-f]{64}$/.test(coreBuildInputsSha256) && record &&
    JSON.stringify(ordered(Object.keys(record))) === JSON.stringify(['captureSourceFiles', 'components', 'coreBuildInputsSha256', 'helperSourceSha256', 'schema']) &&
    record.coreBuildInputsSha256 === coreBuildInputsSha256 &&
    record.schema === 1 && record.helperSourceSha256 === snapshot.snapshotSha256 && Array.isArray(record.components),
  'Invalid helper build source association');
  assert(Array.isArray(observedUUIDs) && observedUUIDs.length === helperBuildComponents.length, 'Incomplete observed helper UUIDs');
  for (const collection of [record.components, observedUUIDs]) {
    assert(collection.length === helperBuildComponents.length, 'Incomplete helper build components');
    collection.forEach((component, index) => {
      assert(component && JSON.stringify(ordered(Object.keys(component))) === JSON.stringify(['path', 'uuid']) &&
        component.path === helperBuildComponents[index] &&
        /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(component.uuid), 'Invalid helper build component');
    });
  }
  validateCaptureSourceFiles(record.captureSourceFiles);
  validateCaptureSourceFiles(captureSourceFiles);
  assert.deepEqual(record.captureSourceFiles, captureSourceFiles, 'Capture source files changed since compilation');
  assert.deepEqual(record.components, observedUUIDs, 'Helper build UUID association mismatch');
  return record;
}

export function recordHelperBuild(runtime) {
  const prepared = preparedHelperInputs(realDirectory(runtime));
  assert.deepEqual(helperInputs(runtime), prepared, 'Helper inputs changed since preparation');
  const record = { ...prepared, components: observeHelperUUIDs(runtime) };
  assert.deepEqual(helperInputs(runtime), prepared, 'Helper inputs changed during build recording');
  writeFileSync(path.join(runtime, 'source/helper-build.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return verifyHelperBuild(runtime);
}

export function verifyHelperBuild(runtime) {
  realDirectory(runtime);
  const snapshot = verifyHelperSource(path.join(runtime, 'source/helper'));
  const inputs = helperInputs(runtime, snapshot);
  assert.deepEqual(inputs, preparedHelperInputs(runtime), 'Helper inputs changed since preparation');
  const record = JSON.parse(regularFile(path.join(runtime, 'source/helper-build.json')).bytes.toString('utf8'));
  return validateHelperBuild(record, snapshot, observeHelperUUIDs(runtime),
    inputs.coreBuildInputsSha256, inputs.captureSourceFiles);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2);
    assert(extra.length === 0 && first && ((['snapshot', 'validate-destination'].includes(command) && second) ||
      (['verify', 'prepare-build', 'record-build', 'verify-build'].includes(command) && !second)),
    'usage: snapshot-obs-source.mjs snapshot|validate-destination <project-root> <new-destination> | verify <snapshot> | prepare-build|record-build|verify-build <runtime>');
    const result = command === 'validate-destination' ? helperSourceDestination(first, second) :
      command === 'snapshot' ? snapshotHelperSource(first, second) : command === 'verify' ? verifyHelperSource(first) :
      command === 'prepare-build' ? prepareHelperBuild(first) : command === 'record-build' ? recordHelperBuild(first) : verifyHelperBuild(first);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
