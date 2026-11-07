'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('../src/core');
const prepare = require('./prepare-template');

async function main() {
  if (process.platform !== 'win32') throw new Error('Native integration tests require Windows x64.');
  const root = path.resolve(__dirname, '..');
  const executable = process.env.VSCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA,
    'Programs', 'Microsoft VS Code', 'Code.exe');
  await fs.access(executable);
  const sdk = await core.findSdk(undefined, '', '', process.env, 'Debug');
  if (!sdk.valid) throw new Error(sdk.reason);
  const release = await core.inspectSdk(sdk.root, 'Release');
  if (!release.valid) throw new Error(release.reason);
  await prepare();
  const work = path.join(root, '.test-work');
  await fs.mkdir(work, { recursive: true });
  const fixture = await core.createProject(path.join(root, 'templates', 'wxapp-cmake'),
    work, `IntegrationApp${Date.now()}`, sdk.root);
  const report = path.join(work, 'host-result.json');
  await fs.writeFile(report, JSON.stringify({ pending: true }));
  console.log('Testing in VS Code: ' + fixture);
  const child = spawn(executable, ['--new-window', `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'test', 'host.test.js')}`,
    `--user-data-dir=${path.join(work, 'integration-profile')}`, '--disable-workspace-trust',
    '--disable-extension=wx-core-local.wxwidgets-tools',
    '--skip-welcome', '--skip-release-notes', fixture], { windowsHide: true, stdio: 'ignore' });
  let launchError;
  child.once('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 360; attempt++) {
    if (launchError) throw launchError;
    let result;
    try { result = JSON.parse(await fs.readFile(report, 'utf8')); } catch { /* Report may be mid-write. */ }
    if (typeof result?.success === 'boolean') {
      if (!result.success) throw new Error(result.error);
      for (const message of result.results) console.log('PASS: ' + message);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('VS Code integration tests did not finish within three minutes. See .test-work/integration-profile/logs.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
