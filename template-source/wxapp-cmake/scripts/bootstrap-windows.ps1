param(
    [switch]$SkipCMake
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-toolchain.ps1')

function Has-Command([string]$name) {
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

$needsCMake = -not $SkipCMake -and -not (Has-Command 'cmake')
$needsMsvc = -not (Find-VsDevCmd)

if (($needsCMake -or $needsMsvc) -and -not (Has-Command 'winget')) {
    throw "winget not found. Install App Installer from Microsoft Store or install CMake/MSVC Build Tools manually."
}

if ($needsCMake) {
    winget install --id Kitware.CMake -e --source winget
    if ($LASTEXITCODE -notin @(0, 1641, 3010)) { throw "CMake installation failed (exit code $LASTEXITCODE)." }
}

if ($needsMsvc) {
    winget install --id Microsoft.VisualStudio.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --norestart --wait"
    if ($LASTEXITCODE -notin @(0, 1641, 3010)) { throw "Visual Studio 2026 Build Tools installation failed (exit code $LASTEXITCODE)." }
    if (-not (Find-VsDevCmd)) { throw "Visual Studio 2026 C++ Build Tools were not found after installation. Restart Windows if requested, then run this script again." }
}

Write-Host "Bootstrap complete. Re-open your terminal/VS Code so new tools are on PATH."
