// Internal source-material staging. Does not build, run, sign, install or publish.
// A recorded source association is not proof of reproducible binaries or GPL clearance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectRuntime, localDependency, validateCodeClosure } from './inspect-obs-runtime.mjs';
import { stagingDestination, validateSourceInventory } from './stage-obs-runtime.mjs';
import { hashRegularFile, pinnedInputs, validatePinnedArchives, validateCoreBuild } from './obs-source-inputs.mjs';
import { observeCaptureSourceFiles, parseHelperUUID, validateHelperBuild, verifyHelperBuild,
  verifyHelperSource } from './snapshot-obs-source.mjs';

const manifestName = 'source-materials.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sort = values => [...values].sort();
const archiveNames = pinnedInputs.map(input => `upstream/${input.file}`);
const limits = { entries: 4096, files: 2048, depth: 20, text: 2 * 1024 * 1024,
  archive: 128 * 1024 * 1024, total: 256 * 1024 * 1024 };
const coverage = Object.freeze({ helper: 'frozen-build-inputs', obs: 'pinned-source-and-patches',
  dependencies: 'incomplete-prebuilt-inputs-only', application: 'not-included',
  rebuild: 'not-run', binaryAssociation: 'recorded-UUIDs-not-reproducible-build-proof' });

const instructions = `# OBS helper source materials (internal only)

Not a distribution-ready corresponding-source package.

The helper source was frozen before compilation. Core/helper records associate
those inputs with Mach-O UUIDs. These records and file hashes detect drift; they
do not establish byte-for-byte reproducibility, source authenticity or licensing
clearance. The runtime inventory describes the binary inspected when staging;
this package contains no runnable helper and cannot re-inspect that binary.

The OBS source archive and dependency input archive are checksum-pinned. The
dependency archive contains PREBUILT libraries/headers/notices, not their complete
preferred-form sources and build recipes. Supplied notices are retained without
claiming their completeness. Sauce Bunny application source is not included.
Complete dependency source/build materials, licensing review and final release
verification remain mandatory. Do not distribute this package as complete source.

## Rebuilding the helper locally

On Apple Silicon macOS 14 or later, install Xcode command-line tools, Node 20.19+
and CMake 3.28+. From this directory, choose two new absolute output directories:

\x60\x60\x60sh
bash source/helper/scripts/build-obs-core.sh upstream/obs-source.tar.gz upstream/obs-deps-2026-07-15-universal.tar.xz /new/absolute/core
bash source/helper/scripts/build-obs-probe.sh /new/absolute/core /new/absolute/runtime
\x60\x60\x60

These recipes use the archived inputs; they do not fetch OBS or dependencies.
Toolchain versions used for the recorded build are in source/core-build-inputs.json.
The packager does not execute these recipes: rebuild status remains not-run.
Signing is a separate local step and can change executable hashes while retaining
UUIDs. No signing keys, pairing credentials, user media, or project paths belong
in this package. No capture, room connection or NDI broadcast is performed.
`;

function directory(value) {
  assert(typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value &&
    lstatSync(value).isDirectory() && realpathSync(value) === value, 'Expected a real normalized directory');
  return value;
}
function portable(relative) {
  assert(relative.split('/').every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..'),
    'Unsafe material path');
}
function readVerified(file, record) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    assert(stat.isFile() && stat.nlink === 1 && stat.size === record.size &&
      (stat.mode & 0o7777) === record.mode, 'Material changed before copy');
    const bytes = readFileSync(descriptor);
    assert(bytes.length === record.size && hash(bytes) === record.sha256, 'Material bytes changed while reading');
    return bytes;
  } finally { closeSync(descriptor); }
}

// Independent exact-set enumeration: a manifest cannot hide extra files or links.
export function materialFiles(root, units, { archives = false } = {}) {
  directory(root);
  let entries = 0; let total = 0;
  const files = []; const names = new Set();
  function visit(relative, depth = 0) {
    portable(relative);
    assert(depth <= limits.depth && ++entries <= limits.entries, 'Material tree exceeds bounds');
    assert(!names.has(relative.toLowerCase()), 'Material path alias'); names.add(relative.toLowerCase());
    const file = path.join(root, relative), stat = lstatSync(file);
    assert(realpathSync(file) === file, 'Material links are forbidden');
    if (stat.isDirectory()) {
      const children = sort(readdirSync(file));
      assert(children.length > 0, 'Empty material directory');
      children.forEach(name => visit(`${relative}/${name}`, depth + 1));
      return;
    }
    assert(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o7000), 'Material must be an unaliased regular file');
    const binary = archives && archiveNames.includes(relative);
    assert(stat.size <= (binary ? limits.archive : limits.text) &&
      (total += stat.size) <= limits.total && files.length < limits.files, 'Material files exceed bounds');
    const record = { path: relative, ...hashRegularFile(file, binary ? limits.archive : limits.text) };
    if (!binary) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(readVerified(file, record));
      assert(!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text), 'Material must be text, not binary code');
    }
    files.push(record);
  }
  units.forEach(unit => visit(unit));
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function json(root, relative) {
  const [record] = materialFiles(root, [relative]);
  return JSON.parse(readVerified(path.join(root, relative), record).toString('utf8'));
}

export function verifyMaterialAssociation(root) {
  const snapshot = verifyHelperSource(path.join(root, 'source/helper'));
  const core = validateCoreBuild(json(root, 'source/core-build-inputs.json'));
  const helper = json(root, 'source/helper-build.json');
  validateHelperBuild(helper, snapshot, helper.components,
    hashRegularFile(path.join(root, 'source/core-build-inputs.json')).sha256, observeCaptureSourceFiles(root));
  const byPath = new Map(snapshot.files.map(file => [file.path, file]));
  for (const file of core.recipeFiles) {
    assert.deepEqual(byPath.get(file.path), file, 'Core recipe differs from packaged helper source');
  }
  for (const patch of core.patches) {
    const observed = hashRegularFile(path.join(root, 'source/core-patches', path.basename(patch.path)));
    assert.deepEqual({ path: patch.path, ...observed }, patch, 'Core patch differs from its build record');
  }
  return { snapshot, core, helper };
}

export function sourceMaterialManifest(files, association) {
  assert(files.length > 0, 'Empty source material set');
  return { schema: 1, kind: 'obs-helper-source-materials', internalOnly: true,
    distributionReady: false, coverage: { ...coverage },
    helperSourceSha256: association.snapshot.snapshotSha256,
    inputs: pinnedInputs, files, materialsSha256: hash(JSON.stringify(files)) };
}

export function validateMaterialInventory(inventory, association) {
  validateSourceInventory(inventory, inventory); // Profile/flags, not binary verification.
  const required = [...association.core.components, ...association.helper.components].map(component => component.path);
  const names = new Set();
  for (const component of inventory.components) {
    assert(component && typeof component.path === 'string', 'Invalid recorded runtime component');
    portable(component.path);
    assert(/^(MacOS|Frameworks|PlugIns)\//.test(component.path) && !names.has(component.path.toLowerCase()),
      'Duplicate or invalid recorded runtime component path');
    names.add(component.path.toLowerCase());
    assert(/^[a-f0-9]{64}$/.test(component.sha256) && Array.isArray(component.architectures) &&
      component.architectures.includes('arm64') && new Set(component.architectures).size === component.architectures.length &&
      component.architectures.every(arch => ['arm64', 'x86_64'].includes(arch)) &&
      Array.isArray(component.dependencies) && component.dependencies.every(value => typeof value === 'string') &&
      Array.isArray(component.rpaths) && component.rpaths.every(value =>
        ['@executable_path/../Frameworks', '@loader_path/../Frameworks', '@loader_path/../../../../Frameworks'].includes(value)),
    'Invalid recorded runtime component metadata');
    component.dependencies.forEach(localDependency);
  }
  assert(required.length > 0 && required.every(name => inventory.components.some(component => component.path === name)),
    'Runtime inventory is missing recorded core/helper components');
  validateCodeClosure(inventory.components, required);
}

export function copyMaterialFiles(copies, target) {
  for (const { from, file } of copies) {
    const to = path.join(target, file.path);
    const bytes = readVerified(from, file);
    mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
    const descriptor = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
    try { writeFileSync(descriptor, bytes); fchmodSync(descriptor, file.mode); }
    finally { closeSync(descriptor); }
  }
  const expected = copies.map(({ file }) => file).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(materialFiles(target, sort(readdirSync(target)), { archives: true }), expected,
    'Copied source material differs from expected input');
}

export function verifyObsSourceMaterials(root) {
  directory(root);
  const top = sort(readdirSync(root));
  assert.deepEqual(top, ['SOURCE-MATERIALS.md', 'licenses', 'runtime-inventory.json', 'source', manifestName, 'upstream'].sort(),
    'Unexpected source package contents');
  const files = materialFiles(root, top.filter(name => name !== manifestName), { archives: true });
  validatePinnedArchives(...archiveNames.map(file => path.join(root, file)));
  const association = verifyMaterialAssociation(root);
  const inventory = json(root, 'runtime-inventory.json');
  validateMaterialInventory(inventory, association);
  assert.deepEqual(json(root, manifestName), sourceMaterialManifest(files, association), 'Source material manifest mismatch');
  assert.equal(readFileSync(path.join(root, 'SOURCE-MATERIALS.md'), 'utf8'), instructions, 'Source material instructions changed');
  return { files: files.length, helperSourceSha256: association.snapshot.snapshotSha256,
    internalOnly: true, distributionReady: false, dependencySources: 'incomplete', rebuild: 'not-run' };
}

export function stageObsSourceMaterials(runtime, sourceArchive, dependencyArchive, destination) {
  const root = directory(path.resolve(runtime));
  const target = stagingDestination(root, destination);
  const sourceFiles = materialFiles(root, ['source', 'licenses', 'runtime-inventory.json']);
  const association = verifyMaterialAssociation(root);
  verifyHelperBuild(root);
  const observed = inspectRuntime(root);
  validateSourceInventory(json(root, 'runtime-inventory.json'), observed);
  for (const component of association.core.components) {
    const uuid = parseHelperUUID(execFileSync('/usr/bin/dwarfdump', ['--uuid', path.join(root, component.path)],
      { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }));
    assert.equal(uuid, component.uuid, 'Runtime core UUID differs from recorded source build');
  }
  const archives = validatePinnedArchives(sourceArchive, dependencyArchive);
  const copies = [...sourceFiles.map(file => ({ from: path.join(root, file.path), file })),
    ...[sourceArchive, dependencyArchive].map((from, index) => ({ from,
      file: { path: archiveNames[index], ...hashRegularFile(from, limits.archive) } }))];
  assert(archives.every((record, index) => copies[sourceFiles.length + index].file.sha256 === record.sha256), 'Archive changed');
  mkdirSync(target, { mode: 0o700 });
  try {
    copyMaterialFiles(copies, target);
    assert.deepEqual(materialFiles(root, ['source', 'licenses', 'runtime-inventory.json']), sourceFiles,
      'Runtime source materials changed during staging');
    validateSourceInventory(json(root, 'runtime-inventory.json'), inspectRuntime(root));
    verifyHelperBuild(root);
    writeFileSync(path.join(target, 'SOURCE-MATERIALS.md'), instructions, { flag: 'wx', mode: 0o644 });
    const files = materialFiles(target, sort(readdirSync(target)), { archives: true });
    const manifest = sourceMaterialManifest(files, verifyMaterialAssociation(target));
    writeFileSync(path.join(target, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    return { directory: target, ...verifyObsSourceMaterials(target) };
  } catch (error) { throw new Error(`Unverified source artifact retained at ${target}: ${error.message}`); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 4 || (args.length === 2 && args[0] === '--verify'),
      'usage: stage-obs-source.mjs <runtime> <obs-source-archive> <dependency-archive> <new-destination> | --verify <package>');
    console.log(JSON.stringify(args[0] === '--verify' ? verifyObsSourceMaterials(args[1]) : stageObsSourceMaterials(...args), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
