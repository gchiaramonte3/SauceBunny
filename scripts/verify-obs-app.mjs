// Read-only verification of an internally signed application, never a launch
// or a claim that capture controls, notarization or distribution are ready.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applicationRequiredCode, inspectRuntime, runtimeResourcePath, validateApplicationInfo, validateCodeClosure } from './inspect-obs-runtime.mjs';
import { verifyNdiSender } from './ndi-sender-artifact.mjs';

const commandOptions = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function expectedBuildId() {
  const source = readFileSync(fileURLToPath(new URL('../src/lib/build-id.ts', import.meta.url)), 'utf8');
  const found = [...source.matchAll(/export const EXPECTED_BACKEND_BUILD_ID\s*=\s*["']([^"']+)["']/g)];
  if (found.length !== 1) throw new Error('Cannot determine the expected backend build ID');
  const backend = readFileSync(fileURLToPath(new URL('../src-tauri/src/commands/system.rs', import.meta.url)), 'utf8');
  const native = [...backend.matchAll(/pub const BACKEND_BUILD_ID:\s*&str\s*=\s*"([^"]+)"/g)];
  if (native.length !== 1 || native[0][1] !== found[0][1]) throw new Error('Frontend and backend source build IDs differ');
  return found[0][1];
}

export function inspectSignature(file, { run = execFileSync, spawn = spawnSync } = {}) {
  run('/usr/bin/codesign', ['--verify', '--strict', file], commandOptions);
  const result = spawn('/usr/bin/codesign', ['-dv', '--verbose=4', file], commandOptions);
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(details)?.[1];
  if (result.status !== 0 || result.error || result.signal || !team ||
      !/^.*flags=.*\bruntime\b.*$/m.test(details) || /Signature=adhoc|flags=.*\badhoc\b/i.test(details)) {
    throw new Error(`Invalid signature, signing team or hardened runtime: ${file}`);
  }
  return { team };
}

function checkedPath(root, relative, kind, allowLink = false) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) ||
      /[\x00-\x1f\\]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe application path: ${relative}`);
  }
  const file = path.join(root, relative);
  const stat = lstatSync(file);
  const real = realpathSync(file);
  if (!real.startsWith(root + path.sep)) throw new Error(`Application path escapes its container: ${relative}`);
  if ((!allowLink && stat.isSymbolicLink()) ||
      (kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) {
    throw new Error(`Expected a real ${kind ?? 'entry'}: ${relative}`);
  }
  return file;
}

function readJson(file) {
  if (lstatSync(file).size > 2 * 1024 * 1024) throw new Error(`Oversized application metadata: ${file}`);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid application metadata: ${file}`);
  return value;
}

function runtimeContainers(root) {
  const containers = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = checkedPath(root, path.relative(root, path.join(directory, entry.name)), undefined, true);
      if (!entry.isDirectory()) continue; // Framework aliases are checked, not followed twice.
      if (/\.(framework|plugin)$/.test(entry.name)) containers.push(file);
      walk(file);
    }
  }
  walk(root);
  return containers;
}

function validateInventory(value) {
  if (value.schema !== 1 || value.profile !== 'application' || value.internalOnly !== true ||
      value.distributionReady !== false || !Array.isArray(value.components) || value.components.length === 0) {
    throw new Error('Expected an internal-only application runtime inventory');
  }
  const paths = new Set();
  for (const component of value.components) {
    if (!component || typeof component.path !== 'string' || paths.has(component.path) || !isHash(component.sha256) ||
        !Array.isArray(component.architectures) || !component.architectures.includes('arm64') ||
        !Array.isArray(component.dependencies) || component.dependencies.some(item => typeof item !== 'string') ||
        !Array.isArray(component.rpaths) || component.rpaths.some(item => typeof item !== 'string')) {
      throw new Error('Invalid runtime component inventory');
    }
    paths.add(component.path);
    if (component.path.startsWith('MacOS/') && !applicationRequiredCode.includes(component.path)) {
      throw new Error('Diagnostic executable is not permitted in an application runtime');
    }
  }
  if (applicationRequiredCode.some(file => !paths.has(file))) throw new Error('Application runtime entrypoint is missing');
  validateCodeClosure(value.components, applicationRequiredCode);
}

export function verifyObsApp(app, {
  buildId = expectedBuildId(), inspect = inspectRuntime, run = execFileSync, spawn = spawnSync,
  verifySender = verifyNdiSender,
} = {}) {
  if (typeof buildId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(buildId)) {
    throw new Error('Invalid expected backend build ID');
  }
  const requested = path.resolve(app);
  if (!requested.endsWith('.app') || !lstatSync(requested).isDirectory()) throw new Error('Expected a real application bundle');
  const root = realpathSync(requested);
  for (const directory of ['Contents', 'Contents/MacOS', 'Contents/Resources', 'Contents/Helpers']) {
    checkedPath(root, directory, 'directory');
  }
  if (readdirSync(path.join(root, 'Contents/Helpers')).includes('OBS')) throw new Error('Legacy Helpers/OBS runtime layout is not permitted');
  for (const directory of ['Contents/Helpers/OBS.bundle', 'Contents/Helpers/OBS.bundle/Contents',
    'Contents/Helpers/OBS.bundle/Contents/Resources']) {
    checkedPath(root, directory, 'directory');
  }
  const runtimeBundle = path.join(root, 'Contents/Helpers/OBS.bundle');
  const runtime = path.join(runtimeBundle, 'Contents');
  const runtimePlist = checkedPath(runtime, 'Info.plist', 'file');
  const runtimeInfo = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', runtimePlist], commandOptions));
  validateApplicationInfo(runtimeInfo);
  const executable = checkedPath(root, 'Contents/MacOS/sauce-bunny', 'file');
  const plist = checkedPath(root, 'Contents/Info.plist', 'file');
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], commandOptions));
  if (info.CFBundleExecutable !== 'sauce-bunny' ||
      ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion'].some(key =>
        typeof info[key] !== 'string' || !info[key] || /[\x00-\x1f]/.test(info[key]))) {
    throw new Error('Invalid Sauce Bunny application metadata');
  }
  const architectures = String(run('/usr/bin/lipo', ['-archs', executable], commandOptions)).trim().split(/\s+/);
  if (!architectures.includes('arm64')) throw new Error('Application executable is missing Apple Silicon code');
  const uuidOutput = String(run('/usr/bin/dwarfdump', ['--uuid', executable], commandOptions));
  const uuids = [...uuidOutput.matchAll(/^UUID:\s*([A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})\s+\(arm64\)/gm)];
  if (uuids.length !== 1) throw new Error('Application executable has no unambiguous arm64 UUID');
  const executableUuid = uuids[0][1].toUpperCase();
  const dependencies = String(run('/usr/bin/otool', ['-arch', 'arm64', '-L', executable], commandOptions))
    .trim().split('\n').slice(1).map(line => line.trim().replace(/ \(compatibility version.*$/, ''));
  if (dependencies.some(dependency => /libobs/i.test(dependency))) throw new Error('Application executable links libobs across the process boundary');
  const strings = String(run('/usr/bin/strings', ['-a', executable], { ...commandOptions, maxBuffer: 128 * 1024 * 1024 }));
  if (!strings.includes(buildId)) throw new Error('Application executable is missing the expected build ID');

  const record = readJson(checkedPath(root, 'Contents/Resources/obs-internal-build.json', 'file'));
  const inventoryPath = checkedPath(runtime, runtimeResourcePath('application'), 'file');
  const inventory = readJson(inventoryPath);
  if (record.schema !== 1 || record.internalOnly !== true || record.distributionReady !== false || record.buildId !== buildId ||
      !isHash(record.runtimeInventorySha256) || !isHash(record.sourceExecutableSha256) ||
      record.executableUuid !== executableUuid) {
    throw new Error('Invalid or stale internal application build record');
  }
  // The source hash records provenance. Enclosing app signing changes the main
  // executable's signature bytes; its UUID and strict signature verify the
  // recorded build identity. String presence is not a live backend/frontend
  // handshake; that remains a separate packaged WKWebView acceptance gate.
  if (sha256(inventoryPath) !== record.runtimeInventorySha256) {
    throw new Error('Runtime inventory was modified after staging');
  }
  validateInventory(inventory);
  const containers = runtimeContainers(runtime);
  const observed = inspect(runtime, { profile: 'application' });
  validateInventory(observed);
  const ordered = components => [...components].sort((a, b) => a.path.localeCompare(b.path));
  if (!isDeepStrictEqual(ordered(inventory.components), ordered(observed.components))) {
    throw new Error('Signed runtime inventory does not match reinspection');
  }
  const code = inventory.components.map(component => {
    const file = checkedPath(runtime, component.path, 'file');
    if (sha256(file) !== component.sha256) throw new Error(`Runtime component was modified: ${component.path}`);
    return file;
  });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], commandOptions);
  const { team } = inspectSignature(root, { run, spawn });
  if (record.signingTeam !== team || inventory.signingTeam !== team) throw new Error('Application and runtime signing teams do not match');
  for (const file of [runtimeBundle, executable, ...code, ...containers]) {
    if (inspectSignature(file, { run, spawn }).team !== team) throw new Error(`Signing team differs from enclosing application: ${file}`);
  }
  const senderBundle = path.join(root, 'Contents/Helpers/NDISender.bundle');
  const hasSender = readdirSync(path.join(root, 'Contents/Helpers')).includes('NDISender.bundle');
  let sender;
  if (Object.hasOwn(record, 'senderInventorySha256') || hasSender) {
    if (!hasSender || !isHash(record.senderInventorySha256)) throw new Error('Missing or unrecorded NDI sender bundle');
    checkedPath(root, 'Contents/Helpers/NDISender.bundle', 'directory');
    sender = verifySender(senderBundle, { run, signature: file => inspectSignature(file, { run, spawn }) });
    if (sender.inventorySha256 !== record.senderInventorySha256 || sender.signingTeam !== team) {
      throw new Error('NDI sender inventory or signing team differs from the enclosing app');
    }
    // Reuse the existing asynchronous runtime/notices/SDK-exclusion verifier in
    // a read-only child, retaining this verifier's synchronous public API.
    run(process.execPath, [fileURLToPath(new URL('./verify-ndi-package.mjs', import.meta.url)), root], commandOptions);
  }
  return { schema: 1, app: root, bundleId: info.CFBundleIdentifier, version: info.CFBundleShortVersionString,
    bundleBuild: info.CFBundleVersion, buildId, executableUuid, signingTeam: team, componentCount: code.length,
    profile: 'application', internalOnly: true, distributionReady: false,
    buildIdEvidence: 'embedded-string-presence-only', ...(sender ? { sender: { executableUuid: sender.executable.uuid,
      inventorySha256: sender.inventorySha256, signingTeam: sender.signingTeam } } : {}) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-obs-app.mjs <application.app>');
    console.log(JSON.stringify(verifyObsApp(process.argv[2]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
