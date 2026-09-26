// First-party native helper provenance. UUID survives release re-signing;
// source hashes prevent a stale helper being bundled after source edits.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const [operation, directory] = process.argv.slice(2);
if (!['stamp', 'verify'].includes(operation) || !directory) throw new Error('usage: audio-analysis-runtime.mjs stamp|verify <runtime-directory>');
const runtime = resolve(directory);
const binary = join(runtime, 'saucebunny-audio-analysis');
if (!lstatSync(binary).isFile()) throw new Error('Audio analysis helper must be a regular file');
const sources = ['swift-sidecar/Package.swift', 'swift-sidecar/Package.resolved',
  'swift-sidecar/Sources/AudioEvidenceCore/AudioWindows.swift',
  'swift-sidecar/Sources/saucebunny-audio-analysis/main.swift', 'scripts/build-audio-analysis.sh'];
const hashes = Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
const uuid = execFileSync('xcrun', ['dwarfdump', '--uuid', binary], { encoding: 'utf8' }).match(/^UUID: ([A-F0-9-]+) \(arm64\)/m)?.[1];
if (!uuid) throw new Error('Audio helper must be an arm64 Mach-O executable with a build UUID');
const dependencies = execFileSync('otool', ['-L', binary], { encoding: 'utf8' }).split('\n').slice(1).filter(line => line.trim());
if (!dependencies.length || dependencies.some(line => !/^\s+(\/usr\/lib\/|\/System\/Library\/)/.test(line))) {
  throw new Error('Audio helper links a non-system dependency');
}
const version = execFileSync('xcrun', ['vtool', '-show-build', binary], { encoding: 'utf8' }).match(/\bminos\s+(\d+)(?:\.(\d+))?/);
if (!version || Number(version[1]) > 14 || (Number(version[1]) === 14 && Number(version[2] ?? 0) > 0)) {
  throw new Error('Audio helper does not support the macOS 14 application floor');
}
const expected = { schema: 'saucebunny.audio-runtime.v1', uuid, sources: hashes };
const manifest = join(runtime, 'runtime-manifest.json');
if (operation === 'stamp') writeFileSync(manifest, JSON.stringify(expected, null, 2) + '\n', { flag: 'wx' });
else if (JSON.stringify(JSON.parse(readFileSync(manifest, 'utf8'))) !== JSON.stringify(expected)) {
  throw new Error('Audio analysis helper is stale or differs from its source receipt; rebuild it');
}
console.log(`Audio analysis runtime ${operation}: verified system linkage, macOS floor and source receipt`);
