'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const jsonc = require('jsonc-parser');
const { splitFlags } = require('./platform');

const pending = new Map();
const managed = configuration => configuration.customConfigurationVariables?.wxWidgetsTools === 'managed';

function sdkFlags(flags) {
  const result = { includePath: [], defines: [], compilerArgs: [], macFrameworkPath: [] };
  const paths = { '-I': 'includePath', '-isystem': 'includePath', '-iquote': 'includePath',
    '-D': 'defines', '-F': 'macFrameworkPath' };
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    const prefix = Object.keys(paths).find(key => flag.startsWith(key));
    if (!prefix) { result.compilerArgs.push(flag); continue; }
    const value = flag.length === prefix.length ? flags[++index] : flag.slice(prefix.length);
    if (!value) throw new Error('The SDK returned an incomplete IntelliSense compiler flag.');
    result[paths[prefix]].push(value);
  }
  return result;
}

async function configurationFor(sdk, host, configuration = 'Debug') {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Unsupported build configuration.');
  if (!sdk.valid) throw new Error('A valid wxWidgets SDK is required to configure IntelliSense.');
  const platform = host.platform || process.platform;
  const settings = { name: 'wxWidgets', includePath: ['${workspaceFolder}'], defines: [],
    cppStandard: 'c++20', customConfigurationVariables: { wxWidgetsTools: 'managed' } };
  if (platform === 'win32') {
    settings.includePath.push(path.join(sdk.libraryDirectory, configuration === 'Debug' ? 'mswud' : 'mswu'),
      path.join(sdk.root, 'include'));
    settings.defines.push('UNICODE', '_UNICODE', '__WXMSW__', configuration === 'Debug' ? '_DEBUG' : 'NDEBUG');
    if (/_dll$/i.test(sdk.libraryDirectory)) settings.defines.push('WXUSINGDLL');
    settings.intelliSenseMode = 'windows-msvc-x64';
    if (host.compilerPath) settings.compilerPath = host.compilerPath;
  } else {
    const flags = sdkFlags(Array.isArray(sdk.cxxflags) ? sdk.cxxflags : splitFlags(sdk.cxxflags || ''));
    if (!flags.includePath.length) throw new Error('The wxWidgets SDK did not provide IntelliSense include paths.');
    settings.includePath.push(...flags.includePath);
    settings.defines = flags.defines;
    if (flags.compilerArgs.length) settings.compilerArgs = flags.compilerArgs;
    if (platform === 'darwin' && flags.macFrameworkPath.length) settings.macFrameworkPath = flags.macFrameworkPath;
    const compiler = /clang/i.test(host.compiler || '') || platform === 'darwin' ? 'clang' : 'gcc';
    const arch = host.arch === 'arm64' ? 'arm64' : host.arch === 'ia32' ? 'x86' : 'x64';
    settings.intelliSenseMode = `${platform === 'darwin' ? 'macos' : 'linux'}-${compiler}-${arch}`;
    if (host.compiler) settings.compilerPath = host.compiler;
  }
  return settings;
}

async function writeConfiguration(folder, sdk, host, configuration) {
  const settings = await configurationFor(sdk, host, configuration);
  const file = path.join(folder, '.vscode', 'c_cpp_properties.json');
  let original;
  try { original = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let text = original ?? '{\n  "configurations": [],\n  "version": 4\n}\n';
  const errors = [], object = jsonc.parse(text, errors);
  if (errors.length || !object || Array.isArray(object) || typeof object !== 'object' ||
      !Array.isArray(object.configurations) || object.configurations.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    throw new Error(`Cannot edit invalid C/C++ configurations in ${file}.`);
  let index = object.configurations.findIndex(managed);
  // A configuration with this name may already belong to the user.
  if (index < 0 && object.configurations.some(item => item.name === settings.name)) return false;
  if (index < 0) index = object.configurations.length;
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  const previous = object.configurations[index];
  if (previous) {
    // Only refresh fields owned by the extension; retain other user settings.
    for (const property of ['includePath', 'defines', 'cppStandard', 'compilerPath', 'compilerArgs', 'intelliSenseMode', 'macFrameworkPath']) {
      if (JSON.stringify(previous[property]) !== JSON.stringify(settings[property]))
        text = jsonc.applyEdits(text, jsonc.modify(text, ['configurations', index, property], settings[property], options));
    }
  } else text = jsonc.applyEdits(text, jsonc.modify(text, ['configurations', index], settings, options));
  if (text !== original) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
  return true;
}

function configureIntelliSense(folder, sdk, host, configuration) {
  // Refreshes from editor and SDK events can overlap for the same folder.
  const previous = pending.get(folder) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeConfiguration(folder, sdk, host, configuration));
  pending.set(folder, next);
  return next.finally(() => { if (pending.get(folder) === next) pending.delete(folder); });
}

module.exports = { configurationFor, configureIntelliSense };
