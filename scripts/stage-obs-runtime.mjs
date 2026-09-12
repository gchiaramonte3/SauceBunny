// Copy a validated diagnostic runtime into a new, private application runtime.
// No compilation, helper execution, capture, signing, installation or publication.
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { applicationRequiredCode, codeClosure, inspectRuntime, runtimeResourcePath } from './inspect-obs-runtime.mjs';

const bundleInfo = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.saucebunny.obs-runtime</string>
<key>CFBundleName</key><string>OBS</string>
<key>CFBundlePackageType</key><string>BNDL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>\n`;

export function validateSourceInventory(record, observed) {
  if (record?.schema !== 1 || (record.profile ?? 'diagnostic') !== 'diagnostic' ||
      record.distributionReady !== false || (record.internalOnly !== undefined && record.internalOnly !== true) ||
      !Array.isArray(record.components)) {
    throw new Error('Source must have a diagnostic runtime inventory');
  }
  const sorted = components => [...components].sort((a, b) => String(a?.path).localeCompare(String(b?.path)));
  if (!isDeepStrictEqual(sorted(record.components), sorted(observed.components))) {
    throw new Error('Source runtime inventory does not match its code, hashes or dependencies');
  }
}

export function stagingDestination(source, destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.resolve(destination) !== destination) {
    throw new Error('Destination must be a new, normalized absolute directory');
  }
  // Resolve parent aliases before comparing containment; /tmp is an alias on macOS.
  const target = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
  if (target === source || target.startsWith(source + path.sep)) {
    throw new Error('Destination must be outside the source runtime');
  }
  try {
    lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return target;
    throw error;
  }
  throw new Error('Destination already exists; refusing to replace it');
}

export function applicationCopyPlan(components) {
  const selected = codeClosure(components, applicationRequiredCode);
  if (applicationRequiredCode.some(file => !selected.has(file))) {
    throw new Error('Source is missing application runtime code');
  }
  const units = new Set(['licenses', 'source']);
  for (const file of selected) {
    if (file.startsWith('PlugIns/') || /^Frameworks\/[^/]+\.framework\//.test(file)) {
      units.add(file.split('/').slice(0, 2).join('/'));
    } else {
      units.add(file);
    }
  }
  return { components: components.filter(component => selected.has(component.path)), units: [...units].sort() };
}

export function validateCopyLinks(root, units) {
  const included = relative => units.some(unit => relative === unit || relative.startsWith(unit + '/'));
  const resource = relative => /^(licenses|source)(\/|$)/.test(relative);
  function visit(file) {
    const resolved = realpathSync(file);
    if (!resolved.startsWith(root + path.sep)) throw new Error('Runtime copy escapes its source directory');
    const info = lstatSync(file);
    if (info.isSymbolicLink()) {
      if (path.isAbsolute(readlinkSync(file)) || !included(path.relative(root, resolved)) ||
          resource(path.relative(root, file)) !== resource(path.relative(root, resolved))) {
        throw new Error('Runtime link cannot be relocated inside the application profile');
      }
    } else if (info.isDirectory()) {
      for (const name of readdirSync(file)) visit(path.join(file, name));
    } else if (!info.isFile()) {
      throw new Error('Unsupported runtime file type');
    }
  }
  for (const unit of units) visit(path.join(root, unit));
}

export function stageRuntime(source, destination) {
  const root = realpathSync(source);
  const target = stagingDestination(root, destination);
  if (path.basename(target) !== 'Contents' || path.extname(path.dirname(target)) !== '.bundle' ||
      readdirSync(path.dirname(target)).length !== 0) {
    throw new Error('Application destination must be Contents inside an empty .bundle directory');
  }
  const observed = inspectRuntime(root);
  const recorded = JSON.parse(readFileSync(path.join(root, 'runtime-inventory.json'), 'utf8'));
  validateSourceInventory(recorded, observed);
  const plan = applicationCopyPlan(observed.components);
  validateCopyLinks(root, plan.units);
  // mkdir is exclusive; a destination created after preflight is never reused.
  mkdirSync(target);
  for (const unit of plan.units) {
    const to = path.join(target, ['licenses', 'source'].includes(unit) ? runtimeResourcePath('application', unit) : unit);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(root, unit), to, { recursive: true, dereference: false,
      verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  writeFileSync(path.join(target, 'Info.plist'), bundleInfo, { flag: 'wx' });
  const staged = inspectRuntime(target, { profile: 'application' });
  if (!isDeepStrictEqual(staged.components, plan.components)) {
    throw new Error('Staged runtime code changed while copying; no inventory was written');
  }
  writeFileSync(path.join(target, runtimeResourcePath('application')), JSON.stringify(staged, null, 2) + '\n', { flag: 'wx' });
  return staged;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: node scripts/stage-obs-runtime.mjs <diagnostic-runtime> <empty-bundle>/Contents');
    console.log(JSON.stringify(stageRuntime(process.argv[2], process.argv[3]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
