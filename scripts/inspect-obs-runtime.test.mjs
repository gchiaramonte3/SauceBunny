import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationRequiredCode, codeClosure, inspectRuntime, localDependency,
  profileRequiredCode, requiredCode, runtimeResourcePath, validateApplicationInfo,
  validateRpaths, validateCodeClosure } from './inspect-obs-runtime.mjs';

test('system libraries are allowed, private references remain inside Frameworks', () => {
  assert.equal(localDependency('/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit'), null);
  assert.equal(localDependency('/usr/lib/libSystem.B.dylib'), null);
  assert.equal(localDependency('@rpath/libavcodec.dylib'), 'Frameworks/libavcodec.dylib');
  assert.equal(localDependency('@rpath/libobs.framework/Versions/A/libobs'),
    'Frameworks/libobs.framework/Versions/A/libobs');
});
test('every executable must be an approved entrypoint or its actual dependency', () => {
  const components = [
    { path: 'MacOS/test-worker', dependencies: ['@rpath/liba.dylib'] },
    { path: 'Frameworks/liba.dylib', dependencies: ['@rpath/liba.dylib', '@rpath/libb.dylib'] },
    { path: 'Frameworks/libb.dylib', dependencies: ['/usr/lib/libSystem.B.dylib'] },
  ];
  const roots = ['MacOS/test-worker'];
  validateCodeClosure(components, roots);
  assert.throws(() => validateCodeClosure([...components, { path: 'MacOS/extra', dependencies: [] }], roots));
  assert.throws(() => validateCodeClosure([...components, { path: 'Frameworks/extra.dylib', dependencies: [] }], roots));
  assert.throws(() => validateCodeClosure(components.slice(0, 2), roots));
});
test('external installations, traversal, UI runtimes and NDI linking are rejected', () => {
  for (const value of ['/Applications/OBS.app/libobs', '/opt/homebrew/lib/libavcodec.dylib',
    '@rpath/../libobs', '@rpath//libobs', '@rpath/./libobs', '@rpath/QtCore.framework/QtCore',
    '@rpath/Chromium.dylib', '@rpath/SomeHelper', '@rpath/libndi.dylib', '@rpath/bad\nname',
    '@loader_path/libavcodec.dylib', '@rpath/', '/usr/lib/../../tmp/evil', '/System/Library/../evil']) {
    assert.throws(() => localDependency(value), undefined, value);
  }
});
test('library search paths cannot reach developer or installed app directories', () => {
  validateRpaths(['@executable_path/../Frameworks', '@loader_path/../Frameworks'], '/bundle/MacOS/worker', '/bundle');
  validateRpaths(['@loader_path/../../../../Frameworks'], '/bundle/PlugIns/capture.plugin/Contents/MacOS/capture', '/bundle');
  for (const value of ['/Applications/OBS.app/Contents/Frameworks', '/private/tmp/build',
    '/opt/homebrew/lib', '@loader_path/../../../../../Frameworks']) {
    assert.throws(() => validateRpaths([value], '/bundle/MacOS/worker', '/bundle'));
  }
  assert.throws(() => validateRpaths(['@loader_path/../../../../Frameworks'], '/bundle/MacOS/worker', '/bundle'));
});

test('application profile requires discovery and shared service, with no diagnostic entrypoints', () => {
  assert.equal(profileRequiredCode(), requiredCode);
  assert.equal(profileRequiredCode('application'), applicationRequiredCode);
  assert.deepEqual(applicationRequiredCode.filter(file => file.startsWith('MacOS/')), [
    'MacOS/saucebunny-obs-capture-service', 'MacOS/saucebunny-obs-window-probe',
  ]);
  assert.equal(applicationRequiredCode.filter(file => file.startsWith('PlugIns/')).length, 2);
  assert.throws(() => profileRequiredCode('release'), /Unknown/);
  assert.throws(() => inspectRuntime('/not-read', { profile: 'release' }), /Unknown/);
});

test('application metadata is a resource-only BNDL and diagnostic resource paths stay flat', () => {
  const info = { CFBundleIdentifier: 'com.saucebunny.obs-runtime', CFBundlePackageType: 'BNDL',
    CFBundleVersion: '1', CFBundleShortVersionString: '1.0' };
  validateApplicationInfo(info);
  for (const change of [{ CFBundleExecutable: 'saucebunny-obs-capture-service' }, { CFBundleExecutable: '' },
    { CFBundlePackageType: 'APPL' }, { CFBundleIdentifier: 'another.bundle' }, { CFBundleVersion: '' }]) {
    assert.throws(() => validateApplicationInfo({ ...info, ...change }), /resource-only/);
  }
  assert.equal(runtimeResourcePath(), 'runtime-inventory.json');
  assert.equal(runtimeResourcePath('application'), 'Resources/runtime-inventory.json');
  for (const name of ['licenses', 'source']) {
    assert.equal(runtimeResourcePath('diagnostic', name), name);
    assert.equal(runtimeResourcePath('application', name), `Resources/${name}`);
  }
  assert.throws(() => runtimeResourcePath('application', '../outside'), /Unknown/);
});

test('application closure retains indirect libraries and rejects diagnostic or orphaned code', () => {
  const roots = applicationRequiredCode.map(file => ({ path: file, dependencies: [] }));
  roots[0].dependencies.push('@rpath/liba.dylib');
  const libraries = [
    { path: 'Frameworks/liba.dylib', dependencies: ['@rpath/libb.dylib'] },
    { path: 'Frameworks/libb.dylib', dependencies: [] },
  ];
  const components = [...roots, ...libraries];
  assert.equal(codeClosure(components, applicationRequiredCode).size, components.length);
  validateCodeClosure(components, applicationRequiredCode);
  for (const file of requiredCode.filter(file => !applicationRequiredCode.includes(file))) {
    assert.throws(() => validateCodeClosure([...components, { path: file, dependencies: [] }], applicationRequiredCode), /Unexpected/);
  }
  assert.throws(() => codeClosure([...components, roots[0]], applicationRequiredCode), /Duplicate/);
});
