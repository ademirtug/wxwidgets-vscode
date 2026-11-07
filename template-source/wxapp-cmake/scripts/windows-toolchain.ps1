function Find-VsDevCmd {
    if ($env:WXWIDGETS_VSDEVCMD -and (Test-Path -LiteralPath $env:WXWIDGETS_VSDEVCMD)) { return $env:WXWIDGETS_VSDEVCMD }
    $vswhere = @(
        'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe',
        'C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe'
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if ($vswhere) {
        $installPath = & $vswhere -latest -version '[17.0,19.0)' -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($installPath) {
            $devCmd = Join-Path $installPath 'Common7\Tools\VsDevCmd.bat'
            if (Test-Path -LiteralPath $devCmd) { return $devCmd }
        }
        return $null
    }

    # Standard VS 2026 locations when the installer locator is unavailable.
    $roots = @('C:\Program Files\Microsoft Visual Studio\18', 'C:\Program Files (x86)\Microsoft Visual Studio\18', 'C:\Program Files\Microsoft Visual Studio\2022', 'C:\Program Files (x86)\Microsoft Visual Studio\2022')
    foreach ($root in $roots) {
        foreach ($edition in @('BuildTools', 'Community', 'Professional', 'Enterprise')) {
            $installPath = Join-Path $root $edition
            $devCmd = Join-Path $installPath 'Common7\Tools\VsDevCmd.bat'
            $compiler = Join-Path $installPath 'VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe'
            if ((Test-Path -LiteralPath $devCmd) -and (Test-Path -Path $compiler)) {
                return $devCmd
            }
        }
    }

    return $null
}
