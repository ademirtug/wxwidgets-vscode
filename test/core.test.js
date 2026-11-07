'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jsonc = require('jsonc-parser');
const core = require('../src/core');
const windowsSdk = {
  inspectSdk: (root, configuration) => core.inspectSdk(root, configuration, { platform: 'win32' }),
  findSdk: (folder, configured, last, env, configuration) => core.findSdk(folder, configured, last, env, configuration, { platform: 'win32' })
};

async function temp(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wxwidgets-test-'));
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}
async function file(root, relative, content = '') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}
async function sdkFixture(root, configurations = ['Debug', 'Release']) {
  await file(root, 'include/wx/wx.h');
  await file(root, 'include/wx/version.h');
  for (const config of configurations) {
    const suffix = config === 'Debug' ? 'd' : '';
    const lib = 'lib/vc14x_x64_dll/';
    for (const name of [`wxmsw33u${suffix}_core.lib`, `wxbase33u${suffix}.lib`,
      `mswu${suffix}/wx/setup.h`, `wxmsw332u${suffix}_core_vc14x_x64.dll`, `wxbase332u${suffix}_vc14x_x64.dll`]) {
      await file(root, lib + name);
    }
  }
}

test('project names reject traversal, Windows devices, and unsafe identifiers', () => {
  for (const name of ['../App', 'My App', 'CON', 'lpt1', '', '1app', 'a'.repeat(65), 'x&calc']) assert.equal(core.validName(name), false);
  for (const name of ['App', 'Hello_123', 'a'.repeat(64)]) assert.equal(core.validName(name), true);
});

test('new project includes binary icon, metadata, isolated builds, and working configurations', async t => {
  const parent = await temp(t);
  const template = path.join(__dirname, '..', 'templates', 'wxapp-cmake');
  const folder = await core.createProject(template, parent, 'HelloApp', 'C:\\dev\\wx', { platform: 'win32' });
  assert.equal(await core.isProject(folder), true);
  assert.deepEqual(await core.projectInfo(folder), { name: 'HelloApp', splitBuilds: true, macBundle: true });
  assert.match(await fs.readFile(path.join(folder, 'main.cpp'), 'utf8'), /"HelloApp"/);
  assert.equal((await fs.readFile(path.join(folder, '.wxroot'), 'utf8')).trim(), 'C:\\dev\\wx');
  assert.deepEqual(await fs.readFile(path.join(folder, 'resources/app.ico')), await fs.readFile(path.join(template, 'resources/app.ico')));
  const script = await fs.readFile(path.join(folder, 'scripts/build.ps1'), 'utf8');
  assert.match(script, /Join-Path \(Join-Path \$projectRoot 'build'\) \$Configuration/);
  assert.match(script, /\[switch\]\$BootstrapIfMissing = \$false/);
  const tasks = jsonc.parse(await fs.readFile(path.join(folder, '.vscode/tasks.json'), 'utf8')).tasks;
  assert.deepEqual(tasks.map(t => t.configuration), ['Debug', 'Release']);
  assert.ok(tasks.every(t => t.group === 'build'));
  const launches = jsonc.parse(await fs.readFile(path.join(folder, '.vscode/launch.json'), 'utf8')).configurations;
  assert.match(launches[0].program, /build\/Debug\/bin\/HelloApp.exe$/);
  assert.match(launches[1].program, /build\/Release\/bin\/HelloApp.exe$/);
});

test('creation refuses an existing destination and preserves its content', async t => {
  const parent = await temp(t);
  await file(parent, 'Existing/keep.txt', 'keep');
  await assert.rejects(core.createProject(path.join(__dirname, '../templates/wxapp-cmake'), parent, 'Existing'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(parent, 'Existing/keep.txt'), 'utf8'), 'keep');
});

test('setup preserves comments and user configurations and is idempotent', async t => {
  const root = await temp(t);
  await file(root, 'CMakeLists.txt', 'project(Existing)\nfind_package(wxWidgets REQUIRED COMPONENTS core base)');
  await file(root, 'scripts/build.ps1');
  await file(root, '.vscode/tasks.json', '{\n// top\n"version":"2.0.0", "tasks":[\n// user task\n{"label":"Custom","type":"shell","command":"echo hello"},\n{"label":"wxWidgets: Build (Debug)","type":"shell","command":"custom build"}\n]}');
  await file(root, '.vscode/launch.json', '{"version":"0.2.0","configurations":[/* keep args */{"name":"wxWidgets: Debug","args":["keep"]}]}');
  await core.configureProject(root, { platform: 'win32' });
  const first = await fs.readFile(path.join(root, '.vscode/tasks.json'), 'utf8');
  assert.match(first, /\/\/ user task/);
  assert.match(first, /custom build/);
  assert.equal(jsonc.parse(first).tasks.length, 3);
  const launch = await fs.readFile(path.join(root, '.vscode/launch.json'), 'utf8');
  assert.match(launch, /\/\* keep args \*\//);
  assert.deepEqual(jsonc.parse(launch).configurations[0].args, ['keep']);
  assert.match(jsonc.parse(launch).configurations[1].program, /build\/bin\/Existing.exe$/);
  await core.configureProject(root, { platform: 'win32' });
  assert.equal(await fs.readFile(path.join(root, '.vscode/tasks.json'), 'utf8'), first);
});

test('setup rejects invalid JSON without rewriting the file', async t => {
  const root = await temp(t);
  await file(root, '.wxwidgets.json', '{"schemaVersion":1,"name":"App"}');
  const original = '{ broken';
  await file(root, '.vscode/tasks.json', original);
  await assert.rejects(core.configureProject(root), /invalid JSON/);
  assert.equal(await fs.readFile(path.join(root, '.vscode/tasks.json'), 'utf8'), original);
});

test('SDK validation checks requested configuration, runtime DLLs, and matching versions', async t => {
  const root = await temp(t);
  await sdkFixture(root, ['Debug']);
  assert.equal((await windowsSdk.inspectSdk(root, 'Debug')).valid, true);
  assert.equal((await windowsSdk.inspectSdk(root, 'Release')).valid, false);
  await fs.unlink(path.join(root, 'lib/vc14x_x64_dll/wxbase33ud.lib'));
  await file(root, 'lib/vc14x_x64_dll/wxbase32ud.lib');
  assert.equal((await windowsSdk.inspectSdk(root, 'Debug')).valid, false);
  await file(root, 'lib/vc14x_x64_dll/wxbase33ud.lib');
  await fs.unlink(path.join(root, 'lib/vc14x_x64_dll/wxmsw332ud_core_vc14x_x64.dll'));
  assert.equal((await windowsSdk.inspectSdk(root, 'Debug')).valid, false);
});

test('explicit invalid SDK is respected instead of falling back to a remembered SDK', async t => {
  const root = await temp(t);
  const sdk = path.join(root, 'sdk');
  await sdkFixture(sdk);
  assert.equal((await windowsSdk.findSdk(root, path.join(root, 'missing'), sdk, {}, 'Debug')).valid, false);
  await file(root, '.wxroot', 'missing');
  assert.equal((await windowsSdk.findSdk(root, sdk, sdk, {}, 'Debug')).valid, false);
});

test('relative .wxroot is resolved against the project and takes precedence', async t => {
  const root = await temp(t);
  const sdk = path.join(root, 'sdk');
  await sdkFixture(sdk);
  await file(root, '.wxroot', 'sdk');
  const result = await windowsSdk.findSdk(root, 'missing', undefined, {}, 'Release');
  assert.equal(result.valid, true);
  assert.equal(result.root, sdk);
});

test('unconfigured SDK can use remembered path or WXWIN and sources alone are rejected', async t => {
  const root = await temp(t);
  const sdk = path.join(root, 'sdk');
  await sdkFixture(sdk);
  assert.equal((await windowsSdk.findSdk(root, '', sdk, {}, 'Debug')).valid, true);
  assert.equal((await windowsSdk.findSdk(root, '', '', { WXWIN: sdk }, 'Release')).valid, true);
  assert.equal((await windowsSdk.inspectSdk(root)).valid, false);
});
