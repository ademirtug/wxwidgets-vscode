'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const jsonc = require('jsonc-parser');
const { configureIntelliSense, configurationFor } = require('../src/intellisense');
const { detectCapabilities } = require('../src/platform');

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wx-intellisense-'));
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const sdk = { valid: true, root: path.join(folder, 'sdk'), libraryDirectory: path.join(folder, 'sdk/lib/vc14x_x64_dll') };
  for (const header of ['include/wx/wx.h', 'lib/vc14x_x64_dll/mswu/wx/setup.h', 'lib/vc14x_x64_dll/mswud/wx/setup.h']) {
    const file = path.join(sdk.root, header);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '');
  }
  const file = path.join(folder, '.vscode/c_cpp_properties.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  return { folder, sdk, file, read: async () => jsonc.parse(await fs.readFile(file, 'utf8')) };
}

test('Windows IntelliSense resolves wx.h and the requested generated setup header before a build', async t => {
  const { folder, sdk, read } = await fixture(t);
  const host = { platform: 'win32', compilerPath: 'C:/Tools/cl.exe' };
  await configureIntelliSense(folder, sdk, host, 'Debug');
  const object = await read(), config = object.configurations[0];
  assert.equal(object.version, 4);
  for (const header of ['wx/wx.h', 'wx/setup.h']) {
    assert.ok((await Promise.all(config.includePath.filter(dir => !dir.includes('${')).map(dir =>
      fs.stat(path.join(dir, header)).then(stat => stat.isFile()).catch(() => false)))).some(Boolean), header);
  }
  assert.ok(config.includePath.includes(path.join(sdk.libraryDirectory, 'mswud')));
  assert.ok(config.defines.includes('WXUSINGDLL'));
  assert.ok(config.defines.includes('_DEBUG'));
  assert.equal(config.compilerPath, host.compilerPath);
  assert.equal(config.cppStandard, 'c++20');
  assert.equal(config.intelliSenseMode, 'windows-msvc-x64');
});

test('SDK and configuration changes replace stale managed paths and retain other configurations and comments', async t => {
  const { folder, sdk, file, read } = await fixture(t);
  const custom = { name: 'Custom', includePath: ['custom/include'], defines: ['CUSTOM=1'] };
  await fs.writeFile(file, '// keep this comment\n' + JSON.stringify({ version: 4, configurations: [custom] }, null, 2));
  await configureIntelliSense(folder, sdk, { platform: 'win32' }, 'Debug');
  const newSdk = { ...sdk, root: path.join(folder, 'new-sdk'), libraryDirectory: path.join(folder, 'new-sdk/lib/vc_x64_lib') };
  await configureIntelliSense(folder, newSdk, { platform: 'win32' }, 'Release');
  const object = await read();
  assert.deepEqual(object.configurations[0], custom);
  assert.equal(object.configurations.length, 2);
  const config = object.configurations[1];
  assert.ok(config.includePath.includes(path.join(newSdk.libraryDirectory, 'mswu')));
  assert.ok(!config.includePath.some(dir => dir.startsWith(sdk.root)));
  assert.ok(!config.defines.includes('WXUSINGDLL'));
  assert.ok(!config.defines.includes('_DEBUG'));
  assert.ok(config.defines.includes('NDEBUG'));
  const before = await fs.readFile(file, 'utf8');
  assert.match(before, /keep this comment/);
  await configureIntelliSense(folder, newSdk, { platform: 'win32' }, 'Release');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('Linux and macOS use SDK flags, including quoted paths and compiler options', async () => {
  const sdk = { valid: true, cxxflags: '-I"/SDK with spaces/include" -isystem /SDK/setup -D__WXGTK__ -D_FILE_OFFSET_BITS=64 -pthread' };
  const config = await configurationFor(sdk, { platform: 'linux', compiler: '/usr/bin/g++', arch: 'x64' });
  assert.deepEqual(config.includePath, ['${workspaceFolder}', '/SDK with spaces/include', '/SDK/setup']);
  assert.deepEqual(config.defines, ['__WXGTK__', '_FILE_OFFSET_BITS=64']);
  assert.deepEqual(config.compilerArgs, ['-pthread']);
  assert.equal(config.intelliSenseMode, 'linux-gcc-x64');
  const mac = await configurationFor({ valid: true, cxxflags: ['-I/opt/wx/include', '-D__WXOSX_COCOA__', '-F', '/Library/Frameworks'] },
    { platform: 'darwin', compiler: '/usr/bin/clang++', arch: 'arm64' });
  assert.equal(mac.intelliSenseMode, 'macos-clang-arm64');
  assert.deepEqual(mac.macFrameworkPath, ['/Library/Frameworks']);
});

test('cross-platform refresh removes stale Windows paths and retains additional user settings', async t => {
  const { folder, sdk, file, read } = await fixture(t);
  await configureIntelliSense(folder, sdk, { platform: 'win32', compilerPath: 'C:/Tools/cl.exe' });
  const object = await read();
  object.configurations[0].forcedInclude = ['custom.h'];
  await fs.writeFile(file, JSON.stringify(object));
  await configureIntelliSense(folder, { valid: true, cxxflags: ['-I/usr/include/wx', '-D__WXGTK__'] },
    { platform: 'linux', compiler: '/usr/bin/g++', arch: 'x64' }, 'Release');
  const config = (await read()).configurations[0];
  assert.deepEqual(config.forcedInclude, ['custom.h']);
  assert.equal(config.compilerPath, '/usr/bin/g++');
  assert.deepEqual(config.defines, ['__WXGTK__']);
  assert.ok(!JSON.stringify(config).includes(sdk.root));
});

test('invalid files and user-owned wxWidgets configurations are not overwritten', async t => {
  const { folder, sdk, file } = await fixture(t);
  const original = '{ broken';
  await fs.writeFile(file, original);
  await assert.rejects(configureIntelliSense(folder, sdk, { platform: 'win32' }), /invalid C\/C\+\+/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const custom = JSON.stringify({ version: 4, configurations: [{ name: 'wxWidgets', defines: ['KEEP'] }] });
  await fs.writeFile(file, custom);
  assert.equal(await configureIntelliSense(folder, sdk, { platform: 'win32' }), false);
  assert.equal(await fs.readFile(file, 'utf8'), custom);
});

test('Windows compiler discovery uses the installed default x64 MSVC toolset', async t => {
  const { folder } = await fixture(t);
  const versionFile = path.join(folder, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt');
  await fs.mkdir(path.dirname(versionFile), { recursive: true }); await fs.writeFile(versionFile, '14.50.35717\n');
  const compiler = path.join(folder, 'VC/Tools/MSVC/14.50.35717/bin/Hostx64/x64/cl.exe');
  const host = await detectCapabilities({ platform: 'win32', environment: {},
    find: async name => /vswhere\.exe$/.test(name) || /cmake\.exe$/.test(name) || name === compiler ? name : undefined,
    run: async file => /vswhere\.exe$/.test(file) ? folder : 'cmake version 4.0.0' });
  assert.equal(host.compilerPath, compiler);
});
