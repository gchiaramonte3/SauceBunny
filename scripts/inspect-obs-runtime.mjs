// Build-time, read-only inspection. No capture, permission request or OBS launch.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
export const corePath = 'Frameworks/libobs.framework/Versions/A/libobs';
export const requiredCode = [corePath, 'Frameworks/libobs-opengl.dylib',
  'PlugIns/obs-ffmpeg.plugin/Contents/MacOS/obs-ffmpeg',
  'PlugIns/sauce-obs-capture.plugin/Contents/MacOS/sauce-obs-capture',
  ...['probe', 'window-probe', 'media-probe', 'capture-probe', 'capture-overlap-probe', 'capture-service', 'media-worker', 'capture-worker', 'capture-health-tests', 'audio-buffer-tests']
    .map(name => `MacOS/saucebunny-obs-${name}`)];
export const applicationRequiredCode = [...requiredCode.slice(0, 4),
  'MacOS/saucebunny-obs-capture-service', 'MacOS/saucebunny-obs-window-probe'];

export function profileRequiredCode(profile = 'diagnostic') {
  if (profile === 'diagnostic') return requiredCode;
  if (profile === 'application') return applicationRequiredCode;
  throw new Error(`Unknown OBS runtime profile: ${profile}`);
}

export function runtimeResourcePath(profile = 'diagnostic', name = 'runtime-inventory.json') {
  profileRequiredCode(profile);
  if (!['runtime-inventory.json', 'licenses', 'source'].includes(name)) throw new Error('Unknown runtime resource');
  return profile === 'application' ? `Resources/${name}` : name;
}

export function validateApplicationInfo(info) {
  if (!info || info.CFBundlePackageType !== 'BNDL' || info.CFBundleIdentifier !== 'com.saucebunny.obs-runtime' ||
      Object.hasOwn(info, 'CFBundleExecutable') ||
      ['CFBundleVersion', 'CFBundleShortVersionString'].some(key => typeof info[key] !== 'string' || !info[key])) {
    throw new Error('Expected a resource-only OBS BNDL with no CFBundleExecutable');
  }
}

function validateApplicationLayout(directory, root) {
  const bundle = path.dirname(root);
  if (path.basename(root) !== 'Contents' || path.extname(bundle) !== '.bundle' ||
      !lstatSync(directory).isDirectory() || !lstatSync(path.dirname(path.resolve(directory))).isDirectory()) {
    throw new Error('Application runtime root must be a real .bundle/Contents directory');
  }
  if (readdirSync(bundle).some(name => name !== 'Contents')) throw new Error('Unexpected content outside runtime bundle Contents');
  const allowed = new Set(['Info.plist', 'MacOS', 'Frameworks', 'PlugIns', 'Resources', '_CodeSignature']);
  if (readdirSync(root).some(name => !allowed.has(name))) throw new Error('Application runtime data must be in Resources');
  for (const name of ['MacOS', 'Frameworks', 'PlugIns', 'Resources', 'Resources/licenses', 'Resources/source']) {
    const file = path.join(root, name);
    if (!lstatSync(file).isDirectory() || realpathSync(file) !== file) throw new Error('Application runtime directories must not be aliases');
  }
  const plist = path.join(root, 'Info.plist');
  const info = lstatSync(plist);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid application runtime Info.plist');
  validateApplicationInfo(JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])));
}

export function localDependency(dependency) {
  if (/[\x00-\x1f]/.test(dependency) || dependency.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe library path: ${dependency}`);
  }
  if (dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) return null;
  if (!dependency.startsWith('@rpath/')) throw new Error(`External library path: ${dependency}`);
  const local = dependency.slice('@rpath/'.length);
  if (!local || local.split('/').some(part => !part || part === '..' || part === '.') ||
      /[\x00-\x1f]/.test(local) || /Qt|Chromium|Helper|libndi/i.test(local)) {
    throw new Error(`Unexpected library: ${dependency}`);
  }
  return `Frameworks/${local}`;
}

export function validateRpaths(paths, binary, root) {
  const allowed = new Set(['@executable_path/../Frameworks', '@loader_path/../Frameworks',
    '@loader_path/../../../../Frameworks']);
  if (paths.some(value => !allowed.has(value))) throw new Error('Non-private runtime search path');
  for (const value of paths) {
    const resolved = path.resolve(value.replace('@executable_path', path.join(root, 'MacOS'))
      .replace('@loader_path', path.dirname(binary)));
    if (resolved !== path.join(root, 'Frameworks')) throw new Error('Runtime search path escapes Frameworks');
  }
}

export function codeClosure(components, roots) {
  const byPath = new Map(components.map(component => [component.path, component]));
  if (byPath.size !== components.length) throw new Error('Duplicate runtime code path');
  const reachable = new Set();
  const pending = roots.filter(file => byPath.has(file));
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const dependency of byPath.get(file).dependencies) {
      const local = localDependency(dependency);
      if (!local) continue;
      if (!byPath.has(local)) throw new Error(`Dependency is not inventoried code: ${local}`);
      pending.push(local);
    }
  }
  return reachable;
}

export function validateCodeClosure(components, roots = [...requiredCode, 'MacOS/obs-capture-config-tests']) {
  const reachable = codeClosure(components, roots);
  if (components.some(component => !reachable.has(component.path))) {
    throw new Error('Unexpected executable outside the required dependency graph');
  }
}

export function inspectRuntime(directory, { profile = 'diagnostic' } = {}) {
  const required = profileRequiredCode(profile);
  const root = realpathSync(directory);
  if (profile === 'application') validateApplicationLayout(directory, root);
  const inside = file => {
    const resolved = realpathSync(file);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Runtime link escapes its private directory');
    return resolved;
  };
  for (const file of required) inside(path.join(root, file));
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      inside(absolute);
      if (profile === 'application' && path.relative(root, directory) === 'MacOS' &&
          !required.includes(path.relative(root, absolute))) {
        throw new Error('Unexpected application runtime executable');
      }
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(absolute);
      // Validate symlinks, but do not traverse framework aliases a second time.
    }
  }
  walk(root);
  const components = [];
  for (const file of files.sort()) {
    if (!run('/usr/bin/file', ['-b', file]).includes('Mach-O')) continue;
    const relative = path.relative(root, file);
    if (!/^(MacOS|Frameworks|PlugIns)\//.test(relative)) throw new Error('Executable outside runtime code directories');
    if (relative.startsWith('PlugIns/') && !required.includes(relative)) {
      throw new Error('Unexpected OBS plugin executable');
    }
    if (profile === 'application' && relative.startsWith('MacOS/') && !required.includes(relative)) {
      throw new Error('Unexpected application runtime executable');
    }
    const architectures = run('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error(`Missing Apple Silicon slice: ${relative}`);
    const dependencies = run('/usr/bin/otool', ['-arch', 'arm64', '-L', file]).trim().split('\n').slice(1)
      .map(line => line.trim().replace(/ \(compatibility version.*$/, ''));
    for (const dependency of dependencies) {
      const local = localDependency(dependency);
      if (local) inside(path.join(root, local));
    }
    const commands = run('/usr/bin/otool', ['-arch', 'arm64', '-l', file]);
    const rpaths = [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(match => match[1]);
    validateRpaths(rpaths, file, root);
    components.push({ path: relative, architectures, dependencies, rpaths,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  }
  if (required.some(file => !components.some(component => component.path === file))) {
    throw new Error('Required runtime executable is missing or not Mach-O');
  }
  validateCodeClosure(components, profile === 'diagnostic'
    ? [...required, 'MacOS/obs-capture-config-tests'] : required);
  run('/bin/bash', [path.join(project, 'scripts/check-obs-core.sh'), path.join(root, corePath)]);
  return { schema: 1, profile, internalOnly: true, distributionReady: false, components };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === '--profile')) {
      throw new Error('usage: node scripts/inspect-obs-runtime.mjs <private-runtime> [--profile application|diagnostic]');
    }
    console.log(JSON.stringify(inspectRuntime(process.argv[2], { profile: process.argv[4] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
