'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
async function prepare() {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'template-source', 'wxapp-cmake');
  const destination = path.join(root, 'templates', 'wxapp-cmake');
  await fs.mkdir(destination, { recursive: true });
  async function copy(from, to) {
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (['.vscode', '.template.config', 'build', '.vs'].includes(entry.name)) continue;
      const src = path.join(from, entry.name), dst = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unsupported template symlink: ${src}`);
      if (entry.isDirectory()) { await fs.mkdir(dst, { recursive: true }); await copy(src, dst); }
      else if (entry.name === 'build.ps1') {
        let text = await fs.readFile(src, 'utf8');
        const old = "$buildDir = Join-Path $projectRoot 'build'";
        if (!text.includes(old)) throw new Error('Windows template build directory changed; update the extension bundler.');
        text = text.replace(old, "$buildDir = Join-Path (Join-Path $projectRoot 'build') $Configuration");
        text = text.replace('[switch]$BootstrapIfMissing = $true', '[switch]$BootstrapIfMissing = $false');
        text = text.replace("$cmakeConfigureArgs += \"-DCMAKE_BUILD_TYPE=$Configuration\"", `if ($env:WXWIDGETS_LIBRARY_DIR) {
    $cmakeConfigureArgs += "-DwxWidgets_LIB_DIR=$env:WXWIDGETS_LIBRARY_DIR"
    if ($env:WXWIDGETS_LIBRARY_DIR -like '*_lib') { $cmakeConfigureArgs += '-DwxWidgets_USE_STATIC=ON' }
    else { $cmakeConfigureArgs += '-DwxWidgets_USE_STATIC=OFF' }
}
$cmakeConfigureArgs += "-DCMAKE_BUILD_TYPE=$Configuration"`);
        text = text.replace("$dllDir = Find-WxDllDir -wxRoot $wxRoot -configuration $Configuration",
          "$dllDir = if ($env:WXWIDGETS_LIBRARY_DIR) { $env:WXWIDGETS_LIBRARY_DIR } else { Find-WxDllDir -wxRoot $wxRoot -configuration $Configuration }");
        text = text.replace('Copy-Item -LiteralPath $dlls.FullName -Destination $cmakeBinDir -Force', `foreach ($dll in $dlls) {
        $target = Join-Path $cmakeBinDir $dll.Name
        if (Test-Path -LiteralPath $target) {
            $targetFile = Get-Item -LiteralPath $target
            if ($targetFile.Length -eq $dll.Length -and $targetFile.LastWriteTimeUtc -eq $dll.LastWriteTimeUtc) { continue }
        }
        Copy-Item -LiteralPath $dll.FullName -Destination $cmakeBinDir -Force
    }`);
        await fs.writeFile(dst, text);
      } else if (entry.name === 'build.sh') {
        const text = (await fs.readFile(src, 'utf8')).replace('build_dir="${project_root}/build"', 'build_dir="${project_root}/build/${configuration}"');
        await fs.writeFile(dst, text);
      } else await fs.copyFile(src, dst);
    }
  }
  await copy(source, destination); await fs.mkdir(path.join(root, 'dist'), { recursive: true });
}
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = prepare;
