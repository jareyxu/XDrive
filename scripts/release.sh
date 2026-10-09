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
for command_name in go pnpm python3 tar; do
  command -v "$command_name" >/dev/null || { printf 'Missing required tool: %s\n' "$command_name" >&2; exit 1; }
done
python3 scripts/check_release_format_gate.py \
  --version "$release_version" \
  --matrix "$project_root/docs/format-version-matrix.json"
if [[ -z $allow_dirty && -n $(git status --porcelain) ]]; then
  printf 'Refusing to release from a dirty or untracked worktree.\n' >&2
  exit 1
fi

make test
if [[ -n $allow_dirty ]]; then
  scripts/package-release.sh "$release_version" --allow-dirty
else
  scripts/package-release.sh "$release_version"
fi
