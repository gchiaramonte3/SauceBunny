// Pinned build inputs, shared by the no-network builder and material packager.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const maxArchiveBytes = 256 * 1024 * 1024;
const maxRecipeBytes = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const sorted = values => [...values].sort();
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  JSON.stringify(sorted(Object.keys(value))) === JSON.stringify(sorted(keys));
const sameFile = (left, right) => ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']
  .every(key => left[key] === right[key]);

// Real files only: checking both descriptor and path closes replacement and
// same-size mutation races. Material hashes must not silently follow aliases.
function readRegularFile(file, maximum, retainBytes = false) {
  const absolute = path.resolve(file);
  assert(realpathSync(absolute) === absolute, 'Material file must not be a path alias');
  const info = lstatSync(absolute, { bigint: true });
  assert(info.isFile() && info.nlink === 1n && !(info.mode & 0o7000n) &&
    info.size <= BigInt(maximum), 'Invalid or oversized material file');
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const chunks = [];
  let size = 0;
  try {
    assert(sameFile(info, fstatSync(descriptor, { bigint: true })), 'Material file changed before hashing');
    for (;;) {
      const count = readSync(descriptor, buffer);
      if (count === 0) break;
      size += count;
      assert(size <= maximum, 'Material file grew beyond its limit');
      digest.update(buffer.subarray(0, count));
      if (retainBytes) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    assert(BigInt(size) === info.size && sameFile(info, fstatSync(descriptor, { bigint: true })) &&
      sameFile(info, lstatSync(absolute, { bigint: true })) && realpathSync(absolute) === absolute,
    'Material file changed while hashing');
  } finally { closeSync(descriptor); }
  return { size, sha256: digest.digest('hex'), mode: Number(info.mode & 0o777n),
    ...(retainBytes ? { bytes: Buffer.concat(chunks) } : {}) };
}

export function hashRegularFile(file, maximum = maxArchiveBytes) {
  assert(Number.isSafeInteger(maximum) && maximum > 0, 'Invalid material byte limit');
  return readRegularFile(file, maximum);
}

function readJson(file) {
  const data = readRegularFile(file, maxRecipeBytes, true);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.bytes)); }
  catch { throw new Error('Invalid core material JSON'); }
}

const declaration = readJson(path.join(project, 'obs-sidecar/upstream-inputs.json'));
assert(exactKeys(declaration, ['schema', 'inputs']) && declaration.schema === 1 &&
  Array.isArray(declaration.inputs) && declaration.inputs.length === 2, 'Invalid pinned OBS input declarations');
export const pinnedInputs = Object.freeze(declaration.inputs.map((input, index) => {
  assert(exactKeys(input, ['id', 'file', 'version', 'role', 'sha256']) &&
    input.id === ['obs', 'dependencies'][index] &&
    input.role === ['upstream-source', 'prebuilt-dependency-inputs-not-complete-source'][index] &&
    typeof input.file === 'string' && typeof input.version === 'string' && typeof input.sha256 === 'string' &&
    /^[a-zA-Z0-9.-]+$/.test(input.file) && /^[a-zA-Z0-9.-]+$/.test(input.version) && hashPattern.test(input.sha256),
  'Invalid pinned OBS input declarations');
  return Object.freeze(input);
}));

export function validatePinnedArchives(sourceArchive, dependencyArchive) {
  return [sourceArchive, dependencyArchive].map((file, index) => {
    const observed = hashRegularFile(file);
    if (observed.sha256 !== pinnedInputs[index].sha256) throw new Error(`Pinned ${pinnedInputs[index].id} archive checksum mismatch`);
    return { ...pinnedInputs[index], size: observed.size };
  });
}

export const corePatchNames = Object.freeze(['macos-core-dependencies', 'macos-helper-module', 'macos-no-global-input',
  'macos-stagesurface-stride']);
export const coreRecipeFiles = Object.freeze(sorted([
  'scripts/build-obs-core.sh', 'scripts/check-obs-core.sh', 'scripts/obs-source-inputs.mjs',
  'scripts/verify-obs-stagesurface.sh', 'obs-sidecar/stagesurface-stride.test.mm',
  'obs-sidecar/upstream-inputs.json', ...corePatchNames.map(name => `obs-sidecar/patches/${name}.patch`),
]));
export const coreBuildComponents = Object.freeze([
  { path: 'Frameworks/libobs-opengl.dylib', buildPath: 'build/libobs-opengl/Release/libobs-opengl.dylib' },
  { path: 'Frameworks/libobs.framework/Versions/A/libobs', buildPath: 'build/libobs/Release/libobs.framework/Versions/A/libobs' },
  { path: 'PlugIns/obs-ffmpeg.plugin/Contents/MacOS/obs-ffmpeg', buildPath: 'build/plugins/obs-ffmpeg/Release/obs-ffmpeg.plugin/Contents/MacOS/obs-ffmpeg' },
].map(Object.freeze));

function realDirectory(value) {
  const absolute = path.resolve(value);
  assert(lstatSync(absolute).isDirectory(), 'Core directory must not be a symlink or file');
  // Accept caller-relative paths (and macOS /tmp) at the root boundary only.
  return realpathSync(absolute);
}

function recipeRecord(name, data) { return { path: name, sha256: data.sha256, size: data.size, mode: data.mode }; }
function recipeDigest(files) { return hash(JSON.stringify(files.map(file => recipeRecord(file.path, file)))); }
function observeRecipe(root, snapshot = false) {
  root = realDirectory(root);
  if (snapshot) {
    const found = [];
    function visit(directory, depth = 0) {
      assert(depth <= 4, 'Unexpected core recipe depth');
      for (const name of readdirSync(directory)) {
        assert(/^[A-Za-z0-9._-]+$/.test(name), 'Unsafe core recipe path');
        const file = path.join(directory, name);
        const stat = lstatSync(file);
        if (stat.isDirectory()) visit(file, depth + 1);
        else { assert(stat.isFile(), 'Core recipe aliases and special files are forbidden'); found.push(path.relative(root, file)); }
      }
    }
    visit(root);
    assert.deepEqual(sorted(found), coreRecipeFiles, 'Unexpected or missing core recipe file');
  }
  return coreRecipeFiles.map(name => {
    const data = readRegularFile(path.join(root, name), maxRecipeBytes, true);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.bytes);
    assert(!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text), 'Core recipe must contain text');
    return recipeRecord(name, data);
  });
}

function validateToolchain(value) {
  assert(exactKeys(value, ['xcodeVersion', 'xcodeBuild', 'clangVersion', 'cmakeVersion', 'macosSdkVersion',
    'target', 'generator', 'configuration']) &&
    Object.values(value).every(field => typeof field === 'string' && field.length <= 256) &&
    /^\d+(?:\.\d+)*$/.test(value.xcodeVersion) && /^[A-Za-z0-9.]+$/.test(value.xcodeBuild) &&
    /^Apple clang version [A-Za-z0-9(). _+-]{1,160}$/.test(value.clangVersion) &&
    /^\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?$/.test(value.cmakeVersion) && /^\d+(?:\.\d+)*$/.test(value.macosSdkVersion) &&
    value.target === 'arm64-apple-macos14.0' && value.generator === 'Xcode' && value.configuration === 'Release',
  'Invalid or path-bearing core toolchain information');
}

export function normalizeCoreToolchain({ xcode, clang, cmake, sdk }) {
  const version = /^Xcode (\d+(?:\.\d+)*)\r?\nBuild version ([A-Za-z0-9.]+)\s*$/.exec(xcode);
  const cmakeVersion = /^cmake version (\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?)$/.exec(cmake.split(/\r?\n/)[0]);
  assert(version && cmakeVersion, 'Cannot identify core build toolchain');
  const result = { xcodeVersion: version[1], xcodeBuild: version[2], clangVersion: clang.split(/\r?\n/)[0],
    cmakeVersion: cmakeVersion[1], macosSdkVersion: sdk.trim(), target: 'arm64-apple-macos14.0', generator: 'Xcode', configuration: 'Release' };
  validateToolchain(result);
  return result;
}

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
function observeToolchain() {
  return normalizeCoreToolchain({ xcode: run('/usr/bin/xcodebuild', ['-version']),
    clang: run('/usr/bin/xcrun', ['clang', '--version']), cmake: run('cmake', ['--version']),
    sdk: run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version']) });
}

function validateFiles(files, paths) {
  assert(Array.isArray(files) && files.length === paths.length, 'Incomplete core material files');
  files.forEach((file, index) => {
    assert(exactKeys(file, ['path', 'sha256', 'size', 'mode']) && file.path === paths[index] &&
      typeof file.sha256 === 'string' && hashPattern.test(file.sha256) &&
      Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxRecipeBytes &&
      Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, 'Invalid core material file record');
  });
}

function validatePreparation(record) {
  assert(record?.schema === 1 && Array.isArray(record.inputs) && record.inputs.length === pinnedInputs.length,
    'Invalid core build inputs');
  record.inputs.forEach((input, index) => {
    assert(exactKeys(input, [...Object.keys(pinnedInputs[index]), 'size']) &&
      Number.isSafeInteger(input.size) && input.size > 0 && input.size <= maxArchiveBytes, 'Invalid pinned core archive');
    for (const [key, value] of Object.entries(pinnedInputs[index])) assert.equal(input[key], value, 'Core archive pin mismatch');
  });
  validateFiles(record.recipeFiles, coreRecipeFiles);
  assert(record.recipeSha256 === recipeDigest(record.recipeFiles), 'Core recipe manifest digest mismatch');
  validateToolchain(record.toolchain);
}

// Pure validation for the material packager. UUID associations are evidence of
// the build outputs observed by the builder, not proof of a reproducible build.
export function validateCoreBuild(record, observed = {}) {
  assert(exactKeys(record, ['schema', 'kind', 'internalOnly', 'distributionReady', 'reproducibleBuildVerified',
    'inputs', 'recipeFiles', 'recipeSha256', 'toolchain', 'patches', 'components']) &&
    record.kind === 'obs-core-build-inputs' && record.internalOnly === true && record.distributionReady === false &&
    record.reproducibleBuildVerified === false, 'Invalid core build provenance record');
  validatePreparation(record);
  validateFiles(record.patches, corePatchNames.map(name => `patches/${name}.patch`));
  for (const patch of record.patches) {
    const recipe = record.recipeFiles.find(file => file.path === `obs-sidecar/${patch.path}`);
    assert.deepEqual(recipeRecord(patch.path, recipe), patch, 'Copied core patch differs from frozen recipe');
  }
  assert(Array.isArray(record.components) && record.components.length === coreBuildComponents.length, 'Incomplete core output associations');
  record.components.forEach((component, index) => {
    assert(exactKeys(component, ['path', 'uuid']) && component.path === coreBuildComponents[index].path &&
      typeof component.uuid === 'string' && uuidPattern.test(component.uuid), 'Invalid core output association');
  });
  assert(new Set(record.components.map(component => component.uuid)).size === coreBuildComponents.length, 'Duplicate core output UUID');
  assert(observed && typeof observed === 'object' && !Array.isArray(observed), 'Invalid core observations');
  for (const [key, value] of Object.entries(observed)) {
    assert(['inputs', 'recipeFiles', 'patches', 'components', 'toolchain'].includes(key), 'Unknown core observation');
    assert.deepEqual(record[key], value, `Core ${key} changed or does not match its build record`);
  }
  return record;
}

export function prepareCoreBuild(coreDir, sourceArchive, depsArchive) {
  const root = realDirectory(coreDir);
  assert(readdirSync(root).length === 0, 'Core preparation requires an empty new output directory');
  const inputs = validatePinnedArchives(sourceArchive, depsArchive);
  const recipeFiles = observeRecipe(project);
  const toolchain = observeToolchain();
  const snapshot = path.join(root, 'core-build-source');
  mkdirSync(snapshot, { mode: 0o700 });
  for (const file of recipeFiles) {
    const data = readRegularFile(path.join(project, file.path), maxRecipeBytes, true);
    assert.deepEqual(recipeRecord(file.path, data), file, 'Core recipe changed while freezing');
    const target = path.join(snapshot, file.path);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
    try { writeFileSync(descriptor, data.bytes); fchmodSync(descriptor, file.mode); }
    finally { closeSync(descriptor); }
  }
  assert.deepEqual(observeRecipe(snapshot, true), recipeFiles, 'Frozen core recipe differs from input');
  assert.deepEqual(observeRecipe(project), recipeFiles, 'Core recipe changed while freezing');
  const prepared = { schema: 1, inputs, recipeFiles, recipeSha256: recipeDigest(recipeFiles), toolchain };
  writeFileSync(path.join(root, 'core-build-preparation.json'), `${JSON.stringify(prepared, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return prepared;
}

function observePatches(root) {
  const directory = path.join(root, 'patches');
  assert(realDirectory(directory) === directory, 'Copied core patches must not be aliased');
  assert.deepEqual(sorted(readdirSync(directory)), corePatchNames.map(name => `${name}.patch`), 'Unexpected copied core patches');
  return corePatchNames.map(name => recipeRecord(`patches/${name}.patch`, hashRegularFile(path.join(directory, `${name}.patch`), maxRecipeBytes)));
}

function observeComponents(root) {
  return coreBuildComponents.map(component => {
    const file = path.join(root, component.buildPath);
    const before = hashRegularFile(file);
    assert(before.size > 0, 'Core output is empty');
    const output = run('/usr/bin/dwarfdump', ['--uuid', file]).trim();
    const match = /^UUID: ([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}) \(arm64\) [^\r\n]+$/.exec(output);
    assert(match, 'Expected exactly one arm64 core output UUID');
    assert.deepEqual(hashRegularFile(file), before, 'Core output changed during UUID inspection');
    return { path: component.path, uuid: match[1].toUpperCase() };
  });
}

export function recordCoreBuild(coreDir, sourceArchive, depsArchive) {
  const root = realDirectory(coreDir);
  const prepared = readJson(path.join(root, 'core-build-preparation.json'));
  assert(exactKeys(prepared, ['schema', 'inputs', 'recipeFiles', 'recipeSha256', 'toolchain']), 'Invalid core preparation record');
  validatePreparation(prepared);
  assert.deepEqual(validatePinnedArchives(sourceArchive, depsArchive), prepared.inputs, 'Core archives changed during build');
  assert.deepEqual(observeRecipe(path.join(root, 'core-build-source'), true), prepared.recipeFiles, 'Frozen core recipe changed during build');
  assert.deepEqual(observeRecipe(project), prepared.recipeFiles, 'Core recipe changed during build');
  assert.deepEqual(observeToolchain(), prepared.toolchain, 'Core toolchain changed during build');
  const record = { ...prepared, kind: 'obs-core-build-inputs', internalOnly: true, distributionReady: false,
    reproducibleBuildVerified: false, patches: observePatches(root), components: observeComponents(root) };
  validateCoreBuild(record);
  assert.deepEqual(observeRecipe(project), prepared.recipeFiles, 'Core recipe changed during recording');
  writeFileSync(path.join(root, 'core-build-inputs.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return verifyCoreBuild(root);
}

export function verifyCoreBuild(coreDir) {
  const root = realDirectory(coreDir);
  const record = validateCoreBuild(readJson(path.join(root, 'core-build-inputs.json')));
  assert.deepEqual(observeRecipe(project), record.recipeFiles, 'Current recipe differs from recorded core build');
  return validateCoreBuild(record, { recipeFiles: observeRecipe(path.join(root, 'core-build-source'), true),
    patches: observePatches(root), components: observeComponents(root) });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const usage = 'usage: obs-source-inputs.mjs <obs-source-archive> <dependency-archive> | --prepare-core <core> <source> <deps> | --record-core <core> <source> <deps> | --verify-core <core>';
    let result;
    if (args.length === 4 && ['--prepare-core', '--record-core'].includes(args[0])) {
      result = (args[0] === '--prepare-core' ? prepareCoreBuild : recordCoreBuild)(...args.slice(1));
    } else if (args.length === 2 && args[0] === '--verify-core') result = verifyCoreBuild(args[1]);
    else { assert(args.length === 2 && !args[0].startsWith('--'), usage); result = validatePinnedArchives(...args); }
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
