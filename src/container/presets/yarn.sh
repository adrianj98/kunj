#!/bin/sh
# kunj preset: yarn — via corepack. tools: { "yarn": "corepack" } (reads packageManager from package.json) | "4.6.0"
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need node; kunj_need corepack
want="${KUNJ_TOOL_VERSION:-corepack}"
if [ "$want" = corepack ]; then
  want="$(node -e 'const p=require(process.argv[1]+"/package.json");const m=(p.packageManager||"").match(/^yarn@([^+]+)/);console.log(m?m[1]:"")' "$(kunj_tree)" 2>/dev/null || true)"
  [ -n "$want" ] || { echo "yarn: package.json has no packageManager yarn@<version>; give a version" >&2; exit 1; }
fi
export COREPACK_HOME=$KUNJ_PREFIX/share/corepack
mkdir -p "$COREPACK_HOME"
corepack enable
corepack prepare "yarn@$want" --activate
chmod -R a+rwX "$COREPACK_HOME"
kunj_env COREPACK_HOME=$KUNJ_PREFIX/share/corepack
kunj_done "$want"
