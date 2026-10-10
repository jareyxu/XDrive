#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s vMAJOR.MINOR.PATCH [--allow-dirty] [--files-dir DIRECTORY] [--bridge-dir DIRECTORY]\n' "$0" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
release_version=$1
shift
[[ $release_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || usage
allow_dirty=''
files_dir=''
bridge_dir=''
while (($#)); do
  case "$1" in
    --allow-dirty) allow_dirty=--allow-dirty; shift ;;
    --files-dir|--bridge-dir)
      (($# >= 2)) || usage
      if [[ $1 == --files-dir ]]; then files_dir=$2; else bridge_dir=$2; fi
      shift 2 ;;
    *) usage ;;
  esac
done
[[ -z $files_dir || -d $files_dir ]] || usage
[[ -z $bridge_dir || -d $bridge_dir ]] || usage
if [[ -n $files_dir ]]; then
  [[ ! -L $files_dir ]] || usage
  files_dir=$(cd "$files_dir" && pwd -P)
fi
if [[ -n $bridge_dir ]]; then
  [[ ! -L $bridge_dir ]] || usage
  bridge_dir=$(cd "$bridge_dir" && pwd -P)
fi

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$project_root"
if [[ -z $files_dir && ( -e "$project_root/release/files" || -L "$project_root/release/files" ) ]]; then
  [[ -d "$project_root/release/files" && ! -L "$project_root/release/files" ]] || {
    printf 'Release resources must be a real directory.\n' >&2; exit 1;
  }
  files_dir=$(cd "$project_root/release/files" && pwd -P)
  [[ $files_dir == "$project_root/release/files" ]] || { printf 'Release resource parents must not be symlinked.\n' >&2; exit 1; }
fi
for command_name in go python3 tar curl; do
  command -v "$command_name" >/dev/null || { printf 'Missing required tool: %s\n' "$command_name" >&2; exit 1; }
done
python3 scripts/check_release_format_gate.py \
  --version "$release_version" \
  --matrix "$project_root/docs/format-version-matrix.json"
if [[ -z $allow_dirty && -n $(git status --porcelain) ]]; then
  printf 'Refusing to package from a dirty or untracked worktree.\n' >&2
  exit 1
fi

if command -v sha256sum >/dev/null; then
  hash_file() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null; then
  hash_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else
  printf 'sha256sum or shasum is required.\n' >&2
  exit 1
fi

commit=$(git rev-parse --verify --short=12 HEAD 2>/dev/null || printf 'uncommitted')
if [[ -n $allow_dirty ]]; then commit="${commit}-dirty"; fi
release_root="$project_root/dist/release"
mkdir -p "$release_root"
release_dir="$release_root/$release_version"
if [[ -n $allow_dirty ]]; then release_dir="$release_root/${release_version}-dirty"; fi
if [[ -z $allow_dirty && -e $release_dir ]]; then
  printf 'Release directory already exists: %s\n' "$release_dir" >&2
  exit 1
fi
output_stage=$(mktemp -d "$release_root/.release-staging-XXXXXXXX")
trap 'rm -rf "$output_stage"' EXIT
checksum_file="$output_stage/SHA256SUMS"
: > "$checksum_file"
# Old v1.3.4/v1.3.6 workers always request the original artifact name. Starting
# after the bridge release, that name carries the immutable bridge; current
# workers select the complete -package archive from the same checksum manifest.
bridge_version=v1.3.7
use_frozen_bridge=false
if [[ $release_version != *-* ]] && python3 - "$release_version" "$bridge_version" <<'VERSION_PY'
import sys
parts=lambda value: tuple(map(int,value[1:].split('.')))
sys.exit(0 if parts(sys.argv[1]) > parts(sys.argv[2]) else 1)
VERSION_PY
then use_frozen_bridge=true; fi
if [[ $use_frozen_bridge == true && -z $bridge_dir ]]; then
  bridge_dir="$output_stage/bridge"
  mkdir "$bridge_dir"
  curl --fail --location --proto '=https' --tlsv1.2 --max-filesize 1048576 \
    --output "$bridge_dir/SHA256SUMS" "https://github.com/jareyxu/XDrive/releases/download/$bridge_version/SHA256SUMS"
  for architecture in amd64 arm64; do
    name="xdrive-${bridge_version}-linux-${architecture}.tar.gz"
    curl --fail --location --proto '=https' --tlsv1.2 --max-filesize 134217728 \
      --output "$bridge_dir/$name" "https://github.com/jareyxu/XDrive/releases/download/$bridge_version/$name"
  done
fi
for architecture in amd64 arm64; do
  stage=$(mktemp -d)
  trap 'rm -rf "$stage" "$output_stage"' EXIT
  CGO_ENABLED=0 GOOS=linux GOARCH="$architecture" go build -trimpath \
    -ldflags="-s -w -X main.version=$release_version -X main.buildCommit=$commit" \
    -o "$stage/xdrive" ./cmd/xdrive
  cp scripts/install.sh "$stage/install.sh"
  cp scripts/upgrade.sh "$stage/upgrade.sh"
  cp scripts/uninstall.sh "$stage/uninstall.sh"
  cp THIRD_PARTY_NOTICES.txt LGPL-3.0-heic-to.txt LICENSE "$stage/"
  cat > "$stage/RELEASE.txt" <<RELEASE_EOF
version=$release_version
commit=$commit
os=linux
architecture=$architecture
RELEASE_EOF
  {
    printf '\n\n'
    cat LICENSE
    printf '\n\n'
    sed 's/The full LGPL-3.0 license text is included in LGPL-3.0-heic-to.txt./The full LGPL-3.0 license text follows in this RELEASE.txt file./' THIRD_PARTY_NOTICES.txt
    printf '\n\nFull LGPL-3.0 license text for bundled heic-to 1.6.5:\n\n'
    cat LGPL-3.0-heic-to.txt
  } >> "$stage/RELEASE.txt"
  chmod 0755 "$stage/xdrive" "$stage/install.sh" "$stage/upgrade.sh" "$stage/uninstall.sh"
  artifact="xdrive-${release_version}-linux-${architecture}-package.tar.gz"
  builder_args=(--stage "$stage" --output "$output_stage/$artifact")
  if [[ -n $files_dir ]]; then builder_args+=(--files-dir "$files_dir"); fi
  python3 scripts/build_release_archive.py "${builder_args[@]}"
  printf '%s  %s\n' "$(hash_file "$output_stage/$artifact")" "$artifact" >> "$checksum_file"

  legacy_artifact="xdrive-${release_version}-linux-${architecture}.tar.gz"
  if [[ $use_frozen_bridge == true ]]; then
    bridge_name="xdrive-${bridge_version}-linux-${architecture}.tar.gz"
    bridge_digest=$(awk -v name="$bridge_name" '$2 == name { count++; digest=$1 } END { if (count != 1 || length(digest) != 64) exit 1; print digest }' "$bridge_dir/SHA256SUMS")
    [[ $(hash_file "$bridge_dir/$bridge_name") == "$bridge_digest" ]] || { printf 'Legacy bridge checksum mismatch.\n' >&2; exit 1; }
    python3 scripts/build_release_archive.py --verify-bridge "$bridge_dir/$bridge_name" --version "$bridge_version" --architecture "$architecture"
    cp "$bridge_dir/$bridge_name" "$output_stage/$legacy_artifact"
  else
    python3 scripts/build_release_archive.py --stage "$stage" --output "$output_stage/$legacy_artifact" --legacy
  fi
  # The fixed layout is exclusively the compatibility envelope. Complete
  # release packages are declared by their variable-length manifests.
  [[ $(tar -tzf "$output_stage/$legacy_artifact" | LC_ALL=C sort) == $'RELEASE.txt\ninstall.sh\nuninstall.sh\nupgrade.sh\nxdrive' ]] || {
    printf 'Legacy bridge layout is invalid.\n' >&2; exit 1;
  }
  printf '%s  %s\n' "$(hash_file "$output_stage/$legacy_artifact")" "$legacy_artifact" >> "$checksum_file"
  rm -rf "$stage"
  trap 'rm -rf "$output_stage"' EXIT
done
if [[ $bridge_dir == "$output_stage/bridge" ]]; then rm -rf "$bridge_dir"; fi
if [[ -n $allow_dirty && -e $release_dir ]]; then rm -rf "$release_dir"; fi
mv "$output_stage" "$release_dir"
trap - EXIT
printf 'Release artifacts and SHA-256 checksums: %s\n' "$release_dir"
