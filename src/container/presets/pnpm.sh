#!/bin/sh
# kunj preset: pnpm — via corepack. tools: { "pnpm": "corepack" } (reads packageManager from package.json) | "4.6.0"
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need node; kunj_need corepack
want="${KUNJ_TOOL_VERSION:-corepack}"
if [ "$want" = corepack ]; then
  want="$(node -e 'const p=require(process.argv[1]+"/package.json");const m=(p.packageManager||"").match(/^pnpm@([^+]+)/);console.log(m?m[1]:"")' "$(kunj_tree)" 2>/dev/null || true)"
  [ -n "$want" ] || { echo "pnpm: package.json has no packageManager pnpm@<version>; give a version" >&2; exit 1; }
fi
export COREPACK_HOME=/usr/local/share/corepack
mkdir -p "$COREPACK_HOME"
corepack enable
corepack prepare "pnpm@$want" --activate
chmod -R a+rwX "$COREPACK_HOME"
kunj_env COREPACK_HOME=/usr/local/share/corepack
kunj_done "$want"
