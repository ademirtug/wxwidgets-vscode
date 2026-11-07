'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { EventEmitter: NodeEventEmitter } = require('node:events');
const { BuildTerminal, powershellCommand, stopTree } = require('../src/build');
class EventEmitter {
  constructor() { this.emitter = new NodeEventEmitter(); }
  event = handler => { this.emitter.on('data', handler); return { dispose: () => this.emitter.off('data', handler) }; };
  fire(value) { this.emitter.emit('data', value); }
}
const vscode = { EventEmitter };
async function fixture(t, code) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "wx build 'quoted' "));
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'scripts'));
  await fs.writeFile(path.join(folder, 'scripts/build.ps1'), `param([string]$Configuration,[switch]$BootstrapIfMissing)\nif ($BootstrapIfMissing) { exit 9 }\n${code}`);
  return folder;
}
function terminal(folder) {
  return new BuildTerminal(vscode, { folder, configuration: 'Debug', acquire() {}, release() {},
    prepare: async () => ({ root: folder, libraryDirectory: folder }) });
}
test('PowerShell command safely quotes paths and disables bootstrapping', () => {
  const command = powershellCommand("C:\\a 'quoted' path\\build.ps1", 'Debug');
  const code = command.args.at(-1);
  assert.match(code, /a ''quoted'' path/);
  assert.match(code, /-BootstrapIfMissing:\$false/);
  assert.throws(() => powershellCommand('x', 'Debug; bad'), /Unsupported/);
});
test('build reports actual successful and failing exit codes', { skip: process.platform !== 'win32' }, async t => {
  const folder = await fixture(t, 'Write-Output "Configuration: $Configuration"\nexit 0');
  let build = terminal(folder), output = '';
  build.onDidWrite(chunk => { output += chunk; });
  build.open();
  assert.equal(await build.completion, 0);
  assert.match(output, /Configuration: Debug/);
  await fs.writeFile(path.join(folder, 'scripts/build.ps1'), 'param([string]$Configuration,[switch]$BootstrapIfMissing)\nexit 7');
  build = terminal(folder); build.open();
  assert.equal(await build.completion, 7);
});
test('cancelled preparation never starts a build', async () => {
  let prepared = false;
  const build = new BuildTerminal(vscode, { acquire() {}, release() {}, prepare() { prepared = true; } });
  build.close(); build.open();
  assert.equal(await build.completion, 1);
  assert.equal(prepared, false);
});
test('cancellation terminates the build process tree', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const folder = await fixture(t, "$child = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden -PassThru\n$child.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child.pid')\nWait-Process -Id $child.Id\nexit 0");
  const build = terminal(folder);
  build.open();
  let childPid;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { childPid = Number((await fs.readFile(path.join(folder, 'scripts/child.pid'), 'utf8')).trim()); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(childPid, 'Child process must have started before cancellation');
  const pid = build.child.pid;
  build.close();
  assert.equal(await build.completion, 1);
  assert.throws(() => process.kill(pid, 0));
  assert.throws(() => process.kill(childPid, 0));
});

test('Unix cancellation terminates a detached build and its children', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'wx-posix-cancel-'));
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const pidFile = path.join(folder, 'child.pid');
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script, pidFile], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  let descendant;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { descendant = Number(await fs.readFile(pidFile, 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(descendant);
  const ended = new Promise(resolve => child.once('exit', resolve));
  await stopTree(child); await ended;
  assert.throws(() => process.kill(child.pid, 0));
  // A child can briefly be a zombie awaiting the container's init reaper; it cannot continue building.
  try {
    const stat = await fs.readFile(`/proc/${descendant}/stat`, 'utf8');
    assert.match(stat, /\) Z /);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
});
