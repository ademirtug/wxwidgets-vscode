'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter: NodeEventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { detectCapabilities } = require('../src/platform');
const { BuildTerminal } = require('../src/build');
const core = require('../src/core');
const prepare = require('./prepare-template');

class EventEmitter {
  constructor() { this.emitter = new NodeEventEmitter(); }
  event = handler => { this.emitter.on('data', handler); return { dispose: () => this.emitter.off('data', handler) }; };
  fire(value) { this.emitter.emit('data', value); }
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const host = await detectCapabilities();
  if (!host.canBuild) throw new Error(host.issues.join('\n'));
  const sdk = await core.findSdk(undefined, '', '', process.env, 'Debug');
  if (!sdk.valid) throw new Error(sdk.reason);
  await prepare();
  const work = path.join(root, '.test-work'); await fs.mkdir(work, { recursive: true });
  const name = 'NativeApp' + Date.now();
  const folder = await core.createProject(path.join(root, 'templates', 'wxapp-cmake'), work, name, sdk.root, host);
  const info = await core.projectInfo(folder);
  const source = path.join(folder, 'main.cpp');
  const text = await fs.readFile(source, 'utf8');
  await fs.writeFile(source, text.replace('frame->Show(true);', 'frame->Show(true);\n        CallAfter([frame]() { frame->Close(true); });'));
  for (const configuration of core.configurations) {
    const selected = await core.inspectSdk(sdk.root, configuration);
    assert.equal(selected.valid, true, selected.reason);
    const terminal = new BuildTerminal({ EventEmitter }, { folder, configuration, acquire() {}, release() {},
      log: text => process.stdout.write(text), prepare: async () => ({ ...selected, capabilities: host, info }) });
    terminal.open();
    assert.equal(await terminal.completion, 0, `${configuration} build failed`);
    const launch = core.launchConfiguration(info, configuration, host);
    const executable = launch.program.replace('${workspaceFolder}', folder);
    await fs.access(executable);
    console.log(`PASS: ${process.platform} ${process.arch} ${configuration} application built.`);
    if (process.argv.includes('--run')) {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [], { cwd: folder, windowsHide: true, stdio: 'inherit' });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Application did not close within 20 seconds.')); }, 20000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Application exited with ${code}`)); });
      });
      console.log(`PASS: ${configuration} application started and closed normally.`);
    }
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
