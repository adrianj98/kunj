#!/bin/sh
# kunj preset: node — official Node.js build into /usr/local.
# tools: { "node": "24" } | "22.12" | "22.12.0" | "lts" | "nvmrc" (reads .nvmrc / .node-version from the tree)
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-lts}"
tree="$(kunj_tree)"
if [ "$want" = nvmrc ]; then
  for f in "$tree/.nvmrc" "$tree/.node-version"; do
    [ -f "$f" ] && { want="$(head -1 "$f" | tr -d ' \r')"; break; }
  done
  [ "$want" != nvmrc ] || { echo "node: no .nvmrc or .node-version in $tree" >&2; exit 1; }
fi
want="${want#v}"
case "$want" in lts/*) want=lts ;; node|latest|current) want=current ;; esac   # nvm aliases
# One object per line, newest first, so grep can pick the first match
index="$(curl -fsSL https://nodejs.org/dist/index.json | tr '}' '\n')"
case "$want" in
  lts)     version="$(printf '%s\n' "$index" | grep -v '"lts":false' | grep -o '"version":"v[0-9.]*"' | head -1)" ;;
  current) version="$(printf '%s\n' "$index" | grep -o '"version":"v[0-9.]*"' | head -1)" ;;
  *.*.*)   version="\"version\":\"v$want\"" ;;
  *)       version="$(printf '%s\n' "$index" | grep -o "\"version\":\"v$(echo "$want" | sed 's/\./\\./g')\.[0-9.]*\"" | head -1)" ;;
esac
version="${version#*:\"v}"; version="${version%\"}"
[ -n "$version" ] || { echo "node: no release matches '$want'" >&2; exit 1; }
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "v$version" ]; then
  arch="$(kunj_arch_node)"
  dir="node-v$version-linux-$arch"
  curl -fsSL "https://nodejs.org/dist/v$version/$dir.tar.gz" | tar -xz -C /usr/local --strip-components=1 --no-same-owner "$dir/bin" "$dir/include" "$dir/lib" "$dir/share"
fi
# corepack ships with node (up to 24); a shared home keeps prepared package managers in the image, not the home volume
kunj_env COREPACK_HOME=/usr/local/share/corepack
mkdir -p /usr/local/share/corepack && chmod -R a+rwX /usr/local/share/corepack
kunj_done "$version"
