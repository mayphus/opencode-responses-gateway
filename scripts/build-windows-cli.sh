#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p "require('$project_dir/package.json').version")
node_version=${NODE_VERSION:-$(node -p 'process.versions.node')}
archive_name="opencode-gateway-${version}-windows-x64"
dist_dir="$project_dir/dist"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT INT TERM

node_zip="node-v${node_version}-win-x64.zip"
node_url="https://nodejs.org/dist/v${node_version}/${node_zip}"

mkdir -p "$work_dir/package" "$dist_dir"
"$project_dir/node_modules/.bin/esbuild" "$project_dir/src/cli.ts" \
  --bundle --platform=node --format=cjs --target=node24 \
  --outfile="$work_dir/cli.cjs"

printf '%s\n' \
  '{' \
  "  \"main\": \"$work_dir/cli.cjs\"," \
  "  \"output\": \"$work_dir/sea.blob\"," \
  '  "disableExperimentalSEAWarning": true,' \
  '  "useSnapshot": false,' \
  '  "useCodeCache": false' \
  '}' > "$work_dir/sea-config.json"
node --experimental-sea-config "$work_dir/sea-config.json"

curl --fail --location --silent --show-error "$node_url" --output "$work_dir/$node_zip"
unzip -q "$work_dir/$node_zip" -d "$work_dir/node"
cp "$work_dir/node/node-v${node_version}-win-x64/node.exe" "$work_dir/package/opencode-gateway.exe"
cp "$work_dir/node/node-v${node_version}-win-x64/LICENSE" "$work_dir/package/NODE-LICENSE.txt"
cp "$project_dir/packaging/windows/README-WINGET.txt" "$work_dir/package/README.txt"

"$project_dir/node_modules/.bin/postject" \
  "$work_dir/package/opencode-gateway.exe" NODE_SEA_BLOB "$work_dir/sea.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

rm -f "$dist_dir/${archive_name}.zip"
(cd "$work_dir/package" && zip -q -r "$dist_dir/${archive_name}.zip" .)
shasum -a 256 "$dist_dir/${archive_name}.zip" > "$dist_dir/${archive_name}.zip.sha256"
printf '%s\n' "$dist_dir/${archive_name}.zip"

