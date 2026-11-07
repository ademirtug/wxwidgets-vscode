param(
    [ValidateSet('Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel')]
    [string]$Configuration = 'Debug',
    [switch]$BootstrapIfMissing = $true
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-toolchain.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $projectRoot 'build'

function Find-CMake {
    if ($env:WXWIDGETS_CMAKE -and (Test-Path -LiteralPath $env:WXWIDGETS_CMAKE)) { return $env:WXWIDGETS_CMAKE }
    $cmd = Get-Command cmake -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Path }

    $candidates = @(
        'C:\Program Files\CMake\bin\cmake.exe',
        'C:\Program Files (x86)\CMake\bin\cmake.exe'
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }

    return $null
}

function Ensure-CMake {
    $cmakePath = Find-CMake
    if ($cmakePath) { return $cmakePath }

    if (-not $BootstrapIfMissing) {
        throw "cmake not found on PATH. Install CMake or run scripts\\bootstrap-windows.ps1."
    }

    $bootstrapScript = Join-Path $PSScriptRoot 'bootstrap-windows.ps1'
    if (-not (Test-Path -LiteralPath $bootstrapScript)) {
        throw "cmake not found and bootstrap script missing at $bootstrapScript"
    }

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "cmake not found and winget is not available. Install CMake manually or install winget (App Installer) and re-run."
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $bootstrapScript
    if ($LASTEXITCODE -ne 0) { throw "Dependency bootstrap failed (exit code $LASTEXITCODE)." }

    $cmakePath = Find-CMake
    if ($cmakePath) { return $cmakePath }

    throw "CMake install was attempted, but cmake is still not found. Re-open your terminal/VS Code and try again."
}

function Ensure-MsvcBuildTools {
    if (Find-VsDevCmd) { return }

    if (-not $BootstrapIfMissing) {
        throw "Visual Studio C++ Build Tools not found. Run scripts\\bootstrap-windows.ps1."
    }

    $bootstrapScript = Join-Path $PSScriptRoot 'bootstrap-windows.ps1'
    if (-not (Test-Path -LiteralPath $bootstrapScript)) {
        throw "MSVC Build Tools not found and bootstrap script missing at $bootstrapScript"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $bootstrapScript -SkipCMake
    if ($LASTEXITCODE -ne 0) { throw "Dependency bootstrap failed (exit code $LASTEXITCODE)." }

    $vsDevCmd = Find-VsDevCmd
    if (-not $vsDevCmd) {
        throw "Visual Studio C++ Build Tools install was attempted, but VsDevCmd.bat was not found. Re-run bootstrap or install the C++ workload manually."
    }
}

function Get-WxRoot {
    $wxRootFile = Join-Path $projectRoot '.wxroot'
    $wxRoot = ''

    if (Test-Path -LiteralPath $wxRootFile) {
        $wxRoot = (Get-Content -LiteralPath $wxRootFile -Raw).Trim()
    }

    if ($wxRoot -eq '__WXWIDGETS_ROOT__') {
        $wxRoot = ''
    }

    if (-not $wxRoot) {
        if (Test-Path -LiteralPath 'C:\dev\wx\wxwidgets.props') {
            $wxRoot = 'C:\dev\wx'
        }
    }

    return $wxRoot
}

$cmakeBinDir = Join-Path $buildDir 'bin'

function Find-WxDllDir([string]$wxRoot, [string]$configuration) {
    $libRoot = Join-Path $wxRoot 'lib'
    if (-not (Test-Path -LiteralPath $libRoot)) { return $null }

    $arch = 'x64'
    $pattern = if ($configuration -eq 'Debug') { "*ud_core*_${arch}.dll" } else { "*u_core*_${arch}.dll" }

    $coreDll = Get-ChildItem -LiteralPath $libRoot -Recurse -File -Filter "wxmsw*_${arch}.dll" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like $pattern } |
        Select-Object -First 1

    if ($coreDll) { return $coreDll.DirectoryName }
    return $null
}

function Copy-WxRuntimeDlls([string]$wxRoot, [string]$configuration) {
    $dllDir = Find-WxDllDir -wxRoot $wxRoot -configuration $configuration
    if (-not $dllDir) {
        Write-Warning "wxWidgets DLL directory not found under '$wxRoot\\lib'. If you built wxWidgets statically, this is OK; otherwise the EXE may fail to run."
        return
    }

    New-Item -ItemType Directory -Force -Path $cmakeBinDir | Out-Null

    $dlls = Get-ChildItem -LiteralPath $dllDir -File -Filter 'wx*.dll' -ErrorAction SilentlyContinue
    if (-not $dlls) {
        Write-Warning "No wx*.dll files found in '$dllDir'."
        return
    }

    Copy-Item -LiteralPath $dlls.FullName -Destination $cmakeBinDir -Force
}

$wxRoot = Get-WxRoot

$cmake = Ensure-CMake
Ensure-MsvcBuildTools
$vsDevCmd = Find-VsDevCmd

$cmakeConfigureArgs = @(
    '-S', $projectRoot,
    '-B', $buildDir
)

if ($wxRoot) {
    $cmakeConfigureArgs += "-DwxWidgets_ROOT_DIR=$wxRoot"
}
else {
    throw @"
wxWidgets root not found.

On Windows, either:
  - Install wxWidgets in C:\dev\wx (expected to contain wxwidgets.props), or
  - Select the SDK with wxWidgets: Locate SDK in VS Code, or
  - Put the wxWidgets root path into .wxroot in the project root.
"@
}

if (-not $vsDevCmd) {
    throw "Visual Studio VsDevCmd.bat not found. Run scripts\\bootstrap-windows.ps1."
}

Write-Host "Using Visual Studio tools: $vsDevCmd"

$generator = 'NMake Makefiles'
$ninja = Get-Command ninja -ErrorAction SilentlyContinue
if ($ninja) {
    $generator = 'Ninja'
}
if ($env:WXWIDGETS_GENERATOR) { $generator = $env:WXWIDGETS_GENERATOR }

$cmakeConfigureArgs += "-DCMAKE_BUILD_TYPE=$Configuration"
$cmakeConfigureArgs += @('-G', $generator)

$configure = '"' + ($cmakeConfigureArgs -join '" "') + '"'
cmd /c "call `"$vsDevCmd`" -host_arch=x64 -arch=x64 >nul && `"$cmake`" $configure"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$buildArgs = @('--build', $buildDir)
if ($generator -ne 'Ninja') {
    $buildArgs += @('--config', $Configuration)
}

$build = '"' + ($buildArgs -join '" "') + '"'
cmd /c "call `"$vsDevCmd`" -host_arch=x64 -arch=x64 >nul && `"$cmake`" $build"
$buildExitCode = $LASTEXITCODE
if ($buildExitCode -ne 0) { exit $buildExitCode }

if ($wxRoot) {
    Copy-WxRuntimeDlls -wxRoot $wxRoot -configuration $Configuration
}

exit 0
