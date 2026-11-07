#!/usr/bin/env bash
set -euo pipefail

configuration="${1:-Debug}"
case "$configuration" in Debug|Release) ;; *) echo 'Choose Debug or Release.' >&2; exit 2 ;; esac
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${project_root}/build"
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'Use build.ps1 on Windows.' >&2; exit 1 ;; esac
command -v cmake >/dev/null 2>&1 || { echo 'Install CMake 3.20 or later.' >&2; exit 127; }

wx_config="${WX_CONFIG:-}"
if [[ -z "$wx_config" ]]; then
  for marker in ".wxroot.${platform}" .wxroot; do
    if [[ -f "${project_root}/${marker}" ]]; then
      location="$(tr -d '\r\n' < "${project_root}/${marker}")"
      [[ "$location" == '__WXWIDGETS_ROOT__' ]] && location=''
      if [[ "$marker" == '.wxroot' && "$location" =~ ^[A-Za-z]: ]]; then location=''; fi
      if [[ -n "$location" ]]; then
        [[ "$location" != /* ]] && location="${project_root}/${location}"
        if [[ -f "$location" && -x "$location" ]]; then wx_config="$location"
        elif [[ -x "${location}/bin/wx-config" ]]; then wx_config="${location}/bin/wx-config"
        elif [[ -x "${location}/wx-config" ]]; then wx_config="${location}/wx-config"
        else echo "No wx-config found at ${location}. Select the SDK for this platform." >&2; exit 1; fi
        break
      fi
    fi
  done
fi
if [[ -z "$wx_config" ]]; then wx_config="$(command -v wx-config || true)"; fi
if [[ -z "$wx_config" && "$platform" == darwin ]]; then
  for prefix in /opt/homebrew/opt/wxwidgets /usr/local/opt/wxwidgets; do
    if [[ -x "${prefix}/bin/wx-config" ]]; then wx_config="${prefix}/bin/wx-config"; break; fi
  done
fi
[[ -n "$wx_config" ]] || { echo 'Install the wxWidgets development package and add wx-config to PATH.' >&2; exit 1; }
wx_config="$(command -v "$wx_config")"
"$wx_config" --version >/dev/null
export WX_CONFIG="$wx_config"
cmake_args=(-S "$project_root" -B "$build_dir" "-DCMAKE_BUILD_TYPE=${configuration}" "-DwxWidgets_CONFIG_EXECUTABLE=${wx_config}")
if [[ ! -f "${build_dir}/CMakeCache.txt" ]] && command -v ninja >/dev/null 2>&1; then cmake_args+=(-G Ninja); fi
cmake "${cmake_args[@]}"
cmake --build "$build_dir" --config "$configuration" --parallel
