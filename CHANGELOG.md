# Changelog

## 0.3.3

- Simplify the extension page with installation, documentation, and issue reporting links.
- Move detailed setup and usage instructions to a separate user guide.

## 0.3.2

- Shorten the extension description to wxWidgets Support.

## 0.3.1

- Add a three-square extension icon inspired by the wxWidgets logo.

## 0.3.0

- Detect host compilers, CMake, build tools, and debuggers on Windows, Linux, and macOS.
- Discover Unix wxWidgets installations through wx-config, including system and Homebrew installations.
- Create macOS application bundles and select GDB or LLDB launch settings on Unix systems.
- Adapt generated launch settings when opening a project on another OS, preserving custom arguments.
- Keep SDK paths local to each platform and exclude them from generated project version control.
- Add Unix process-group cancellation, native application checks, and a three-platform CI workflow.
- Package a universal extension. Linux and macOS integration is experimental pending native verification.

## 0.2.1

- Reuse an empty VS Code window when creating a project; open a new window when a folder or workspace is already open.
- Simplify the extension Details page with quick-start instructions, shortcuts, and requirements.

## 0.2.0

- Create wxWidgets CMake applications from a bundled template and open them in VS Code.
- Discover and remember SDKs; offer Locate notifications when the requested configuration is missing.
- Add Debug/Release build tasks and native Microsoft C++ launch configurations.
- Build, run, and debug from commands, F5, and Ctrl+F5.
- Select a command configuration from the status bar.
- Preserve existing tasks, launch entries, and JSONC comments during project setup.
- Stop child build processes on cancellation and prevent launches after failed builds.
- Add unit and VS Code integration tests.

## 0.1.0

- Initial SDK discovery and status commands.
