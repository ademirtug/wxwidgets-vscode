# Using wxWidgets Tools

Create portable wxWidgets C++ applications in Visual Studio Code, with native build and debug integration for Windows, Linux, and macOS.

## Installation

[Install from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=leximo.wxwidgets-tools), or search for **wxWidgets Tools** in VS Code's Extensions view.

You can also install a packaged `.vsix` file using **Extensions: Install from VSIX...**. To build the package from source, see [Development](../DEVELOPMENT.md).

## Features

- Create a CMake project with a starter window, menus, status bar, and application icon.
- Detect your compiler, CMake, build tools, debugger, and wxWidgets installation.
- Build Debug and Release configurations, then run or debug from VS Code.
- Adapt generated launch settings when a project is opened on another platform.

## Get started

1. Open the Command Palette and select **wxWidgets: New Project...**.
2. Choose a parent folder and enter your project name.
3. If prompted, select **Locate...** and choose your compiled wxWidgets installation.
4. Press **F5** to build and debug, or **Ctrl+F5** to run without debugging.

An empty VS Code window is reused. If a folder or workspace is already open, the new project opens in another window.

## Build and run

| Shortcut | Action |
| --- | --- |
| **F5** | Build and debug |
| **Ctrl+F5** | Build and run without debugging |
| **Ctrl+Shift+B** | Choose a Debug or Release build |

Choose **wxWidgets: Debug** or **wxWidgets: Release** in the Run and Debug dropdown. The status-bar selector controls the extension's Run and Debug commands. Failed or cancelled builds prevent a launch.

## Requirements

VS Code 1.95 or later and CMake 3.20 or later are required. Microsoft C/C++ is installed as an extension dependency.

| Platform | Native tools |
| --- | --- |
| **Windows** | Visual Studio 2022 or 2026 C++ Build Tools, Windows SDK, and compiled wxWidgets MSVC x64 libraries |
| **Linux** | GCC or Clang, Make or Ninja, wxWidgets development libraries with `wx-config`, and GDB or LLDB with `lldb-dap` |
| **macOS** | Xcode Command Line Tools, Make or Ninja, wxWidgets with `wx-config`, and LLDB with `lldb-dap` or the Microsoft C/C++ LLDB adapter |

Install native tools and wxWidgets separately. A graphical desktop session is needed to run GUI applications. Linux and macOS integration is experimental pending native verification.

## SDK and tool status

Use **wxWidgets: Show Status** to check detected capabilities. **wxWidgets: Locate SDK...** selects another installation; `wxwidgets.sdkPath` is also available in Settings. On Unix systems, an installation containing `wx-config` or `bin/wx-config` is expected.

SDK selections stay local to each platform. Build the same source project separately on each OS; creating a project does not cross-compile binaries for other platforms. macOS projects produce an application bundle.

## C++ editor support

When a project SDK is found or selected, the extension configures Microsoft C/C++ IntelliSense with the wxWidgets headers, generated `wx/setup.h`, compiler, and platform definitions. This also applies to existing generated projects when opened with the extension installed.

The extension maintains the **wxWidgets** configuration in `.vscode/c_cpp_properties.json`. Other configurations and comments are preserved. If you already have C/C++ configurations, use **C/C++: Select a Configuration...** to choose **wxWidgets**. Keep custom include paths and definitions in your own configuration; the extension refreshes its managed fields when SDKs or build configurations change.
