// MIT sender build provenance and internal-only BNDL staging. Never executes a
// sender, loads an SDK runtime, launches an app or claims distribution readiness.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const senderExecutable = 'MacOS/saucebunny-ndi-sender';
export const senderSourceFiles = [
  'LICENSE', 'obs-sidecar/raw-frame.hpp', 'scripts/build-ndi-sender.sh', 'scripts/ndi-sender-artifact.mjs',
  ...['ndi_sender.hpp', 'ndi_sender.cpp', 'ndi_sender_sdk.hpp', 'ndi_sender_sdk.cpp', 'ndi_sender_main.cpp']
    .map(name => `src-tauri/native/${name}`),
].sort();
const options = { encoding: 'utf8', maxBuffer: 1024 * 1024 };
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const buildFiles = [senderExecutable, 'source-sha256.txt', 'sdk-headers-sha256.txt', 'sender-build.json',
  ...senderSourceFiles.map(name => `source/${name}`)].sort();
const bundleInfo = { CFBundlePackageType: 'BNDL', CFBundleIdentifier: 'com.saucebunny.ndi-sender',
  CFBundleName: 'NDISender', CFBundleVersion: '1', CFBundleShortVersionString: '1.0' };
const flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread', '-target', 'arm64-apple-macos14.0'];

function exists(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function regular(file, limit = 2 * 1024 * 1024) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || realpathSync(file) !== file) {
    throw new Error(`Expected a bounded real sender file: ${file}`);
  }
  return stat;
}
function text(file, limit = 65536) {
  regular(file, limit);
  const bytes = readFileSync(file);
  const value = bytes.toString('utf8');
  if (!Buffer.from(value).equals(bytes) || value.includes('\0')) throw new Error('Invalid sender text material');
  return value;
}
function json(file) {
  const value = JSON.parse(text(file));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sender metadata');
  return value;
}
const keysAre = (value, keys) => isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
function exactTree(root, expected, signatures = false) {
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error('Sender directory must not be an alias');
  const found = [];
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), relative = path.relative(root, file);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || realpathSync(file) !== file) throw new Error('Sender aliases are not permitted');
      if (signatures && relative === '_CodeSignature') {
        if (!stat.isDirectory()) throw new Error('Unexpected sender signature material');
        const names = readdirSync(file).sort();
        // Resource-only BNDLs keep their signature in detached files; signed
        // executable bundles can use the single resource-seal layout instead.
        const detached = ['CodeDirectory', 'CodeRequirements', 'CodeResources', 'CodeSignature'];
        if (!isDeepStrictEqual(names, ['CodeResources']) && !isDeepStrictEqual(names, detached)) {
          throw new Error('Unexpected sender signature material');
        }
        for (const name of names) regular(path.join(file, name));
        continue;
      }
      if (stat.isDirectory()) {
        if (!expected.some(entry => entry.startsWith(`${relative}/`))) throw new Error('Unexpected sender directory');
        walk(file);
      } else if (stat.isFile()) found.push(relative);
      else throw new Error('Sender special files are not permitted');
    }
  }
  walk(root);
  if (!isDeepStrictEqual(found.sort(), [...expected].sort())) throw new Error('Sender artifact has a missing or unexpected file');
}
function manifest(file, expected) {
  const entries = text(file).trimEnd().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_./-]+)$/.exec(line);
    if (!match) throw new Error('Invalid sender source/header manifest');
    return { name: match[2], sha256: match[1] };
  });
  if (entries.length < 1 || entries.length > 128 || new Set(entries.map(entry => entry.name)).size !== entries.length ||
      (expected && !isDeepStrictEqual(entries.map(entry => entry.name).sort(), expected)) ||
      (!expected && entries.some(entry => !/^Processing\.NDI[A-Za-z0-9_.-]*\.h$/.test(entry.name)))) {
    throw new Error('Unexpected sender source/header manifest entries');
  }
  return entries;
}
function materials(root) {
  for (const entry of manifest(path.join(root, 'source-sha256.txt'), senderSourceFiles)) {
    const file = path.join(root, 'source', entry.name);
    text(file, 512 * 1024);
    if (sha256(file) !== entry.sha256) throw new Error('Sender source material was modified');
  }
  manifest(path.join(root, 'sdk-headers-sha256.txt'));
  return { sourceSha256: sha256(path.join(root, 'source-sha256.txt')),
    sdkHeadersSha256: sha256(path.join(root, 'sdk-headers-sha256.txt')) };
}
function code(file, run) {
  const stat = regular(file, 16 * 1024 * 1024);
  if (!(stat.mode & 0o111)) throw new Error('Sender is not executable');
  const architectures = String(run('/usr/bin/lipo', ['-archs', file], options)).trim().split(/\s+/);
  if (!isDeepStrictEqual(architectures, ['arm64'])) throw new Error('Sender must contain only arm64 code');
  const uuidText = String(run('/usr/bin/dwarfdump', ['--uuid', file], options));
  const uuids = [...uuidText.matchAll(/^UUID: ([A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}) \(arm64\)/gm)];
  if (uuids.length !== 1) throw new Error('Sender has no unambiguous arm64 UUID');
  const dependencies = String(run('/usr/bin/otool', ['-L', file], options)).trim().split('\n').slice(1)
    .map(line => line.trim().replace(/ \(compatibility version.*$/, ''));
  if (!dependencies.length || dependencies.some(value => /libobs|libndi/i.test(value) ||
    (!value.startsWith('/usr/lib/') && !value.startsWith('/System/Library/')))) throw new Error('Sender has non-system or OBS/NDI linkage');
  const commands = String(run('/usr/bin/otool', ['-l', file], options));
  if (/cmd LC_RPATH\b/.test(commands)) throw new Error('Sender must not carry library search paths');
  const builds = [...commands.matchAll(/cmd LC_BUILD_VERSION\b([\s\S]*?)(?=\n\s*cmd |\nLoad command \d+|$)/g)];
  const legacy = [...commands.matchAll(/cmd LC_VERSION_MIN_MACOSX\b([\s\S]*?)(?=\n\s*cmd |\nLoad command \d+|$)/g)];
  const minimum = builds.length === 1 && /\bplatform (?:1|MACOS)\s/.test(builds[0][1]) ? /\bminos (\S+)/.exec(builds[0][1])?.[1]
    : legacy.length === 1 ? /\bversion (\S+)/.exec(legacy[0][1])?.[1] : undefined;
  if (builds.length + legacy.length !== 1 || !/^14\.0(?:\.0)?$/.test(minimum ?? '')) throw new Error('Sender must target macOS 14.0');
  return { sha256: sha256(file), uuid: uuids[0][1].toUpperCase(), architectures, dependencies, minimumOs: '14.0' };
}
function validateBuild(record, observedMaterials, observedCode, signed = false) {
  if (!keysAre(record, ['schema', 'kind', 'internalOnly', 'distributionReady', 'sourceSha256', 'sdkHeadersSha256', 'compiler', 'flags', 'executable']) ||
      record.schema !== 1 || record.kind !== 'ndi-sender-build' || record.internalOnly !== true || record.distributionReady !== false ||
      record.sourceSha256 !== observedMaterials.sourceSha256 || record.sdkHeadersSha256 !== observedMaterials.sdkHeadersSha256 ||
      typeof record.compiler !== 'string' || !record.compiler || record.compiler.length > 256 || /[\x00-\x1f]/.test(record.compiler) ||
      !isDeepStrictEqual(record.flags, flags) || !record.executable || !hash(record.executable.sha256) ||
      !isDeepStrictEqual({ ...record.executable, ...(signed ? { sha256: observedCode.sha256 } : {}) }, observedCode)) {
    throw new Error('Sender build provenance does not match its materials or executable');
  }
}
export function recordSenderBuild(directory, { run = execFileSync } = {}) {
  const root = realpathSync(directory);
  exactTree(root, buildFiles.filter(name => name !== 'sender-build.json'));
  const record = { schema: 1, kind: 'ndi-sender-build', internalOnly: true, distributionReady: false,
    ...materials(root), compiler: String(run('clang++', ['--version'], options)).split('\n')[0], flags,
    executable: code(path.join(root, senderExecutable), run) };
  validateBuild(record, materials(root), record.executable);
  writeFileSync(path.join(root, 'sender-build.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record;
}
export function inspectSenderBuild(directory, { run = execFileSync } = {}) {
  const root = realpathSync(directory);
  exactTree(root, buildFiles);
  const record = json(path.join(root, 'sender-build.json'));
  validateBuild(record, materials(root), code(path.join(root, senderExecutable), run));
  return record;
}
const bundledFiles = ['Info.plist', senderExecutable, 'Resources/sender-inventory.json',
  ...buildFiles.filter(name => name !== senderExecutable).map(name => `Resources/${name}`)];
export function verifyNdiSender(bundle, { run = execFileSync, signature } = {}) {
  if (typeof signature !== 'function') throw new Error('Sender signature verification is required');
  const root = path.join(bundle, 'Contents');
  if (!lstatSync(bundle).isDirectory() || realpathSync(bundle) !== bundle) throw new Error('Sender bundle must not be an alias');
  if (readdirSync(bundle).join() !== 'Contents') throw new Error('Unexpected sender bundle material');
  exactTree(root, bundledFiles, true);
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Info.plist')], options));
  if (!isDeepStrictEqual(info, bundleInfo)) throw new Error('Expected a resource-only NDI sender BNDL');
  const resources = path.join(root, 'Resources');
  const executable = code(path.join(root, senderExecutable), run);
  const build = json(path.join(resources, 'sender-build.json'));
  validateBuild(build, materials(resources), executable, true);
  const inventory = json(path.join(resources, 'sender-inventory.json'));
  if (!keysAre(inventory, ['schema', 'internalOnly', 'distributionReady', 'signingTeam', 'buildSha256', 'executable']) ||
      inventory.schema !== 1 || inventory.internalOnly !== true || inventory.distributionReady !== false ||
      inventory.buildSha256 !== sha256(path.join(resources, 'sender-build.json')) ||
      !isDeepStrictEqual(inventory.executable, executable) || !/^[A-Z0-9]{10}$/.test(inventory.signingTeam)) {
    throw new Error('Sender signed inventory does not match its materials or executable');
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], options);
  for (const file of [bundle, path.join(root, senderExecutable)]) {
    if (signature(file).team !== inventory.signingTeam) throw new Error('Sender signing team differs from its inventory');
  }
  return { ...inventory, inventorySha256: sha256(path.join(resources, 'sender-inventory.json')) };
}
export function stageNdiSender(source, bundle, { identity, run = execFileSync, signature } = {}) {
  if (!identity || identity === '-' || typeof signature !== 'function') throw new Error('Stable sender signing and verification are required');
  const root = realpathSync(source);
  const target = path.join(realpathSync(path.dirname(bundle)), path.basename(bundle));
  if (!path.isAbsolute(bundle) || target !== bundle || path.extname(bundle) !== '.bundle' || exists(bundle) ||
      target === root || target.startsWith(root + path.sep)) throw new Error('Sender destination must be a new absolute bundle outside its source');
  const build = inspectSenderBuild(root, { run });
  mkdirSync(bundle);
  const contents = path.join(bundle, 'Contents');
  mkdirSync(contents);
  for (const relative of buildFiles) {
    const destination = path.join(contents, relative === senderExecutable ? relative : `Resources/${relative}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, relative), destination);
    if (sha256(destination) !== sha256(path.join(root, relative))) throw new Error('Sender input changed while copying');
  }
  // Reinspect the copy against the pre-copy record before any signing occurs.
  const resources = path.join(contents, 'Resources'), file = path.join(contents, senderExecutable);
  validateBuild(build, materials(resources), code(file, run));
  if (!isDeepStrictEqual(json(path.join(resources, 'sender-build.json')), build)) throw new Error('Sender provenance changed while copying');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(bundleInfo).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join('\n')}\n</dict></plist>\n`;
  writeFileSync(path.join(contents, 'Info.plist'), plist, { flag: 'wx' });
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none',
    '--identifier', 'com.saucebunny.ndi-sender.executable', file], options);
  const inventory = { schema: 1, internalOnly: true, distributionReady: false, signingTeam: signature(file).team,
    buildSha256: sha256(path.join(resources, 'sender-build.json')), executable: code(file, run) };
  writeFileSync(path.join(resources, 'sender-inventory.json'), JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx' });
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none', bundle], options);
  return verifyNdiSender(bundle, { run, signature });
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    // Node normally canonicalizes its entry module, while argv can retain a
    // /var alias or repeated separator. Canonicalize both sides so this also
    // works with --preserve-symlinks-main, without running CLI code on import.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}
if (isEntrypoint()) {
  try {
    if (process.argv.length !== 4 || !['record', 'verify'].includes(process.argv[2])) throw new Error('usage: node ndi-sender-artifact.mjs <record|verify> <sender-build>');
    const record = process.argv[2] === 'record' ? recordSenderBuild(process.argv[3]) : inspectSenderBuild(process.argv[3]);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
