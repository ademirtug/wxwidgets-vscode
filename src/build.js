'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs/promises');

function powershellCommand(script, configuration) {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Unsupported build configuration.');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const code = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\ntry { & ${literal(script)} -Configuration ${literal(configuration)} -BootstrapIfMissing:$false; exit $LASTEXITCODE } catch { Write-Error $_; exit 1 }`;
  return { executable: path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass',
    '-Command', code] };
}

function stopTree(child, platform = process.platform) {
  if (!child?.pid || child.exitCode !== null) return Promise.resolve();
  if (platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    return new Promise(resolve => setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process group has already stopped. */ }
      resolve();
    }, 1000));
  }
  return new Promise(resolve => {
    const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => { child.kill(); resolve(); });
    killer.once('close', resolve);
  });
}

function buildPlan(folder, configuration, sdk, capabilities = {}, info = { splitBuilds: true }) {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Unsupported build configuration.');
  const platform = capabilities.platform || process.platform;
  if (platform === 'win32') return [powershellCommand(path.join(folder, 'scripts', 'build.ps1'), configuration)];
  if (!capabilities.cmake || !sdk.configExecutable) throw new Error('CMake and a working wx-config are required to build this project.');
  const build = info.splitBuilds ? path.join(folder, 'build', configuration) : path.join(folder, 'build');
  const args = ['-S', folder, '-B', build, '-G', capabilities.generator || 'Unix Makefiles',
    `-DCMAKE_BUILD_TYPE=${configuration}`, `-DwxWidgets_CONFIG_EXECUTABLE=${sdk.configExecutable}`];
  if (capabilities.ninja && capabilities.generator === 'Ninja') args.push(`-DCMAKE_MAKE_PROGRAM=${capabilities.ninja}`);
  if (!process.env.CXX && capabilities.compiler) args.push(`-DCMAKE_CXX_COMPILER=${capabilities.compiler}`);
  return [{ executable: capabilities.cmake, args },
    { executable: capabilities.cmake, args: ['--build', build, '--config', configuration, '--parallel'] }];
}

class BuildTerminal {
  constructor(vscode, options) {
    this.options = options;
    this.writer = new vscode.EventEmitter();
    this.closer = new vscode.EventEmitter();
    this.onDidWrite = this.writer.event;
    this.onDidClose = this.closer.event;
    this.completion = new Promise(resolve => { this.resolve = resolve; });
  }
  write(text) { this.options.log?.(text); this.writer.fire(text.replace(/\r?\n/g, '\r\n')); }
  finish(code) {
    if (this.finished) return;
    this.finished = true;
    this.options.release?.();
    this.resolve(code);
    this.closer.fire(code);
  }
  open() { void this.start().catch(error => { this.write(`${error.message}\n`); this.finish(1); }); }
  async start() {
    if (this.cancelled) return this.finish(1);
    this.options.acquire();
    const sdk = await this.options.prepare();
    if (this.cancelled || !sdk) return this.finish(1);
    const { folder, configuration } = this.options;
    const capabilities = { ...sdk.capabilities };
    const platform = capabilities.platform || process.platform;
    const buildDirectory = sdk.info?.splitBuilds === false ? path.join(folder, 'build') : path.join(folder, 'build', configuration);
    try {
      const cache = await fs.readFile(path.join(buildDirectory, 'CMakeCache.txt'), 'utf8');
      const generator = cache.match(/^CMAKE_GENERATOR:INTERNAL=(.+)$/m)?.[1].trim();
      if (generator) {
        if (generator === 'Ninja' && !capabilities.ninja) throw new Error('This build folder uses Ninja. Install Ninja or choose a fresh build folder.');
        capabilities.generator = generator;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.write(`Building ${configuration}: ${folder}\nwxWidgets SDK: ${sdk.root}\n`);
    const env = { ...process.env, WXWIN: sdk.root,
      WXWIDGETS_LIBRARY_DIR: sdk.libraryDirectory || '', WX_CONFIG: sdk.configExecutable || '',
      WXWIDGETS_VSDEVCMD: capabilities.vsDevCmd || '', WXWIDGETS_CMAKE: capabilities.cmake || '',
      WXWIDGETS_GENERATOR: capabilities.generator || '' };
    const toolDirs = [capabilities.cmake, capabilities.generator === 'Ninja' && capabilities.ninja].filter(Boolean).map(tool => path.dirname(tool));
    env.PATH = [...new Set(toolDirs)].concat(process.env.PATH || process.env.Path || '').join(platform === 'win32' ? ';' : ':');
    if (platform === 'win32') delete env.Path;
    for (const command of buildPlan(folder, configuration, sdk, capabilities, sdk.info)) {
      if (this.cancelled) return this.finish(1);
      const code = await this.runStep(command, env, platform);
      if (this.cancelled) return;
      if (code !== 0) return this.finish(code);
    }
    this.finish(0);
  }
  runStep(command, env, platform) {
    this.child = spawn(command.executable, command.args, { cwd: this.options.folder, windowsHide: true,
      detached: platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    this.child.stdout.on('data', chunk => this.write(stdout.write(chunk)));
    this.child.stderr.on('data', chunk => this.write(stderr.write(chunk)));
    return new Promise(resolve => {
    this.child.once('error', error => { this.write(error.message + '\n'); resolve(1); });
    this.child.once('close', code => {
      this.write(stdout.end() + stderr.end());
      const result = this.cancelled ? 1 : (code ?? 1);
      this.write(this.cancelled ? 'Build cancelled.\n' : `Build exited with code ${result}.\n`);
      resolve(result);
    });
    });
  }
  close() {
    this.cancelled = true;
    if (this.child) void stopTree(this.child, this.options.platform || process.platform).then(() => this.finish(1))
      .catch(error => { this.write(`Could not stop the build: ${error.message}\n`); this.finish(1); });
    else this.finish(1);
  }
}

module.exports = { powershellCommand, stopTree, buildPlan, BuildTerminal };
