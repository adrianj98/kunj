#!/bin/sh
# kunj preset: node — official Node.js build into /usr/local.
# tools: { "node": "24" } | "22.12.0" | "lts" | "nvmrc" (reads .nvmrc / .node-version from the tree)
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-lts}"
tree="$(kunj_tree)"
if [ "$want" = nvmrc ]; then
  for f in "$tree/.nvmrc" "$tree/.node-version"; do
    [ -f "$f" ] && { want="$(tr -d 'v \n\r' < "$f")"; break; }
  done
  [ "$want" != nvmrc ] || { echo "node: no .nvmrc or .node-version in $tree" >&2; exit 1; }
fi
# One object per line so grep can pick the first (newest) match
index="$(curl -fsSL https://nodejs.org/dist/index.json | tr '}' '\n')"
case "$want" in
  lts)      version="$(printf '%s\n' "$index" | grep -v '"lts":false' | grep -o '"version":"v[0-9.]*"' | head -1)" ;;
  *.*.*)    version="\"version\":\"v$want\"" ;;
  *)        version="$(printf '%s\n' "$index" | grep -o "\"version\":\"v${want%%.*}\.[0-9]*\.[0-9]*\"" | head -1)" ;;
esac
version="${version#*:\"v}"; version="${version%\"}"
[ -n "$version" ] || { echo "node: no release matches '$want'" >&2; exit 1; }
if command -v node >/dev/null 2>&1 && [ "$(node -v)" = "v$version" ]; then kunj_done "$version"; exit 0; fi
arch="$(kunj_arch_node)"
curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-linux-$arch.tar.gz" | tar -xz -C /usr/local --strip-components=1 --no-same-owner
# corepack ships with node; a shared cache keeps prepared package managers in the image, not in the home volume
kunj_env COREPACK_HOME=/usr/local/share/corepack
mkdir -p /usr/local/share/corepack && chmod -R a+rwX /usr/local/share/corepack
kunj_done "$version"
