// Assemble a NEW internal-test app. Never launch, install, notarize or publish.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageRuntime } from './stage-obs-runtime.mjs';
import { runtimeResourcePath } from './inspect-obs-runtime.mjs';
import { expectedBuildId, inspectSignature, verifyObsApp } from './verify-obs-app.mjs';
import { inspectSenderBuild, stageNdiSender } from './ndi-sender-artifact.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function exists(file) {
  try { lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const within = (file, directory) => file === directory || file.startsWith(directory + path.sep);

export function stageObsApp(source, runtime, destination, {
  identity = process.env.APPLE_SIGNING_IDENTITY, buildId = expectedBuildId(),
  run = execFileSync, stage = stageRuntime, signature = inspectSignature, verify = verifyObsApp,
  sender, inspectSender = inspectSenderBuild, stageSender = stageNdiSender,
} = {}) {
  if (!identity || identity === '-') throw new Error('A stable Apple signing identity is required; no ad-hoc fallback.');
  if (!path.isAbsolute(destination) || path.extname(destination) !== '.app') {
    throw new Error('Destination must be a new absolute .app path.');
  }
  const sourceApp = realpathSync(source), sourceRuntime = realpathSync(runtime);
  const target = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
  if (exists(target)) throw new Error('Destination already exists; no app will be overwritten.');
  if (within(target, sourceApp) || within(target, sourceRuntime)) throw new Error('Destination must be outside both source artifacts.');
  if (/(^|\/)Applications(\/|$)/.test(target)) throw new Error('Internal-test staging does not install into Applications.');
  if (path.extname(sourceApp) !== '.app') throw new Error('Source must be a built .app.');
  if (['OBS', 'OBS.bundle'].some(name => exists(path.join(sourceApp, 'Contents/Helpers', name)))) {
    throw new Error('Source app already contains OBS; use a clean build.');
  }
  if (exists(path.join(sourceApp, 'Contents/Helpers/NDISender.bundle'))) throw new Error('Source app already contains an NDI sender; use a clean build.');
  const senderSource = sender === undefined ? undefined : realpathSync(sender);
  if (senderSource && within(target, senderSource)) throw new Error('Destination must be outside the sender artifact.');
  if (senderSource) inspectSender(senderSource, { run });
  const executable = path.join(sourceApp, 'Contents/MacOS/sauce-bunny');
  if (realpathSync(executable) !== executable) throw new Error('App executable must not be a symlink.');
  const strings = run('/usr/bin/strings', [executable], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (!strings.includes(buildId)) throw new Error('Source app is missing the expected build ID; rebuild from current source first.');
  const uuids = run('/usr/bin/dwarfdump', ['--uuid', executable], { encoding: 'utf8' });
  const executableUuid = /^UUID: ([A-F0-9-]{36}) \(arm64\)/m.exec(uuids)?.[1];
  if (!executableUuid) throw new Error('Source app has no Apple Silicon executable UUID.');
  const sourceIdentity = signature(sourceApp);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', sourceApp], { stdio: 'pipe' });
  const sourceExecutableSha256 = sha256(executable);

  // Exclusive creation protects the destination, including an empty directory
  // or symlink introduced since the preflight. Failed artifacts stay available
  // for diagnosis; they are never opened or reported as verified.
  mkdirSync(target);
  try {
    run('/usr/bin/ditto', [sourceApp, target], { stdio: 'pipe' });
    if (sha256(path.join(target, 'Contents/MacOS/sauce-bunny')) !== sourceExecutableSha256) {
      throw new Error('Source executable changed while copying; rebuild from a stable input.');
    }
    const helpers = path.join(target, 'Contents/Helpers');
    mkdirSync(helpers, { recursive: true });
    if (realpathSync(helpers) !== helpers) throw new Error('App Helpers must not be a symlink.');
    const runtimeBundle = path.join(helpers, 'OBS.bundle');
    mkdirSync(runtimeBundle);
    const stagedRuntime = path.join(runtimeBundle, 'Contents');
    stage(sourceRuntime, stagedRuntime);
    run(process.execPath, [path.join(project, 'scripts/sign-obs-runtime.mjs'), stagedRuntime, '--profile', 'application'], {
      stdio: 'pipe', env: { ...process.env, APPLE_SIGNING_IDENTITY: identity },
    });
    const senderInventory = senderSource ? stageSender(senderSource, path.join(helpers, 'NDISender.bundle'), { identity, run, signature }) : undefined;
    if (senderInventory && senderInventory.signingTeam !== sourceIdentity.team) throw new Error('NDI sender signing team differs from the enclosing app.');
    const resources = path.join(target, 'Contents/Resources');
    if (realpathSync(resources) !== resources) throw new Error('App Resources must not be a symlink.');
    const record = {
      schema: 1, internalOnly: true, distributionReady: false, buildId,
      signingTeam: sourceIdentity.team,
      runtimeInventorySha256: sha256(path.join(stagedRuntime, runtimeResourcePath('application'))),
      sourceExecutableSha256, executableUuid,
      ...(senderInventory ? { senderInventorySha256: senderInventory.inventorySha256 } : {}),
    };
    // Signing the resource seal changes the main Mach-O signature. Record the
    // source hash as provenance, then verify UUID continuity and the final
    // signature instead of creating a circular resource/executable checksum.
    writeFileSync(path.join(resources, 'obs-internal-build.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    writeFileSync(path.join(resources, 'OBS-INTERNAL-TEST.txt'),
      'Internal OBS capture test build. Not for distribution.\n' +
      'Runtime: Contents/Helpers/OBS.bundle/Contents; component notices: Resources/licenses within that runtime.\n' +
      (senderInventory ? 'NDI sender: Contents/Helpers/NDISender.bundle; MIT source/rebuild materials: Contents/Resources/source within that bundle.\n' : '') +
      'Complete corresponding-source materials, package review, notarization and release acceptance remain separate gates.\n', { flag: 'wx' });
    run('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none',
      '--entitlements', path.join(project, 'src-tauri/entitlements.plist'), target], { stdio: 'pipe' });
    return { app: target, ...verify(target, { buildId }) };
  } catch (error) {
    throw new Error(`Internal app staging failed; unverified artifact retained at ${target}: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (![5, 6].includes(process.argv.length)) throw new Error('usage: node scripts/stage-obs-app.mjs <built-app> <diagnostic-runtime> <new-absolute-output.app> [sender-build]');
    console.log(JSON.stringify(stageObsApp(...process.argv.slice(2, 5), { sender: process.argv[5] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
