'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

async function run(file, args = [], options = {}) {
  const { stdout } = await execute(file, args, { windowsHide: true, encoding: 'utf8',
    timeout: 15000, maxBuffer: 1024 * 1024, ...options });
  return stdout.trim();
}
async function executable(file, platform = process.platform) {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    if (platform !== 'win32') await fs.access(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}
async function findExecutable(name, environment = process.env, platform = process.platform) {
  const paths = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
    ? [name] : (environment.PATH || environment.Path || '').split(platform === 'win32' ? ';' : ':')
      .filter(Boolean).map(folder => path.join(folder, name));
  const extensions = platform === 'win32' && !path.extname(name) ? ['', '.exe', '.com'] : [''];
  for (const candidate of paths) for (const extension of extensions)
    if (await executable(candidate + extension, platform)) return path.resolve(candidate + extension);
}
function splitFlags(text) {
  const tokens = []; let token = '', quote = '', escape = false, started = false;
  for (const char of text) {
    if (escape) { token += char; escape = false; started = true; }
    else if (char === '\\' && quote !== "'") { escape = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (quote || escape) throw new Error('The SDK returned malformed compiler or linker flags.');
  if (started) tokens.push(token);
  return tokens;
}
async function detectCapabilities(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const find = options.find || (name => findExecutable(name, environment, platform));
  const probe = options.run || run;
  const result = { platform, arch: options.arch || process.arch, issues: [] };
  if (!['win32', 'linux', 'darwin'].includes(platform)) {
    result.issues.push('This operating system is not supported.'); return result;
  }
  result.cmake = await find('cmake');
  let installation;
  if (platform === 'win32') {
    const vswhere = await find(path.join(environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft Visual Studio', 'Installer', 'vswhere.exe'));
    if (vswhere) {
      try { installation = await probe(vswhere, ['-latest', '-version', '[17.0,19.0)', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']); }
      catch { /* Report a missing toolchain below. */ }
    }
    if (!installation) {
      for (const base of [environment['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', environment.ProgramFiles || 'C:\\Program Files']) {
        for (const version of ['18', '2022']) for (const edition of ['BuildTools', 'Community', 'Professional', 'Enterprise']) {
          const candidate = path.join(base, 'Microsoft Visual Studio', version, edition);
          if (await find(path.join(candidate, 'Common7', 'Tools', 'VsDevCmd.bat'))) { installation = candidate; break; }
        }
        if (installation) break;
      }
    }
    result.vsDevCmd = installation && path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
    if (installation) {
      try {
        const version = (await fs.readFile(path.join(installation, 'VC', 'Auxiliary', 'Build',
          'Microsoft.VCToolsVersion.default.txt'), 'utf8')).trim();
        if (/^\d+(?:\.\d+)+$/.test(version)) result.compilerPath = await find(path.join(installation,
          'VC', 'Tools', 'MSVC', version, 'bin', 'Hostx64', 'x64', 'cl.exe'));
      } catch { /* C/C++ can also discover installed MSVC tools itself. */ }
    }
    const bundled = installation && path.join(installation, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake');
    result.cmake ||= await find(path.join(environment.ProgramFiles || 'C:\\Program Files', 'CMake', 'bin', 'cmake.exe'));
    if (!result.cmake && bundled) result.cmake = await find(path.join(bundled, 'CMake', 'bin', 'cmake.exe'));
    result.ninja = await find('ninja');
    if (!result.ninja && bundled) result.ninja = await find(path.join(bundled, 'Ninja', 'ninja.exe'));
    result.generator = result.ninja ? 'Ninja' : 'NMake Makefiles';
    result.compiler = result.vsDevCmd ? 'MSVC (x64)' : undefined;
    result.debugger = { type: 'cppvsdbg', label: 'Microsoft C++ debugger' };
    if (!result.vsDevCmd) result.issues.push('Install Visual Studio C++ Build Tools (2022 or 2026) with the Windows SDK and x64 MSVC tools.');
  } else {
    let developerTools = true;
    if (platform === 'darwin') {
      const select = await find('xcode-select');
      if (select) try { await probe(select, ['-p']); } catch { developerTools = false; }
      if (!developerTools) result.issues.push('Install Xcode Command Line Tools to provide the macOS SDK.');
    }
    result.ninja = await find('ninja');
    result.make = await find('make') || await find('gmake');
    result.generator = result.ninja ? 'Ninja' : 'Unix Makefiles';
    const compilerNames = environment.CXX ? [splitFlags(environment.CXX)[0]]
      : (platform === 'darwin' ? ['clang++', 'c++', 'g++'] : ['c++', 'g++', 'clang++']);
    for (const name of compilerNames.filter(Boolean)) { result.compiler = await find(name); if (result.compiler) break; }
    if (!result.compiler) result.issues.push(platform === 'darwin'
      ? 'Install Xcode Command Line Tools to provide the C++ compiler and macOS SDK.' : 'Install a C++ compiler such as GCC or Clang.');
    if (!result.ninja && !result.make) result.issues.push('Install Ninja or Make to build CMake projects.');
    const gdb = platform === 'linux' && await find('gdb');
    let dap = await find('lldb-dap') || await find('lldb-vscode');
    if (!dap && platform === 'darwin') dap = await find('/opt/homebrew/opt/llvm/bin/lldb-dap') || await find('/usr/local/opt/llvm/bin/lldb-dap');
    if (!dap && platform === 'darwin' && developerTools) {
      const xcrun = await find('xcrun');
      if (xcrun) try { dap = await probe(xcrun, ['--find', 'lldb-dap']); } catch { /* Use MI if available. */ }
    }
    if (gdb) result.debugger = { type: 'cppdbg', mode: 'gdb', path: gdb, label: 'GDB' };
    else if (dap) result.debugger = { type: 'wxwidgets-lldb', path: dap, label: 'LLDB' };
    else {
      const mi = options.cpptoolsPath && await find(path.join(options.cpptoolsPath, 'debugAdapters', 'lldb-mi', 'bin', 'lldb-mi'));
      if (mi) result.debugger = { type: 'cppdbg', mode: 'lldb', path: mi, label: 'LLDB (Microsoft C/C++)' };
    }
  }
  if (!result.cmake) result.issues.unshift('Install CMake 3.20 or later and make it available on PATH.');
  else try {
    result.cmakeVersion = (await probe(result.cmake, ['--version'])).match(/cmake version (\d+\.\d+(?:\.\d+)?)/i)?.[1];
    const [major, minor] = (result.cmakeVersion || '0.0').split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 20)) result.issues.unshift('CMake 3.20 or later is required.');
  } catch { result.issues.unshift('CMake could not be executed. Check your CMake installation.'); }
  result.canBuild = result.issues.length === 0;
  return result;
}

module.exports = { run, executable, findExecutable, splitFlags, detectCapabilities };
