#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s vMAJOR.MINOR.PATCH [--allow-dirty]\n' "$0" >&2
  exit 2
}

[[ $# -ge 1 && $# -le 2 ]] || usage
release_version=$1
[[ $release_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || usage
allow_dirty=${2:-}
[[ -z $allow_dirty || $allow_dirty == --allow-dirty ]] || usage

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$project_root"
for command_name in go python3 tar; do
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
for architecture in amd64 arm64; do
  stage=$(mktemp -d)
  trap 'rm -rf "$stage" "$output_stage"' EXIT
  CGO_ENABLED=0 GOOS=linux GOARCH="$architecture" go build -trimpath \
    -ldflags="-s -w -X main.version=$release_version -X main.buildCommit=$commit" \
    -o "$stage/xdrive" ./cmd/xdrive
  cp scripts/install.sh "$stage/install.sh"
  cp scripts/upgrade.sh "$stage/upgrade.sh"
  cp scripts/uninstall.sh "$stage/uninstall.sh"
  cp THIRD_PARTY_NOTICES.txt "$stage/THIRD_PARTY_NOTICES.txt"
  cp LGPL-3.0-heic-to.txt "$stage/LGPL-3.0-heic-to.txt"
  cat > "$stage/RELEASE.txt" <<RELEASE_EOF
version=$release_version
commit=$commit
os=linux
architecture=$architecture
RELEASE_EOF
  chmod 0755 "$stage/xdrive" "$stage/install.sh" "$stage/upgrade.sh" "$stage/uninstall.sh"
  artifact="xdrive-${release_version}-linux-${architecture}.tar.gz"
  COPYFILE_DISABLE=1 tar -C "$stage" -czf "$output_stage/$artifact" xdrive install.sh upgrade.sh uninstall.sh RELEASE.txt THIRD_PARTY_NOTICES.txt LGPL-3.0-heic-to.txt
  archive_members=$(tar -tzf "$output_stage/$artifact" | LC_ALL=C sort)
  [[ $archive_members == $'LGPL-3.0-heic-to.txt\nRELEASE.txt\nTHIRD_PARTY_NOTICES.txt\ninstall.sh\nuninstall.sh\nupgrade.sh\nxdrive' ]] || {
    printf 'Release archive contains unexpected paths; refusing to publish it.\n' >&2
    exit 1
  }
  printf '%s  %s\n' "$(hash_file "$output_stage/$artifact")" "$artifact" >> "$checksum_file"
  rm -rf "$stage"
  trap 'rm -rf "$output_stage"' EXIT
done
if [[ -n $allow_dirty && -e $release_dir ]]; then rm -rf "$release_dir"; fi
mv "$output_stage" "$release_dir"
trap - EXIT
printf 'Release artifacts and SHA-256 checksums: %s\n' "$release_dir"
