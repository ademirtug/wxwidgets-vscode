# wxapp

A portable wxWidgets C++20 application built with CMake.

## In VS Code

Install wxWidgets Tools, open this folder, and use F5 to build and debug or Ctrl+F5 to build and run. Choose Debug or Release from the Run and Debug dropdown. Ctrl+Shift+B builds without running.

The extension detects the current platform and updates its generated launch settings when this project is opened on another system. Keep your application code portable and build it separately on each target OS.

## Build from a terminal

Windows, with MSVC x64 and a compiled wxWidgets SDK:

```powershell
./scripts/build.ps1 -Configuration Debug
./scripts/build.ps1 -Configuration Release
```

Linux or macOS, with GCC/Clang, CMake, Make or Ninja, and wxWidgets development libraries:

```bash
bash scripts/build.sh Debug
bash scripts/build.sh Release
```

On Linux and macOS, wx-config must be available. You can also set WX_CONFIG to its full path. Debug builds of the application can link to the standard wxWidgets libraries supplied by your package manager.

SDK paths are local to each machine and excluded from version control. Use Locate SDK in VS Code to choose a different installation. Build output goes into build/Debug or build/Release. macOS builds produce an application bundle in the configuration's bin directory.

Close a running application before rebuilding its executable. Runtime libraries must be installed on each system; this template does not create a standalone distribution package or cross-compile for other operating systems.
