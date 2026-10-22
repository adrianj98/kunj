#!/bin/sh
# kunj preset: bun — official installer into /usr/local (not the home volume). tools: { "bun": true } | "1.2.5"
# Allowlist mode needs bun.sh and github.com, objects.githubusercontent.com in container.network.allow.
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl; kunj_need unzip; kunj_need bash
want="${KUNJ_TOOL_VERSION:-}"
want="${want#v}"
export BUN_INSTALL=/usr/local
if [ -n "$want" ]; then curl -fsSL https://bun.sh/install | bash -s -- "bun-v$want"; else curl -fsSL https://bun.sh/install | bash; fi
chmod a+rx /usr/local/bin/bun
kunj_done "$(/usr/local/bin/bun --version)"
