#!/bin/sh
# kunj preset: go — official tarball into /usr/local/go. tools: { "go": "1.22" } | "1.22.5"
# Allowlist mode needs go.dev and dl.google.com (its downloads redirect there) in container.network.allow.
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-}"
want="${want#go}"
[ -n "$want" ] || { echo "go: give a version, e.g. \"1.22\"" >&2; exit 1; }
case "$want" in
  *.*.*) version="$want" ;;
  # include=all: the default list only has the two newest minors. Newest first; rc/beta never match.
  *) index="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all')"
     version="$(printf '%s\n' "$index" | grep -o "\"version\": *\"go$(echo "$want" | sed 's/\./\\./g')\(\.[0-9]*\)\{0,1\}\"" | head -1 | sed 's/.*"go//; s/"$//')" ;;
esac
[ -n "$version" ] || { echo "go: no release matches '$want'" >&2; exit 1; }
arch="$(kunj_arch_deb)"
if [ ! -x $KUNJ_PREFIX/go/bin/go ] || [ "$($KUNJ_PREFIX/go/bin/go env GOVERSION)" != "go$version" ]; then
  rm -rf $KUNJ_PREFIX/go
  curl -fsSL "https://go.dev/dl/go$version.linux-$arch.tar.gz" | tar -xz -C $KUNJ_PREFIX --no-same-owner
fi
ln -sf $KUNJ_PREFIX/go/bin/go $KUNJ_PREFIX/bin/go
ln -sf $KUNJ_PREFIX/go/bin/gofmt $KUNJ_PREFIX/bin/gofmt
kunj_env GOTOOLCHAIN=local
kunj_done "$version"
