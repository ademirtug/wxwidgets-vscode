# Development

Use Node.js 24 and npm.

```powershell
npm ci --ignore-scripts
npm test
npm run package
code --install-extension dist/wxwidgets-tools.vsix --force
```

## Source layout

- `src/extension.js`: VS Code commands, SDK prompts, tasks, and debugger integration.
- `src/core.js`: project generation, SDK validation, and configuration helpers.
- `src/build.js`: task processes and cancellation.
- `template-source/wxapp-cmake`: application template source.
- `templates/`: generated template bundle.
- `dist/`: packaged extension.

Template preparation creates separate Debug and Release build directories and disables automatic tool installation in generated applications. Projects using the original shared build directory retain their `build/bin` layout.

## Verification

`npm test` covers generation, existing destination protection, configuration preservation, SDK validation and precedence, build exit codes, and process-tree cancellation.

Run `npm run test:host` with VS Code and compiled Debug/Release SDK libraries installed to exercise native integration tests. Set `VSCODE_EXECUTABLE` for a nonstandard VS Code installation. The integration suite verifies activation, tasks, native running and debugging, and failed-build protection in an isolated `.test-work` project.

Use a VS Code Extension Development Host for interactive checks. For project creation, verify both an empty window and a window with an existing folder or workspace. Empty windows should be reused; occupied windows should stay open beside the new project.

## Platform integration

`src/platform.js` probes host capabilities without installing tools. Windows uses MSVC x64, supporting Visual Studio 2022 and 2026. Linux selects GCC/Clang and GDB, or native LLDB DAP. macOS selects Clang and LLDB DAP, with the Microsoft C/C++ LLDB MI adapter as a fallback when available.

`src/unix-sdk.js` validates wx-config output, development/setup headers, and compiled wxWidgets libraries. Unix application Debug builds can use distribution-provided optimized wxWidgets libraries. Windows keeps separate ABI-compatible Debug/Release SDK validation.

New projects use metadata schema 2 to identify macOS bundle output. Platform SDK files are ignored by Git. Generated task/debug fields are adapted on trusted workspace activation while preserving custom launch arguments and unrelated entries. Older metadata schema 1 remains supported.

`npm run test:native -- --run` builds and starts an automatically closing generated application in Debug and Release. A GUI session is needed, or `xvfb-run -a` on headless Linux. Without --run it verifies both builds and output paths only.

The test workflow runs unit tests on Windows, Linux, and macOS, builds and runs the native sample on Linux, builds macOS bundles, and packages the extension after verification succeeds. Native macOS debugger testing is a separate manual check.
