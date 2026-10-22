#!/bin/sh
# kunj preset: go — official tarball into /usr/local/go. tools: { "go": "1.22" } | "1.22.5"
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-}"
[ -n "$want" ] || { echo "go: give a version, e.g. \"1.22\"" >&2; exit 1; }
case "$want" in
  *.*.*) version="$want" ;;
  *)     version="$(curl -fsSL 'https://go.dev/dl/?mode=json' | grep -o "\"version\":\"go$want\.[0-9]*\"" | head -1 | sed 's/.*go//; s/"//')" ;;
esac
[ -n "$version" ] || { echo "go: no release matches '$want'" >&2; exit 1; }
arch="$(kunj_arch_deb)"; [ "$arch" = aarch64 ] && arch=arm64
rm -rf /usr/local/go
curl -fsSL "https://go.dev/dl/go$version.linux-$arch.tar.gz" | tar -xz -C /usr/local --no-same-owner
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
kunj_env GOTOOLCHAIN=local
kunj_done "$version"
