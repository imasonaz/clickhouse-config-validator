#!/bin/sh
# Package the committed tree as clickhouse-config-check-v<version>.zip, the version taken from package.json.
# Usage: tools/zip.sh [output dir]   (default: the current directory)
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes; commit first so the zip matches v$version." >&2
  exit 1
fi
out="${1:-.}/clickhouse-config-check-v$version.zip"
git archive --format=zip --prefix=clickhouse-config-check/ -o "$out" HEAD
echo "$out"
