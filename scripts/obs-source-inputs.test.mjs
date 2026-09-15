import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { coreBuildComponents, corePatchNames, coreRecipeFiles, hashRegularFile, normalizeCoreToolchain,
  pinnedInputs, prepareCoreBuild, recordCoreBuild, validateCoreBuild, validatePinnedArchives, verifyCoreBuild } from './obs-source-inputs.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const project = fileURLToPath(new URL('../', import.meta.url));
const fixtureToolchain = () => normalizeCoreToolchain({ xcode: 'Xcode 16.4\nBuild version 16F6\n',
  clang: 'Apple clang version 17.0.0 (clang-1700.0.13.5)\nTarget: arm64-apple-darwin\nInstalledDir: /private/build/toolchain\n',
  cmake: 'cmake version 3.31.6\n\nCMake suite maintained and supported by Kitware\n', sdk: '15.5\n' });
function record() {
  const recipeFiles = coreRecipeFiles.map((file, index) => ({ path: file, sha256: hash(file), size: index + 1, mode: 0o644 }));
  return { schema: 1, kind: 'obs-core-build-inputs', internalOnly: true, distributionReady: false,
    reproducibleBuildVerified: false, inputs: pinnedInputs.map(input => ({ ...input, size: 1024 })),
    recipeFiles, recipeSha256: hash(JSON.stringify(recipeFiles)), toolchain: fixtureToolchain(),
    patches: corePatchNames.map(name => ({ ...recipeFiles.find(file => file.path === `obs-sidecar/patches/${name}.patch`), path: `patches/${name}.patch` })),
    components: coreBuildComponents.map((component, index) => ({ path: component.path,
      uuid: `${String(index + 1).repeat(8)}-AAAA-BBBB-CCCC-DDDDDDDDDDDD` })) };
}
function temporary(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sauce-core-inputs-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('accepts exact pinned provenance with explicit non-reproducibility and optional observations', () => {
  const value = record();
  assert.equal(validateCoreBuild(value), value);
  assert.equal(validateCoreBuild(value, { inputs: structuredClone(value.inputs), recipeFiles: structuredClone(value.recipeFiles),
    components: structuredClone(value.components), patches: structuredClone(value.patches), toolchain: fixtureToolchain() }), value);
  assert.equal(value.distributionReady, false);
  assert.equal(value.reproducibleBuildVerified, false);
  assert.equal(value.inputs[1].role, 'prebuilt-dependency-inputs-not-complete-source');
  assert(!JSON.stringify(value).includes('/private/'));
});

test('rejects unknown fields, missing fields, and stronger provenance claims', () => {
  for (const mutate of [value => { value.schema = 2; }, value => { value.kind = 'source-complete'; },
    value => { value.internalOnly = false; }, value => { value.distributionReady = true; },
    value => { value.reproducibleBuildVerified = true; }, value => { value.cwd = '/Users/private'; },
    value => { delete value.recipeFiles; }, value => { delete value.toolchain; }]) {
    const value = record(); mutate(value); assert.throws(() => validateCoreBuild(value));
  }
});

test('requires both canonical archive pins, labels and bounded sizes', () => {
  for (const mutate of [value => { value.inputs.pop(); }, value => { value.inputs.reverse(); },
    value => { value.inputs[0].sha256 = 'a'.repeat(64); }, value => { value.inputs[1].role = 'source'; },
    value => { value.inputs[0].file = '../source.tar.gz'; }, value => { value.inputs[0].sourcePath = '/private/archive'; },
    value => { value.inputs[0].version = 'latest'; }, value => { value.inputs[0].size = 0; },
    value => { value.inputs[1].size = 256 * 1024 * 1024 + 1; }]) {
    const value = record(); mutate(value); assert.throws(() => validateCoreBuild(value));
  }
});

test('requires the complete sorted recipe with portable exact paths and valid hashes', () => {
  for (const mutate of [value => { value.recipeFiles.pop(); }, value => { value.recipeFiles.reverse(); },
    value => { value.recipeFiles[1] = value.recipeFiles[0]; }, value => { value.recipeFiles[0].path = '../patch'; },
    value => { value.recipeFiles[0].path = '/private/patch'; }, value => { value.recipeFiles[0].sha256 = 'g'.repeat(64); },
    value => { value.recipeFiles[0].size = 0; }, value => { value.recipeFiles[0].size = 2 * 1024 * 1024 + 1; },
    value => { value.recipeFiles[0].mode = 0o4644; }, value => { value.recipeFiles[0].note = 'extra'; },
    value => { value.recipeSha256 = '0'.repeat(64); }]) {
    const value = record(); mutate(value); assert.throws(() => validateCoreBuild(value));
  }
  // The digest remains canonical even when JSON object properties are reordered.
  const value = record();
  value.recipeFiles = value.recipeFiles.map(file => ({ mode: file.mode, size: file.size, sha256: file.sha256, path: file.path }));
  assert.doesNotThrow(() => validateCoreBuild(value));
});

test('copied patch hashes, sizes and modes must equal the frozen recipe', () => {
  for (const mutate of [value => { value.patches.pop(); }, value => { value.patches.reverse(); },
    value => { value.patches[0].path = 'source/patch.patch'; }, value => { value.patches[0].sha256 = 'b'.repeat(64); },
    value => { value.patches[0].size++; }, value => { value.patches[0].mode = 0o755; }]) {
    const value = record(); mutate(value); assert.throws(() => validateCoreBuild(value));
  }
});

test('requires exact unambiguous UUID associations for all three core outputs', () => {
  for (const mutate of [value => { value.components.pop(); }, value => { value.components.reverse(); },
    value => { value.components[0].path = '../libobs'; }, value => { value.components[0].uuid = 'not-a-uuid'; },
    value => { value.components[0].uuid = value.components[0].uuid.toLowerCase(); },
    value => { value.components[0].uuid = value.components[1].uuid; }, value => { value.components[0].architecture = 'arm64'; }]) {
    const value = record(); mutate(value); assert.throws(() => validateCoreBuild(value));
  }
});

test('independent changed recipe, patch, toolchain, input or output observations fail', () => {
  const value = record();
  for (const key of ['inputs', 'recipeFiles', 'patches', 'components', 'toolchain']) {
    assert.throws(() => validateCoreBuild(value, { [key]: [] }), new RegExp(`Core ${key} changed`));
  }
  assert.throws(() => validateCoreBuild(value, { absoluteRoot: '/private/build' }), /Unknown core observation/);
});

test('toolchain normalization retains versions, not compiler paths or invocation environment', () => {
  const normalized = fixtureToolchain();
  assert.deepEqual(normalized, { xcodeVersion: '16.4', xcodeBuild: '16F6',
    clangVersion: 'Apple clang version 17.0.0 (clang-1700.0.13.5)', cmakeVersion: '3.31.6', macosSdkVersion: '15.5',
    target: 'arm64-apple-macos14.0', generator: 'Xcode', configuration: 'Release' });
  for (const mutate of [value => { value.toolchain.clangVersion = '/private/compiler'; },
    value => { value.toolchain.xcodeVersion = 16; }, value => { value.toolchain.xcodeBuild = '16F6\n/private'; },
    value => { value.toolchain.macosSdkVersion = '/Applications/Xcode'; },
    value => { value.toolchain.target = 'x86_64-apple-macos14.0'; }, value => { value.toolchain.environment = {}; }]) {
    const value = record(); mutate(value); assert.throws(() => validateCoreBuild(value), /toolchain/);
  }
  assert.throws(() => normalizeCoreToolchain({ xcode: 'Xcode unknown', clang: '', cmake: '', sdk: '' }));
});

test('material hashing rejects symlinks, parent aliases, hardlinks and oversized files', t => {
  const root = temporary(t);
  const original = path.join(root, 'input'); writeFileSync(original, 'verified material', { mode: 0o644 });
  assert.deepEqual(hashRegularFile(original), { sha256: hash('verified material'), size: 17, mode: 0o644 });
  assert.throws(() => hashRegularFile(original, 16), /oversized/);
  const alias = path.join(root, 'alias'); symlinkSync(original, alias);
  assert.throws(() => hashRegularFile(alias), /alias/);
  const directory = path.join(root, 'directory'); mkdirSync(directory);
  writeFileSync(path.join(directory, 'file'), 'x');
  symlinkSync(directory, path.join(root, 'linked-directory'));
  assert.throws(() => hashRegularFile(path.join(root, 'linked-directory/file')), /alias/);
  const linked = path.join(root, 'hardlink'); linkSync(original, linked);
  assert.throws(() => hashRegularFile(original), /Invalid/);
  assert.throws(() => hashRegularFile(linked), /Invalid/);
});

test('wrong archive bytes fail against real pins without network or a build', t => {
  const root = temporary(t);
  const archive = path.join(root, 'archive'); writeFileSync(archive, 'not the pinned archive');
  assert.throws(() => validatePinnedArchives(archive, archive), /archive checksum mismatch/);
});

test('an existing old core cannot acquire a preparation or post-hoc build record', t => {
  const root = temporary(t);
  mkdirSync(path.join(root, 'build'));
  assert.throws(() => prepareCoreBuild(root, '/missing/source', '/missing/deps'), /empty new output/);
  assert.throws(() => recordCoreBuild(root, '/missing/source', '/missing/deps'), /ENOENT/);
  const outside = path.join(root, 'outside.json'); writeFileSync(outside, JSON.stringify(record()));
  symlinkSync(outside, path.join(root, 'core-build-inputs.json'));
  assert.throws(() => verifyCoreBuild(root), /alias/);
});

test('builder freezes before extraction and records only after successful output checks', () => {
  const builder = readFileSync(path.join(project, 'scripts/build-obs-core.sh'), 'utf8');
  const prepare = builder.indexOf('--prepare-core');
  const extract = builder.indexOf('tar -xzf');
  const configure = builder.indexOf('cmake -S');
  const build = builder.indexOf('cmake --build');
  const check = builder.indexOf('bash "$recipe_root/scripts/check-obs-core.sh" "$core"');
  const stride = builder.indexOf('bash "$recipe_root/scripts/verify-obs-stagesurface.sh" "$output_dir"');
  const recordBuild = builder.indexOf('--record-core');
  assert(prepare > 0 && prepare < extract && extract < configure && configure < build && build < check && check < stride && stride < recordBuild);
  assert(corePatchNames.includes('macos-stagesurface-stride'));
  assert(coreRecipeFiles.includes('obs-sidecar/stagesurface-stride.test.mm'));
  assert(coreRecipeFiles.includes('scripts/verify-obs-stagesurface.sh'));
  assert(builder.includes('ditto "$recipe_root/obs-sidecar/patches/$patch_name.patch"'));
  assert(builder.includes('! -L "$output_dir"'));
  execFileSync('/bin/bash', ['-n', path.join(project, 'scripts/build-obs-core.sh')]);
});
