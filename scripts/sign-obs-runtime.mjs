// Internal validation only. The enclosing app, notarization, source package
// and final distribution review are intentionally not handled by this script.
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectRuntime, runtimeResourcePath } from './inspect-obs-runtime.mjs';

try {
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!identity || identity === '-') throw new Error('A stable Apple signing identity is required; no ad-hoc fallback.');
  if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === '--profile')) {
    throw new Error('usage: node scripts/sign-obs-runtime.mjs <private-runtime> [--profile application|diagnostic]');
  }
  const profile = process.argv[4] ?? 'diagnostic';
  const root = realpathSync(process.argv[2]);
  const manifest = inspectRuntime(root, { profile });
  const containers = ['Frameworks/libobs.framework', 'PlugIns/obs-ffmpeg.plugin', 'PlugIns/sauce-obs-capture.plugin'];
  for (const relative of [...manifest.components.map(component => component.path), ...containers]) {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none',
      '--identifier', `com.saucebunny.obs.${path.basename(relative).replace(/[^A-Za-z0-9.-]/g, '-')}`,
      path.join(root, relative)], { stdio: 'pipe' });
  }
  let team;
  for (const relative of [...manifest.components.map(component => component.path), ...containers]) {
    const file = path.join(root, relative);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'pipe' });
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' });
    const foundTeam = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(signature.stderr)?.[1];
    if (signature.status !== 0 || !foundTeam ||
        !/flags=.*runtime/.test(signature.stderr) || (team && team !== foundTeam)) {
      throw new Error(`Inconsistent identity or missing hardened runtime: ${relative}`);
    }
    team = foundTeam;
  }
  // Reinspect after signing; signatures change each Mach-O's checksum.
  const signed = { ...inspectRuntime(root, { profile }), signingTeam: team, internalOnly: true };
  writeFileSync(path.join(root, runtimeResourcePath(profile)), JSON.stringify(signed, null, 2) + '\n');
  if (profile === 'application') {
    // This resource-only BNDL has no primary executable whose signature would
    // change the inventory. Seal resources after recording signed nested code.
    const bundle = path.dirname(root);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp=none', bundle], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' });
    const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
    if (signature.status !== 0 || !signature.stderr.includes(`TeamIdentifier=${team}\n`) || !/flags=.*runtime/.test(signature.stderr)) {
      throw new Error('Runtime bundle signing identity or hardened runtime differs from its components');
    }
    if (!isDeepStrictEqual(inspectRuntime(root, { profile }).components, signed.components)) {
      throw new Error('Sealing the runtime bundle modified nested code');
    }
  }
  console.log(JSON.stringify({ components: signed.components.length, profile, signingTeam: team, internalOnly: true }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
