#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(cd "$project_dir" && node -p "require('./package.json').version")
platform=$(node -p 'process.platform')
architecture=$(node -p 'process.arch')

case "$platform" in
  linux) target_os=linux; executable_name=opencode-gateway ;;
  darwin) target_os=macos; executable_name=opencode-gateway ;;
  win32) target_os=windows; executable_name=opencode-gateway.exe ;;
  *) printf 'Unsupported build platform: %s\n' "$platform" >&2; exit 1 ;;
esac

case "$architecture" in
  x64|arm64) ;;
  *) printf 'Unsupported build architecture: %s\n' "$architecture" >&2; exit 1 ;;
esac

archive_name="opencode-gateway-${version}-${target_os}-${architecture}"
dist_dir="$project_dir/dist"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT INT TERM
package_dir="$work_dir/$archive_name"
executable="$package_dir/$executable_name"

mkdir -p "$package_dir" "$dist_dir"
"$project_dir/node_modules/.bin/esbuild" "$project_dir/src/cli.ts" \
  --bundle --platform=node --format=cjs --target=node24 \
  --outfile="$work_dir/cli.cjs"

node -e "const fs=require('fs'),path=require('path'); const [config,main,output]=process.argv.slice(1); fs.writeFileSync(config,JSON.stringify({main:path.resolve(main),output:path.resolve(output),disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false},null,2))" \
  "$work_dir/sea-config.json" "$work_dir/cli.cjs" "$work_dir/sea.blob"
(cd "$project_dir" && node --experimental-sea-config "$work_dir/sea-config.json")

node -e "const fs=require('fs'),p=require('path'); const [target,licenseTarget]=process.argv.slice(1); const license=p.join(p.dirname(process.execPath),process.platform==='win32'?'':'..','LICENSE'); if(!fs.existsSync(license)) throw new Error('Node LICENSE not found: '+license); fs.copyFileSync(process.execPath,target); fs.copyFileSync(license,licenseTarget)" \
  "$executable" "$package_dir/NODE-LICENSE.txt"
cp "$project_dir/packaging/README-CLI.txt" "$package_dir/README.txt"

if [ "$platform" = darwin ]; then
  codesign --remove-signature "$executable" 2>/dev/null || true
  "$project_dir/node_modules/.bin/postject" \
    "$executable" NODE_SEA_BLOB "$work_dir/sea.blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  codesign --sign - "$executable"
else
  "$project_dir/node_modules/.bin/postject" \
    "$executable" NODE_SEA_BLOB "$work_dir/sea.blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi

chmod 755 "$executable"
node "$project_dir/scripts/smoke-cli.mjs" "$executable" "$version"

if [ "$platform" = win32 ]; then
  archive="$dist_dir/${archive_name}.zip"
  rm -f "$archive"
  archive_windows=$(cygpath -w "$archive")
  (cd "$package_dir" && 7z a -bd -tzip "$archive_windows" ./* >/dev/null)
else
  archive="$dist_dir/${archive_name}.tar.gz"
  rm -f "$archive"
  tar -C "$work_dir" -czf "$archive" "$archive_name"
fi

node -e "const fs=require('fs'),c=require('crypto'),p=process.argv[1],h=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); process.stdout.write(h+'  '+require('path').basename(p)+'\\n')" "$archive" > "$archive.sha256"
printf '%s\n' "$archive"
