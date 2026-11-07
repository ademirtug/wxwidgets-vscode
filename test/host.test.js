'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function run() {
  const extension = vscode.extensions.getExtension('wx-core-local.wxwidgets-tools');
  assert.ok(extension, 'Local extension must be discoverable');
  const api = await extension.activate();
  assert.ok(extension.isActive, 'Extension must activate');
  const commands = await vscode.commands.getCommands(true);
  for (const command of extension.packageJSON.contributes.commands) {
    assert.ok(commands.includes(command.command), `Missing command: ${command.command}`);
  }
  const status = await api.getStatus();
  assert.equal(status.preview, true);
  assert.equal(typeof status.sdk.valid, 'boolean');
  console.log('PASS: extension activation, command registration, and SDK status in VS Code.');
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !folder.uri.fsPath.includes(`${path.sep}.test-work${path.sep}`)) return;
  const reportFile = path.join(__dirname, '..', '.test-work', 'host-result.json');
  const results = [];
  const info = JSON.parse(await fs.readFile(path.join(folder.uri.fsPath, '.wxwidgets.json'), 'utf8'));
  const diagnostic = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory('cppvsdbg', {
    createDebugAdapterTracker() { return { onDidSendMessage(message) {
      if (message.type === 'response' && !message.success) diagnostic.push(message);
      if (message.event === 'output') diagnostic.push(message.body);
    } }; }
  });
  async function stopSession() {
    const session = vscode.debug.activeDebugSession;
    if (!session) return;
    const system32 = path.join(process.env.SystemRoot, 'System32');
    for (let attempt = 0; attempt < 50; attempt++) {
      const { stdout } = await promisify(execFile)(path.join(system32, 'tasklist.exe'),
        ['/FI', `IMAGENAME eq ${info.name}.exe`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      if (stdout.includes(info.name + '.exe')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const ended = new Promise(resolve => {
      const timer = setTimeout(() => { listener.dispose(); resolve(); }, 10000);
      const listener = vscode.debug.onDidTerminateDebugSession(event => {
        if (event.id === session.id) { clearTimeout(timer); listener.dispose(); resolve(); }
      });
    });
    await vscode.debug.stopDebugging(session);
    await ended;
    // A noDebug disconnect can leave its GUI process alive. Only stop this test's unique image.
    assert.match(info.name, /^IntegrationApp\d+$/);
    await promisify(execFile)(path.join(system32, 'taskkill.exe'), ['/IM', info.name + '.exe', '/T', '/F'], { windowsHide: true }).catch(error => { diagnostic.push(error.message); });
  }
  const record = async message => {
    results.push(message); console.log('PASS: ' + message);
    await fs.writeFile(reportFile, JSON.stringify({ results }, null, 2));
  };
  try {
    assert.equal(status.sdk.valid, true, 'Real SDK must be available for integration tests');
    const tasks = await vscode.tasks.fetchTasks({ type: 'wxwidgets' });
    assert.ok(tasks.some(t => t.definition.configuration === 'Debug'));
    assert.ok(tasks.some(t => t.definition.configuration === 'Release'));
    await record('Debug and Release tasks discovered');
    assert.equal(await vscode.commands.executeCommand('wxwidgets.buildDebug', folder.uri), true);
    await record('Debug build through VS Code task provider');
    assert.equal(await vscode.commands.executeCommand('wxwidgets.buildRelease', folder.uri), true);
    await record('Release build through VS Code task provider');
    assert.equal(await vscode.commands.executeCommand('wxwidgets.run', folder.uri), true);
    assert.ok(vscode.debug.activeDebugSession, 'Run without debugging starts a session');
    await stopSession();
    await record('Run without debugging launches and stops the native app');
    const launch = { name: 'wxWidgets: Debug', type: 'cppvsdbg', request: 'launch',
      program: path.join(folder.uri.fsPath, 'build/Debug/bin', info.name + '.exe'),
      cwd: folder.uri.fsPath, preLaunchTask: 'wxWidgets: Build (Debug)', stopAtEntry: true };
    assert.equal(await vscode.debug.startDebugging(folder, launch), true);
    assert.ok(vscode.debug.activeDebugSession);
    await stopSession();
    await record('F5 configuration launches using the Microsoft C++ debugger');
    const source = path.join(folder.uri.fsPath, 'main.cpp');
    const original = await fs.readFile(source, 'utf8');
    try {
      await fs.writeFile(source, original + '\n#error intentional build failure for integration test\n');
      assert.equal(await vscode.debug.startDebugging(folder, launch), false);
      assert.equal(vscode.debug.activeDebugSession, undefined);
      await record('Failed build blocks launching the previous executable');
    } finally { await fs.writeFile(source, original); }
    await fs.writeFile(reportFile, JSON.stringify({ success: true, results }, null, 2));
  } catch (error) {
    await fs.writeFile(reportFile, JSON.stringify({ success: false, error: error.stack, results, diagnostic }, null, 2));
    throw error;
  } finally { tracker.dispose(); }
}

module.exports = { run };
