'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('./core');
const { BuildTerminal } = require('./build');
const { detectCapabilities } = require('./platform');

function activate(context) {
  const output = vscode.window.createOutputChannel('wxWidgets Tools');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.command = 'wxwidgets.selectConfiguration';
  context.subscriptions.push(output, statusBar);
  const notifications = new Map(), notified = new Set(), activeBuilds = new Map();
  const terminals = new Set();
  let disposed = false;
  let hostProbe, probedAt = 0;
  async function capabilities() {
    if (!hostProbe || Date.now() - probedAt > 15000) {
      probedAt = Date.now();
      hostProbe = detectCapabilities({ cpptoolsPath: vscode.extensions.getExtension('ms-vscode.cpptools')?.extensionPath });
    }
    return hostProbe;
  }
  const localFolders = () => (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
  const key = folder => folder.uri.toString();
  const selected = folder => context.workspaceState.get(`configuration:${key(folder)}`, 'Debug');
  const trusted = () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using wxWidgets commands.');
    if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error('This operating system is not supported.');
  };
  const report = error => {
    output.appendLine(error.stack || String(error));
    void vscode.window.showErrorMessage(`wxWidgets: ${error.message}`);
  };
  async function chooseFolder(resource, requireProject = true) {
    const uri = resource?.uri || resource;
    let folders = localFolders();
    if (uri?.scheme) {
      const target = vscode.workspace.getWorkspaceFolder(uri);
      if (target?.uri.scheme === 'file') folders = [target];
      else throw new Error('Choose a folder in the current workspace.');
    } else {
      const current = vscode.window.activeTextEditor?.document.uri;
      const target = current && vscode.workspace.getWorkspaceFolder(current);
      if (target && (!requireProject || await core.isProject(target.uri.fsPath))) folders = [target];
    }
    if (requireProject) {
      const projects = await Promise.all(folders.map(async folder =>
        await core.isProject(folder.uri.fsPath) ? folder : undefined));
      folders = projects.filter(Boolean);
    }
    if (!folders.length) throw new Error(requireProject
      ? 'Open a wxWidgets CMake project with a build script, or create a new project.'
      : 'Open a local project folder first.');
    if (folders.length === 1) return folders[0];
    return (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name,
      description: folder.uri.fsPath, folder })), { placeHolder: 'Select a wxWidgets project' }))?.folder;
  }
  async function detectSdk(folder, configuration) {
    return core.findSdk(folder?.uri.fsPath,
      vscode.workspace.getConfiguration('wxwidgets', folder?.uri).get('sdkPath', ''),
      context.globalState.get(`lastSdkPath:${process.platform}`, process.platform === 'win32' ? context.globalState.get('lastSdkPath', '') : ''), process.env, configuration);
  }
  async function saveSdk(folder, sdk) {
    trusted();
    if (folder) {
      const file = path.join(folder.uri.fsPath, core.sdkFileName());
      let previous;
      try { previous = (await fs.readFile(file, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (previous !== sdk.root) await fs.writeFile(file, sdk.root + '\n');
    }
    await context.globalState.update(`lastSdkPath:${process.platform}`, sdk.root);
  }
  async function pickSdk(folder, configuration) {
    trusted();
    while (!disposed) {
      const selectedPaths = await vscode.window.showOpenDialog({ canSelectFiles: false,
        canSelectFolders: true, canSelectMany: false, openLabel: 'Use wxWidgets SDK',
        title: `Select wxWidgets SDK${configuration ? ` for ${configuration}` : ''}` });
      if (!selectedPaths?.length) return;
      const sdk = await core.inspectSdk(selectedPaths[0].fsPath, configuration);
      if (sdk.valid) { await saveSdk(folder, sdk); return sdk; }
      const retry = await vscode.window.showWarningMessage(sdk.reason, 'Choose Another Folder...');
      if (!retry) return;
    }
  }
  async function ensureSdk(folder, configuration, automatic = false) {
    trusted();
    const sdk = await detectSdk(folder, configuration);
    if (sdk.valid) { await saveSdk(folder, sdk); return sdk; }
    const id = `${folder ? key(folder) : 'global'}:${configuration || ''}`;
    const noticeKey = `${id}:${sdk.reason}`;
    if (notifications.has(id)) return notifications.get(id);
    if (automatic && notified.has(noticeKey)) return;
    notified.add(noticeKey);
    const pending = (async () => {
      const action = await vscode.window.showInformationMessage(`wxWidgets: ${sdk.reason}`, 'Locate...');
      if (action === 'Locate...' && !disposed) return pickSdk(folder, configuration);
    })();
    notifications.set(id, pending);
    try { return await pending; } finally { notifications.delete(id); }
  }
  async function getStatus(resource) {
    const folder = resource ? await chooseFolder(resource, false) : localFolders()[0];
    const configuration = folder ? selected(folder) : 'Debug';
    return { version: context.extension.packageJSON.version, preview: true,
      workspace: folder?.uri.fsPath, configuration, sdk: await detectSdk(folder, configuration), capabilities: await capabilities() };
  }
  async function showStatus(resource) {
    const status = await getStatus(resource);
    output.clear();
    output.appendLine(`wxWidgets Tools ${status.version}`);
    output.appendLine(`Workspace: ${status.workspace || 'No folder open'}`);
    output.appendLine(`Configuration: ${status.configuration}`);
    output.appendLine(`Platform: ${status.capabilities.platform} ${status.capabilities.arch}`);
    output.appendLine(`Compiler: ${status.capabilities.compiler || 'Not found'}`);
    output.appendLine(`CMake: ${status.capabilities.cmake || 'Not found'} ${status.capabilities.cmakeVersion || ''}`);
    output.appendLine(`Build tool: ${status.capabilities.generator || 'Not found'}`);
    output.appendLine(`Debugger: ${status.capabilities.debugger?.label || 'Not found — install GDB or LLDB with an adapter'}`);
    output.appendLine(status.sdk.valid ? `SDK: ${status.sdk.root}\nLibraries: ${status.sdk.libraryDirectory}` : `SDK: ${status.sdk.reason}`);
    if (status.sdk.configExecutable) output.appendLine(`wx-config: ${status.sdk.configExecutable}`);
    for (const issue of status.capabilities.issues) output.appendLine(issue);
    output.appendLine('Commands: New Project, Set Up Current Project, Locate SDK, Build Debug/Release, Run, Debug.');
    output.show(true);
    return status;
  }
  async function refresh() {
    if (disposed) return;
    const projects = [];
    for (const folder of localFolders()) {
      if (await core.isProject(folder.uri.fsPath)) projects.push(folder);
    }
    if (disposed) return;
    await vscode.commands.executeCommand('setContext', 'wxwidgets.project', projects.length > 0);
    const current = vscode.window.activeTextEditor?.document.uri;
    const active = current && vscode.workspace.getWorkspaceFolder(current);
    const folder = projects.find(f => active && key(f) === key(active)) || projects[0];
    if (folder) {
      statusBar.text = `$(tools) wxWidgets: ${selected(folder)}`;
      statusBar.tooltip = `${folder.name} — select Debug or Release`;
      statusBar.show();
      if (vscode.workspace.isTrusted) {
        const host = await capabilities();
        if (await core.exists(path.join(folder.uri.fsPath, '.wxwidgets.json')))
          await core.configureProject(folder.uri.fsPath, host);
        if (host.issues.length && !notified.has('toolchain')) {
          notified.add('toolchain');
          void vscode.window.showInformationMessage(`wxWidgets: ${host.issues.join(' ')}`, 'Show Status').then(action => {
            if (action === 'Show Status') return showStatus(folder.uri);
          }).catch(report);
        }
        void ensureSdk(folder, selected(folder), true).catch(report);
      }
    } else statusBar.hide();
  }
  function makeTask(folder, configuration, definition = { type: 'wxwidgets', configuration }) {
    if (!core.configurations.includes(configuration)) throw new Error('Unsupported build configuration.');
    const id = key(folder);
    let terminal;
    terminal = new BuildTerminal(vscode, { folder: folder.uri.fsPath, configuration,
      log: text => output.append(text),
      acquire() {
        if (activeBuilds.has(id)) throw new Error('A wxWidgets build is already running for this project.');
        activeBuilds.set(id, terminal);
        terminals.add(terminal);
      },
      release() {
        if (activeBuilds.get(id) === terminal) activeBuilds.delete(id);
        terminals.delete(terminal);
      },
      prepare: async () => {
        trusted();
        const host = await capabilities();
        if (!host.canBuild) throw new Error(host.issues.join('\n'));
        if (!await core.isProject(folder.uri.fsPath)) throw new Error('The wxWidgets project is not configured.');
        if (process.platform === 'win32' && !await core.exists(path.join(folder.uri.fsPath, 'scripts', 'build.ps1')))
          throw new Error('The project build script scripts/build.ps1 is missing.');
        const sdk = await ensureSdk(folder, configuration);
        return sdk && { ...sdk, capabilities: host, info: await core.projectInfo(folder.uri.fsPath) };
      }
    });
    const task = new vscode.Task(definition, folder, `Build (${configuration})`, 'wxWidgets',
      new vscode.CustomExecution(async () => terminal), [process.platform === 'win32' ? '$msCompile' : '$gcc']);
    task.group = vscode.TaskGroup.Build;
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated,
      clear: true, showReuseMessage: false };
    return { task, terminal };
  }
  async function build(folder, configuration) {
    trusted();
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    const { task, terminal } = makeTask(folder, configuration);
    let execution;
    let finishTask;
    const ended = new Promise(resolve => { finishTask = resolve; });
    const listener = vscode.tasks.onDidEndTask(event => {
      if (event.execution === execution) {
        if (!terminal.finished) terminal.close();
        finishTask();
      }
    });
    try {
      execution = await vscode.tasks.executeTask(task);
      const code = await terminal.completion;
      await ended;
      return code === 0;
    } finally { listener.dispose(); }
  }
  async function newProject() {
    trusted();
    const remembered = context.globalState.get('lastProjectParent');
    let suggested = remembered || path.join(os.homedir(), 'source');
    try { await fs.access(suggested); } catch { suggested = os.homedir(); }
    const parents = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, title: 'Choose a parent folder for your wxWidgets project',
      openLabel: 'Create Project Here', defaultUri: vscode.Uri.file(suggested) });
    if (!parents?.length) return;
    const parent = parents[0].fsPath;
    const name = await vscode.window.showInputBox({ title: 'New wxWidgets Project', prompt: 'Project name',
      placeHolder: 'MyApp', ignoreFocusOut: true,
      validateInput: async value => {
        if (!core.validName(value)) return 'Start with a letter; use letters, numbers, and underscores (up to 64 characters).';
        try { await fs.lstat(path.join(parent, value)); return 'A file or folder with this name already exists.'; }
        catch (error) { if (error.code !== 'ENOENT') return error.message; }
      } });
    if (!name) return;
    const sdk = await detectSdk(undefined, 'Debug');
    const host = await capabilities();
    const destination = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: `Creating ${name}...` }, () => core.createProject(path.join(context.extensionPath,
      'templates', 'wxapp-cmake'), parent, name, sdk.valid ? sdk.root : '', host));
    await context.globalState.update('lastProjectParent', parent);
    if (sdk.valid) await context.globalState.update(`lastSdkPath:${process.platform}`, sdk.root);
    const hasWorkspace = !!vscode.workspace.workspaceFile || !!vscode.workspace.workspaceFolders?.length;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination),
      hasWorkspace ? { forceNewWindow: true } : { forceReuseWindow: true });
    return destination;
  }
  async function configureProject(resource) {
    trusted();
    const folder = await chooseFolder(resource);
    if (!folder) return;
    await core.configureProject(folder.uri.fsPath, await capabilities());
    await ensureSdk(folder, selected(folder));
    void vscode.window.showInformationMessage('wxWidgets Debug/Release build tasks and launch configurations are ready.');
    await refresh();
    return true;
  }
  async function selectConfiguration(resource) {
    const folder = await chooseFolder(resource);
    if (!folder) return;
    const configuration = await vscode.window.showQuickPick(core.configurations,
      { placeHolder: `Build configuration for ${folder.name}`, title: 'wxWidgets' });
    if (!configuration) return;
    await context.workspaceState.update(`configuration:${key(folder)}`, configuration);
    await refresh();
    return configuration;
  }
  async function launch(resource, noDebug) {
    trusted();
    const folder = await chooseFolder(resource);
    if (!folder) return false;
    const info = await core.projectInfo(folder.uri.fsPath);
    return vscode.debug.startDebugging(folder, core.launchConfiguration(info, selected(folder), await capabilities()), { noDebug });
  }
  const provider = {
    async provideDebugConfigurations(folder) {
      if (!folder || !await core.isProject(folder.uri.fsPath)) return [];
      const info = await core.projectInfo(folder.uri.fsPath);
      const host = await capabilities();
      return core.configurations.map(c => core.launchConfiguration(info, c, host));
    },
    async resolveDebugConfiguration(folder, config) {
      try {
        if (!folder || !await core.isProject(folder.uri.fsPath)) return config;
        if (!config.type && !config.request && !config.name) {
          const info = await core.projectInfo(folder.uri.fsPath);
          config = core.launchConfiguration(info, selected(folder), await capabilities());
        }
        const match = /^wxWidgets: Build \((Debug|Release)\)$/.exec(config.preLaunchTask || '');
        if (!match || config.request !== 'launch') return config;
        const host = await capabilities();
        if (!host.debugger) throw new Error(process.platform === 'darwin'
          ? 'Install LLDB with lldb-dap, or use the LLDB adapter supplied by Microsoft C/C++. Run Show Status to check your tools.'
          : 'Install GDB or LLDB with lldb-dap to run and debug this application.');
        if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
          throw new Error('A graphical desktop session is required to launch a wxWidgets application.');
        if (!await build(folder, match[1])) {
          void vscode.window.showErrorMessage('wxWidgets build failed or was cancelled. The application was not launched.');
          return undefined;
        }
        const result = { ...config };
        delete result.preLaunchTask;
        return result;
      } catch (error) { await report(error); return undefined; }
    }
  };
  context.subscriptions.push(vscode.tasks.registerTaskProvider('wxwidgets', {
    async provideTasks() {
      if (!vscode.workspace.isTrusted || !['win32', 'linux', 'darwin'].includes(process.platform)) return [];
      const tasks = [];
      for (const folder of localFolders()) if (await core.isProject(folder.uri.fsPath))
        for (const config of core.configurations) tasks.push(makeTask(folder, config).task);
      return tasks;
    },
    resolveTask(task) {
      if (!task.scope?.uri || task.scope.uri.scheme !== 'file') return;
      return makeTask(task.scope, task.definition.configuration, task.definition).task;
    }
  }));
  for (const type of ['cppvsdbg', 'cppdbg', 'wxwidgets-lldb'])
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(type, provider));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('wxwidgets-lldb', {
    async createDebugAdapterDescriptor() {
      trusted();
      const host = await capabilities();
      if (host.debugger?.type !== 'wxwidgets-lldb' || !host.debugger.path)
        throw new Error('LLDB DAP was not found. Install a toolchain providing lldb-dap.');
      return new vscode.DebugAdapterExecutable(host.debugger.path);
    }
  }));
  const commands = {
    'wxwidgets.showStatus': showStatus,
    'wxwidgets.newProject': newProject,
    'wxwidgets.configureProject': configureProject,
    'wxwidgets.locateSdk': async resource => {
      const folder = localFolders().length ? await chooseFolder(resource, false) : undefined;
      if (localFolders().length && !folder) return;
      const sdk = await pickSdk(folder, folder ? selected(folder) : undefined);
      if (sdk) { await refresh(); return showStatus(folder?.uri); }
    },
    'wxwidgets.buildDebug': async resource => {
      const folder = await chooseFolder(resource); return folder ? build(folder, 'Debug') : false;
    },
    'wxwidgets.buildRelease': async resource => {
      const folder = await chooseFolder(resource); return folder ? build(folder, 'Release') : false;
    },
    'wxwidgets.selectConfiguration': selectConfiguration,
    'wxwidgets.run': resource => launch(resource, true),
    'wxwidgets.debug': resource => launch(resource, false)
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try { return await handler(...args); }
      catch (error) { await report(error); return false; }
    }));
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.wxroot,.wxroot.linux,.wxroot.darwin,.wxwidgets.json,CMakeLists.txt}');
  const update = () => { void refresh().catch(report); };
  context.subscriptions.push(watcher, watcher.onDidChange(update), watcher.onDidCreate(update),
    watcher.onDidDelete(update), vscode.workspace.onDidChangeWorkspaceFolders(update),
    vscode.window.onDidChangeActiveTextEditor(update), vscode.workspace.onDidGrantWorkspaceTrust(update),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('wxwidgets')) update(); }),
    { dispose() { disposed = true; for (const terminal of terminals) terminal.close(); } });
  output.appendLine(`wxWidgets Tools ${context.extension.packageJSON.version} activated.`);
  update();
  return { getStatus };
}

module.exports = { activate };
