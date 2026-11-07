'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { run, executable, findExecutable, splitFlags } = require('./platform');

function flagPaths(flags, prefix) {
  const paths = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === prefix && flags[index + 1]) paths.push(flags[++index]);
    else if (flag.startsWith(prefix) && flag.length > prefix.length) paths.push(flag.slice(prefix.length));
  }
  return paths;
}
async function fileExists(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }
async function inspectUnixSdk(location, configuration, options = {}) {
  const probe = options.run || run;
  const platform = options.platform || process.platform;
  let configExecutable;
  for (const candidate of [location, path.join(location, 'bin', 'wx-config'), path.join(location, 'wx-config')]) {
    if (await executable(candidate, platform)) { configExecutable = path.resolve(candidate); break; }
  }
  if (!configExecutable) return { valid: false, reason: 'Choose a compiled wxWidgets installation containing bin/wx-config or wx-config.' };
  try {
    const [version, prefix, cxxflags, libraries] = await Promise.all([
      probe(configExecutable, ['--version']), probe(configExecutable, ['--prefix']),
      probe(configExecutable, ['--cxxflags']), probe(configExecutable, ['--libs', 'core,base'])
    ]);
    if (!/^\d+\.\d+/.test(version)) throw new Error('wx-config did not return a valid wxWidgets version.');
    const includes = flagPaths(splitFlags(cxxflags), '-I');
    const hasHeader = (await Promise.all(includes.map(dir => fileExists(path.join(dir, 'wx', 'wx.h'))))).some(Boolean);
    const hasSetup = (await Promise.all(includes.map(dir => fileExists(path.join(dir, 'wx', 'setup.h'))))).some(Boolean);
    if (!hasHeader || !hasSetup) throw new Error('The wxWidgets development headers or generated wx/setup.h are missing.');
    const flags = splitFlags(libraries);
    const dirs = [...new Set([...flagPaths(flags, '-L'), path.join(prefix, 'lib'), path.join(prefix, 'lib64')])];
    const wxLibs = flags.filter(flag => flag.startsWith('-lwx')).map(flag => flag.slice(2));
    const absolute = flags.filter(flag => path.isAbsolute(flag) && /libwx[^/]*\.(a|so|dylib)(?:\..*)?$/.test(path.basename(flag)));
    if (!wxLibs.length && !absolute.length) throw new Error('wx-config did not return compiled core/base libraries.');
    for (const library of wxLibs) {
      const candidates = dirs.flatMap(dir => ['.so', '.dylib', '.a'].map(ext => path.join(dir, 'lib' + library + ext)));
      if (!(await Promise.all(candidates.map(fileExists))).some(Boolean))
        throw new Error(`The compiled wxWidgets library ${library} was not found. Install the development libraries for this system.`);
    }
    for (const library of absolute) if (!await fileExists(library)) throw new Error(`The compiled library ${library} is missing.`);
    return { valid: true, root: path.resolve(location), configExecutable, version, prefix,
      libraryDirectory: dirs[0], configuration, platform };
  } catch (error) {
    return { valid: false, reason: `This wxWidgets installation is not ready: ${error.message}` };
  }
}
async function findUnixSdk(saved, configured, lastUsed, environment, configuration, options = {}) {
  const platform = options.platform || process.platform;
  const find = options.find || (name => findExecutable(name, environment, platform));
  const environmentConfig = environment.WX_CONFIG && (await find(environment.WX_CONFIG) || environment.WX_CONFIG);
  const explicit = saved || configured || environmentConfig;
  if (explicit) return inspectUnixSdk(explicit, configuration, options);
  const candidates = [lastUsed, environment.WXWIN, await find('wx-config')];
  if (platform === 'darwin') candidates.push('/opt/homebrew/opt/wxwidgets', '/usr/local/opt/wxwidgets', '/opt/homebrew', '/usr/local');
  else candidates.push('/usr', '/usr/local');
  for (const location of [...new Set(candidates.filter(Boolean))]) {
    const sdk = await inspectUnixSdk(location, configuration, options);
    if (sdk.valid) return sdk;
  }
  return { valid: false, reason: 'No compiled wxWidgets installation was found. Install the wxWidgets development package and ensure wx-config is on PATH, or choose Locate SDK.' };
}

module.exports = { flagPaths, inspectUnixSdk, findUnixSdk };
