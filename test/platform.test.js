'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const jsonc = require('jsonc-parser');
const { detectCapabilities, splitFlags, findExecutable } = require('../src/platform');
const { inspectUnixSdk } = require('../src/unix-sdk');
const { buildPlan } = require('../src/build');
const core = require('../src/core');

async function temp(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wx-platform-test-'));
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}
async function file(root, relative, content = '') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
  await fs.chmod(target, 0o755);
  return target;
}
const cmakeVersion = async () => 'cmake version 3.28.1';

test('Linux capabilities select compiler, build tool, and GDB independently', async () => {
  const host = await detectCapabilities({ platform: 'linux', environment: {},
    find: async name => ['cmake', 'c++', 'make', 'gdb'].includes(name) ? `/tools/${name}` : undefined,
    run: cmakeVersion });
  assert.equal(host.canBuild, true);
  assert.equal(host.generator, 'Unix Makefiles');
  assert.equal(host.compiler, '/tools/c++');
  assert.equal(host.debugger.type, 'cppdbg');
  assert.equal(host.debugger.mode, 'gdb');
});

test('macOS arm64 uses Clang, Ninja, and native LLDB DAP when available', async () => {
  const host = await detectCapabilities({ platform: 'darwin', arch: 'arm64', environment: {},
    find: async name => ['cmake', 'clang++', 'ninja', 'lldb-dap'].includes(name) ? `/tools/${name}` : undefined,
    run: cmakeVersion });
  assert.equal(host.canBuild, true);
  assert.equal(host.arch, 'arm64');
  assert.equal(host.generator, 'Ninja');
  assert.equal(host.debugger.type, 'wxwidgets-lldb');
});

test('macOS can use the Microsoft C/C++ LLDB MI adapter as a fallback', async () => {
  const mi = path.join('cpptools', 'debugAdapters', 'lldb-mi', 'bin', 'lldb-mi');
  const host = await detectCapabilities({ platform: 'darwin', environment: {}, cpptoolsPath: 'cpptools',
    find: async name => name === mi ? mi : ['cmake', 'clang++', 'make'].includes(name) ? `/tools/${name}` : undefined,
    run: cmakeVersion });
  assert.equal(host.canBuild, true);
  assert.equal(host.debugger.mode, 'lldb');
  assert.equal(host.debugger.path, mi);
});

test('missing or outdated tools give actionable capability results', async () => {
  const host = await detectCapabilities({ platform: 'linux', environment: {},
    find: async name => name === 'cmake' ? '/tools/cmake' : undefined,
    run: async () => 'cmake version 3.10.0' });
  assert.equal(host.canBuild, false);
  assert.match(host.issues.join(' '), /3.20/);
  assert.match(host.issues.join(' '), /compiler/);
  assert.match(host.issues.join(' '), /Ninja or Make/);
  assert.equal(host.debugger, undefined);
});

test('Windows capabilities locate VS tools and its bundled CMake and Ninja', async () => {
  const host = await detectCapabilities({ platform: 'win32', environment: {},
    find: async name => /vswhere\.exe$/.test(name) ? name : /cmake\.exe$/i.test(name) ? name : /ninja\.exe$/i.test(name) ? name : undefined,
    run: async file => /vswhere\.exe$/.test(file) ? 'C:/Visual Studio' : 'cmake version 4.0.0' });
  assert.equal(host.canBuild, true);
  assert.match(host.vsDevCmd, /VsDevCmd.bat$/);
  assert.equal(host.generator, 'Ninja');
  assert.equal(host.debugger.type, 'cppvsdbg');
});

test('SDK flag parsing preserves quoted paths without running a shell', () => {
  assert.deepEqual(splitFlags('-I"/opt/My SDK/include" -L\'/opt/My SDK/lib\' -lwx_baseu-3.2'),
    ['-I/opt/My SDK/include', '-L/opt/My SDK/lib', '-lwx_baseu-3.2']);
  assert.throws(() => splitFlags('-I"unterminated'), /malformed/);
});

async function unixFixture(t, suffix = '.so') {
  const root = await temp(t);
  await file(root, 'bin/wx-config', '#!/bin/sh\n');
  const include = path.dirname(path.dirname(await file(root, 'include/wx-3.3/wx/wx.h')));
  const setup = path.dirname(path.dirname(await file(root, 'lib/wx/include/gtk3-unicode/wx/setup.h')));
  await file(root, 'lib/libwx_gtk3u_core-3.3' + suffix);
  await file(root, 'lib/libwx_baseu-3.3' + suffix);
  const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
  const probe = async (command, args) => {
    assert.equal(command, path.join(root, 'bin', 'wx-config'));
    assert.ok(!args.some(arg => arg.includes('--debug')), 'Application Debug builds can use system wx libraries');
    return { '--version': '3.3.2', '--prefix': root,
      '--cxxflags': `-I${quote(include)} -I${quote(setup)} -D_FILE_OFFSET_BITS=64`,
      '--libs': `-L${quote(path.join(root, 'lib'))} -lwx_gtk3u_core-3.3 -lwx_baseu-3.3` }[args[0]];
  };
  return { root, probe };
}

test('Unix SDK discovery validates headers, setup header, and compiled libraries', async t => {
  const { root, probe } = await unixFixture(t);
  const options = { platform: 'linux', run: probe };
  assert.equal((await inspectUnixSdk(root, 'Debug', options)).valid, true);
  await fs.unlink(path.join(root, 'lib/libwx_baseu-3.3.so'));
  assert.equal((await inspectUnixSdk(root, 'Release', options)).valid, false);
});

test('macOS SDK validation accepts dylib libraries and direct wx-config locations', async t => {
  const { root, probe } = await unixFixture(t, '.dylib');
  const sdk = await inspectUnixSdk(path.join(root, 'bin', 'wx-config'), 'Debug', { platform: 'darwin', run: probe });
  assert.equal(sdk.valid, true);
  assert.equal(sdk.configExecutable, path.join(root, 'bin', 'wx-config'));
});

test('a legacy Windows SDK path does not prevent detecting the local Unix SDK', async t => {
  const { root, probe } = await unixFixture(t);
  const project = await temp(t);
  await file(project, '.wxroot', 'C:\\dev\\wx');
  const sdk = await core.findSdk(project, '', root, { PATH: '' }, 'Debug', { platform: 'linux', run: probe });
  assert.equal(sdk.valid, true);
  assert.equal(await fs.readFile(path.join(project, '.wxroot'), 'utf8'), 'C:\\dev\\wx');
  await file(project, '.wxroot.linux', path.join(project, 'missing'));
  assert.equal((await core.findSdk(project, '', root, { PATH: '' }, 'Debug', { platform: 'linux', run: probe })).valid, false);
});

test('portable project setup adapts generated launch fields while preserving custom arguments', async t => {
  const root = await temp(t);
  const folder = await core.createProject(path.join(__dirname, '../templates/wxapp-cmake'), root, 'PortableApp', '/opt/wx',
    { platform: 'darwin', debugger: { type: 'wxwidgets-lldb' } });
  const launchFile = path.join(folder, '.vscode/launch.json');
  let text = await fs.readFile(launchFile, 'utf8');
  let launch = jsonc.parse(text).configurations[0];
  assert.equal(launch.type, 'wxwidgets-lldb');
  assert.match(launch.program, /PortableApp.app\/Contents\/MacOS\/PortableApp$/);
  text = jsonc.applyEdits(text, jsonc.modify(text, ['configurations', 0, 'args'], ['keep this argument'], {}));
  await fs.writeFile(launchFile, text);
  await core.configureProject(folder, { platform: 'linux', debugger: { type: 'cppdbg', mode: 'gdb', path: '/usr/bin/gdb' } });
  launch = jsonc.parse(await fs.readFile(launchFile, 'utf8')).configurations[0];
  assert.equal(launch.MIMode, 'gdb');
  assert.equal(launch.miDebuggerPath, '/usr/bin/gdb');
  assert.deepEqual(launch.args, ['keep this argument']);
  assert.ok(!launch.program.endsWith('.exe'));
  assert.equal(launch.stopOnEntry, undefined);
  const customized = jsonc.parse(await fs.readFile(launchFile, 'utf8'));
  customized.configurations[0].miDebuggerPath = '/custom/gdb';
  await fs.writeFile(launchFile, JSON.stringify(customized, null, 2));
  await core.configureProject(folder, { platform: 'linux', debugger: { type: 'cppdbg', mode: 'gdb', path: '/usr/bin/gdb' } });
  assert.equal(jsonc.parse(await fs.readFile(launchFile, 'utf8')).configurations[0].miDebuggerPath, '/custom/gdb');
  await core.configureProject(folder, { platform: 'win32' });
  launch = jsonc.parse(await fs.readFile(launchFile, 'utf8')).configurations[0];
  assert.equal(launch.type, 'cppvsdbg');
  assert.ok(launch.program.endsWith('.exe'));
  assert.equal(launch.MIMode, undefined);
  assert.deepEqual(launch.args, ['keep this argument']);
  assert.equal((await fs.readFile(path.join(folder, '.wxroot'), 'utf8')).trim(), '');
  assert.equal((await fs.readFile(path.join(folder, '.wxroot.darwin'), 'utf8')).trim(), '/opt/wx');
  assert.match(await fs.readFile(path.join(folder, '.gitignore'), 'utf8'), /\.wxroot\*/);
});

test('Unix build plans use exact detected tool paths and never invoke PowerShell', () => {
  const plan = buildPlan('/my project', 'Release', { configExecutable: '/opt/wx/bin/wx-config' },
    { platform: 'linux', cmake: '/usr/bin/cmake', compiler: '/usr/bin/clang++', generator: 'Ninja', ninja: '/usr/bin/ninja' });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].executable, '/usr/bin/cmake');
  assert.ok(plan[0].args.includes('-DwxWidgets_CONFIG_EXECUTABLE=/opt/wx/bin/wx-config'));
  assert.ok(plan[0].args.includes('-DCMAKE_BUILD_TYPE=Release'));
  assert.ok(plan[1].args.includes('--parallel'));
});

test('capability discovery finds executable files without trusting nonexecutable files', async t => {
  const folder = await temp(t);
  await file(folder, 'tool', '#!/bin/sh\n');
  assert.equal(await findExecutable('tool', { PATH: folder }, process.platform), path.join(folder, 'tool'));
  if (process.platform !== 'win32') {
    await fs.chmod(path.join(folder, 'tool'), 0o644);
    assert.equal(await findExecutable('tool', { PATH: folder }, process.platform), undefined);
  }
});
