// CI-only resource preparation. Tauri's externalBin is the one sidecar list;
// smoke jobs additionally name the real binaries that must never be stubbed.
import { accessSync, chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

try {
  const [directory, flag, ...required] = process.argv.slice(2);
  if (process.env.CI !== 'true') throw new Error('Sidecar stubs are CI-only; run npm run setup for a development build.');
  if (!directory || (flag !== undefined && flag !== '--require-real')) {
    throw new Error('usage: node scripts/prepare-ci-sidecars.mjs <project-root> [--require-real <names...>]');
  }
  if (flag && required.length === 0) throw new Error('--require-real needs at least one sidecar name.');
  const root = resolve(directory);
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const entries = config.bundle?.externalBin;
  if (!Array.isArray(entries) || entries.length === 0 ||
      entries.some(entry => typeof entry !== 'string' || !/^binaries\/[a-z0-9][a-z0-9-]*$/.test(entry))) {
    throw new Error('Expected nonempty, local binaries/<name> externalBin entries.');
  }
  const names = entries.map(entry => entry.slice('binaries/'.length));
  if (new Set(names).size !== names.length) throw new Error('Duplicate externalBin entries.');
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Required sidecar is not declared: ${name}`);
  }
  function statIfPresent(path) {
    try { return lstatSync(path); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  const binaryDirectory = join(root, 'src-tauri/binaries');
  const directoryStat = statIfPresent(binaryDirectory);
  if (directoryStat && !directoryStat.isDirectory()) throw new Error('Sidecar directory must not be a symlink or file.');
  const sidecars = names.map(name => {
    const path = join(binaryDirectory, `${name}-aarch64-apple-darwin`);
    const stat = statIfPresent(path);
    if (stat && !stat.isFile()) throw new Error(`Sidecar is not a regular file: ${name}`);
    if (required.includes(name)) {
      if (!stat || stat.size === 0) throw new Error(`Required real sidecar is missing or empty: ${name}`);
      accessSync(path, constants.X_OK);
    }
    return { name, path, stat };
  });
  // Validate every required binary BEFORE writing anything. A failed download
  // must not become a successful smoke run against an empty placeholder.
  mkdirSync(binaryDirectory, { recursive: true });
  let stubs = 0;
  for (const { path, stat } of sidecars) {
    if (stat && stat.size > 0) continue; // Never truncate or chmod a real binary.
    if (!stat) closeSync(openSync(path, 'wx', 0o755));
    else chmodSync(path, 0o755); // An existing empty CI placeholder.
    stubs++;
  }
  console.log(`CI sidecars ready: ${names.length} declared, ${required.length} required real, ${stubs} unexercised stubs.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
