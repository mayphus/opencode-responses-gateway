#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node_version=${NODE_VERSION:-$(node -p 'process.versions.node')}
archive_name="opencode-responses-gateway-windows-x64"
dist_dir="$project_dir/dist"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT INT TERM

node_zip="node-v${node_version}-win-x64.zip"
node_url="https://nodejs.org/dist/v${node_version}/${node_zip}"

mkdir -p "$work_dir/package/src" "$work_dir/package/windows" "$dist_dir"
curl --fail --location --silent --show-error "$node_url" --output "$work_dir/$node_zip"
unzip -q "$work_dir/$node_zip" -d "$work_dir/node"

cp "$work_dir/node/node-v${node_version}-win-x64/node.exe" "$work_dir/package/node.exe"
cp "$work_dir/node/node-v${node_version}-win-x64/LICENSE" "$work_dir/package/NODE-LICENSE.txt"
cp "$project_dir/package.json" "$work_dir/package/package.json"
cp "$project_dir/src/gateway.ts" "$work_dir/package/src/gateway.ts"
cp "$project_dir/src/server.ts" "$work_dir/package/src/server.ts"
cp "$project_dir/packaging/windows/README-WINDOWS.txt" "$work_dir/package/README-WINDOWS.txt"
cp "$project_dir/packaging/windows/config-snippet.toml" "$work_dir/package/config-snippet.toml"
cp "$project_dir/packaging/windows/setup.ps1" "$work_dir/package/windows/setup.ps1"
cp "$project_dir/packaging/windows/start.ps1" "$work_dir/package/windows/start.ps1"
cp "$project_dir/packaging/windows/install-startup.ps1" "$work_dir/package/windows/install-startup.ps1"
cp "$project_dir/packaging/windows/uninstall-startup.ps1" "$work_dir/package/windows/uninstall-startup.ps1"
cp "$project_dir/packaging/windows/stop.ps1" "$work_dir/package/windows/stop.ps1"
cp "$project_dir/packaging/windows/setup-gateway.cmd" "$work_dir/package/setup-gateway.cmd"
cp "$project_dir/packaging/windows/start-gateway.cmd" "$work_dir/package/start-gateway.cmd"
cp "$project_dir/packaging/windows/install-startup.cmd" "$work_dir/package/install-startup.cmd"
cp "$project_dir/packaging/windows/uninstall-startup.cmd" "$work_dir/package/uninstall-startup.cmd"
cp "$project_dir/packaging/windows/stop-gateway.cmd" "$work_dir/package/stop-gateway.cmd"

rm -f "$dist_dir/${archive_name}.zip"
(cd "$work_dir/package" && zip -q -r "$dist_dir/${archive_name}.zip" .)
printf '%s\n' "$dist_dir/${archive_name}.zip"
