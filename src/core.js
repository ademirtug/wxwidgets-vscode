'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const jsonc = require('jsonc-parser');
const { inspectUnixSdk, findUnixSdk } = require('./unix-sdk');

const configurations = ['Debug', 'Release'];
function validName(name) {
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name);
}
async function exists(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
async function isProject(folder) {
  if (await exists(path.join(folder, '.wxwidgets.json'))) return true;
  try {
    const cmake = await fs.readFile(path.join(folder, 'CMakeLists.txt'), 'utf8');
    return /find_package\s*\(\s*wxWidgets\b/i.test(cmake) &&
      (await exists(path.join(folder, 'scripts', 'build.ps1')) || await exists(path.join(folder, 'scripts', 'build.sh')));
  } catch { return false; }
}
async function projectInfo(folder) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(folder, '.wxwidgets.json'), 'utf8'));
    if (![1, 2].includes(marker.schemaVersion) || !validName(marker.name)) throw new Error('Invalid .wxwidgets.json project metadata.');
    return { name: marker.name, splitBuilds: true, ...(marker.schemaVersion === 2 ? { macBundle: true } : {}) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const cmake = await fs.readFile(path.join(folder, 'CMakeLists.txt'), 'utf8');
    const match = cmake.match(/project\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\b/i);
    if (!match) throw new Error('Cannot determine the executable name from CMakeLists.txt.');
    return { name: match[1], splitBuilds: false };
  }
}
function launchConfiguration(info, configuration, options = {}) {
  if (!configurations.includes(configuration)) throw new Error('Unsupported build configuration.');
  const build = info.splitBuilds ? `build/${configuration}` : 'build';
  const platform = options.platform || process.platform;
  const adapter = options.debugger || (platform === 'win32' ? { type: 'cppvsdbg' }
    : platform === 'darwin' ? { type: 'wxwidgets-lldb' } : { type: 'cppdbg', mode: 'gdb' });
  const program = platform === 'win32' ? `${info.name}.exe`
    : platform === 'darwin' && info.macBundle ? `${info.name}.app/Contents/MacOS/${info.name}` : info.name;
  const config = {
    name: `wxWidgets: ${configuration}`, type: adapter.type, request: 'launch',
    preLaunchTask: `wxWidgets: Build (${configuration})`,
    program: `\${workspaceFolder}/${build}/bin/${program}`,
    cwd: '${workspaceFolder}'
  };
  if (adapter.type === 'wxwidgets-lldb') config.stopOnEntry = false;
  else config.stopAtEntry = false;
  if (adapter.type === 'cppdbg') {
    config.MIMode = adapter.mode || (platform === 'darwin' ? 'lldb' : 'gdb');
    if (adapter.path) config.miDebuggerPath = adapter.path;
  }
  return config;
}
function taskConfiguration(configuration, options = {}) {
  if (!configurations.includes(configuration)) throw new Error('Unsupported build configuration.');
  return { label: `wxWidgets: Build (${configuration})`, type: 'wxwidgets', configuration,
    group: 'build', problemMatcher: [(options.platform || process.platform) === 'win32' ? '$msCompile' : '$gcc'] };
}
async function mergeArray(file, property, additions, key, update) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = JSON.stringify({ version: property === 'tasks' ? '2.0.0' : '0.2.0', [property]: [] }, null, 2) + '\n';
  }
  const original = text;
  const errors = []; const object = jsonc.parse(text, errors);
  if (errors.length || !object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`Cannot edit invalid JSON in ${file}.`);
  if (object[property] !== undefined && !Array.isArray(object[property])) throw new Error(`Expected an array named ${property} in ${file}.`);
  const entries = object[property] || [];
  if (entries.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    throw new Error(`Expected objects in ${property} in ${file}.`);
  for (const entry of additions) {
    const found = entries.findIndex(item => item[key] === entry[key]);
    if (found < 0) {
      const index = entries.length;
      text = jsonc.applyEdits(text, jsonc.modify(text, [property, index], entry,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      entries.push(entry);
    } else if (update) {
      const changes = update(entries[found], entry);
      for (const [propertyName, value] of Object.entries(changes || {})) {
        text = jsonc.applyEdits(text, jsonc.modify(text, [property, found, propertyName], value,
          { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      }
    }
    // A matching name may belong to a user. Preserve it, including custom arguments.
  }
  if (text !== original || !await exists(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  }
}
async function configureProject(folder, options = {}) {
  const info = await projectInfo(folder);
  await mergeArray(path.join(folder, '.vscode', 'tasks.json'), 'tasks', configurations.map(c => taskConfiguration(c, options)), 'label',
    (old, next) => old.type === 'wxwidgets' ? { problemMatcher: next.problemMatcher } : undefined);
  await mergeArray(path.join(folder, '.vscode', 'launch.json'), 'configurations', configurations.map(c => launchConfiguration(info, c, options)), 'name',
    (old, next) => {
      const configuration = /\((Debug|Release)\)$/.exec(next.preLaunchTask)[1];
      const managedPrograms = ['win32', 'linux', 'darwin'].flatMap(platform => [true, false].map(macBundle =>
        launchConfiguration({ ...info, macBundle }, configuration, { platform }).program));
      if (old.preLaunchTask !== next.preLaunchTask || !managedPrograms.includes(old.program) ||
          !['cppvsdbg', 'cppdbg', 'wxwidgets-lldb'].includes(old.type)) return;
      if (old.type === next.type && old.program === next.program && old.MIMode === next.MIMode) return;
      const stop = old.stopOnEntry ?? old.stopAtEntry ?? false;
      return { type: next.type, program: next.program, MIMode: next.MIMode,
        miDebuggerPath: next.miDebuggerPath, stopAtEntry: next.type === 'wxwidgets-lldb' ? undefined : stop,
        stopOnEntry: next.type === 'wxwidgets-lldb' ? stop : undefined };
    });
}
async function createProject(template, parent, name, sdkPath = '', options = {}) {
  if (!validName(name)) throw new Error('Use a project name starting with a letter, containing only letters, numbers, and underscores (up to 64 characters).');
  const destination = path.join(path.resolve(parent), name);
  await fs.mkdir(destination); // Deliberately refuses to overwrite an existing project.
  async function copy(source, target) {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (entry.name === '.template.config' || entry.name === '.vscode') continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) throw new Error('A bundled template must not contain symbolic links.');
      if (entry.isDirectory()) { await fs.mkdir(to); await copy(from, to); }
      else if (entry.name.endsWith('.ico')) await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      else {
        let text = await fs.readFile(from, 'utf8');
        text = text.replaceAll('wxapp', name);
        if (entry.name === '.wxroot') text = (options.platform || process.platform) === 'win32' ? sdkPath + '\n' : '\n';
        await fs.writeFile(to, text, { flag: 'wx' });
      }
    }
  }
  await copy(template, destination);
  await fs.writeFile(path.join(destination, '.wxwidgets.json'), JSON.stringify({ schemaVersion: 2, name }, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(destination, '.gitignore'), 'build/\n.vs/\n.wxroot*\n', { flag: 'wx' });
  if (sdkPath && (options.platform || process.platform) !== 'win32')
    await fs.writeFile(path.join(destination, sdkFileName(options.platform || process.platform)), sdkPath + '\n', { flag: 'wx' });
  await configureProject(destination, options);
  return destination;
}
function sdkFileName(platform = process.platform) { return platform === 'win32' ? '.wxroot' : `.wxroot.${platform}`; }
async function inspectSdk(root, configuration, options = {}) {
  if (configuration && !configurations.includes(configuration)) throw new Error('Unsupported build configuration.');
  if (!root || typeof root !== 'string') return { valid: false, reason: 'No wxWidgets folder has been selected.' };
  if ((options.platform || process.platform) !== 'win32') return inspectUnixSdk(root, configuration, options);
  if (!await exists(path.join(root, 'include', 'wx', 'wx.h')) || !await exists(path.join(root, 'include', 'wx', 'version.h')))
    return { valid: false, reason: 'Choose the wxWidgets root folder containing include/wx/wx.h.' };
  let entries;
  try { entries = await fs.readdir(path.join(root, 'lib'), { withFileTypes: true }); } catch {
    return { valid: false, reason: 'Sources found, but the compiled MSVC x64 libraries are missing from lib/.' };
  }
  const wanted = configuration ? [configuration] : configurations;
  for (const entry of entries.filter(e => e.isDirectory() && /^vc.*_x64_(dll|lib)$/i.test(e.name))) {
    const folder = path.join(root, 'lib', entry.name); const files = await fs.readdir(folder);
    for (const config of wanted) {
      const debug = config === 'Debug' ? 'd' : '';
      const core = new RegExp(`^wxmsw(\\d+)u${debug}_core\\.lib$`, 'i');
      for (const file of files) {
        const version = file.match(core)?.[1];
        if (!version || !files.some(f => f.toLowerCase() === `wxbase${version}u${debug}.lib`) ||
            !await exists(path.join(folder, `mswu${debug}`, 'wx', 'setup.h'))) continue;
        if (entry.name.toLowerCase().endsWith('_dll')) {
          // Import libraries use the ABI version (33), while DLLs may include the patch (332).
          const coreDll = new RegExp(`^wxmsw(${version}\\d*)u${debug}_core_(.*_x64(?:_.*)?)\\.dll$`, 'i');
          const runtime = files.map(f => f.match(coreDll)).find(match => match && files.some(f =>
            f.toLowerCase() === `wxbase${match[1]}u${debug}_${match[2]}.dll`.toLowerCase()));
          if (!runtime) continue;
        }
        return { valid: true, root: path.resolve(root), libraryDirectory: folder, configuration: config };
      }
    }
  }
  return { valid: false, reason: `The ${configuration || 'Debug or Release'} x64 MSVC libraries, setup header, or runtime DLLs are missing. Source files alone are not enough.` };
}
async function findSdk(folder, configured, lastUsed, environment = process.env, configuration, options = {}) {
  const platform = options.platform || process.platform;
  let saved = '';
  if (folder) {
    for (const name of [...new Set([sdkFileName(platform), '.wxroot'])]) {
      try { saved = (await fs.readFile(path.join(folder, name), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved === '__WXWIDGETS_ROOT__') saved = '';
      if (platform !== 'win32' && name === '.wxroot' && /^[A-Za-z]:[\\/]/.test(saved)) saved = '';
      if (saved) break;
    }
  }
  if (saved === '__WXWIDGETS_ROOT__') saved = '';
  if (platform !== 'win32') return findUnixSdk(saved ? path.resolve(folder, saved) : '',
    configured ? path.resolve(folder || process.cwd(), configured) : '', lastUsed, environment, configuration, { ...options, platform });
  // A broken explicit setting must be repaired instead of silently changing SDK versions.
  if (saved || configured) return inspectSdk(path.resolve(folder || process.cwd(), saved || configured), configuration, options);
  const drive = environment.SystemDrive || 'C:';
  const candidates = [lastUsed, environment.WXWIN, `${drive}\\dev\\wx`];
  try {
    const names = (await fs.readdir(`${drive}\\`, { withFileTypes: true }))
      .filter(e => e.isDirectory() && /^wxWidgets-/i.test(e.name)).map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    candidates.push(...names.map(name => path.join(`${drive}\\`, name)));
  } catch { /* A missing or inaccessible system drive isn't fatal. */ }
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const result = await inspectSdk(candidate, configuration, options); if (result.valid) return result;
  }
  return { valid: false, reason: 'No ready-to-build wxWidgets SDK was found. Select a folder with compiled x64 MSVC libraries.' };
}
module.exports = { configurations, validName, exists, isProject, projectInfo, launchConfiguration,
  taskConfiguration, configureProject, createProject, inspectSdk, findSdk, sdkFileName };
