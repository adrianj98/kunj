#!/bin/sh
# kunj preset: supabase — the Supabase CLI into /usr/local/bin. tools: { "supabase": "latest" } | "2.20.5"
# `supabase start` needs Docker, which the sandbox does not have; `gen types`, `db diff`, migrations
# against a remote project work. Allowlist mode needs github.com, api.github.com and objects.githubusercontent.com.
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-latest}"
kunj_check_words '[0-9a-z][0-9a-z.-]*'
if [ "$want" = latest ]; then
  want="$(curl -fsSL https://api.github.com/repos/supabase/cli/releases/latest | grep -o '"tag_name": *"v[0-9.]*"' | head -1 | sed 's/.*"v//; s/"//')"
  [ -n "$want" ] || { echo "supabase: could not resolve the latest release" >&2; exit 1; }
fi
want="${want#v}"
if command -v supabase >/dev/null 2>&1 && supabase --version 2>/dev/null | grep -q "^$want\$"; then kunj_done "$want"; exit 0; fi
arch="$(kunj_arch_deb)"; [ "$arch" = aarch64 ] && arch=arm64
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/supabase/cli/releases/download/v$want/supabase_linux_$arch.tar.gz" | tar -xz -C "$tmp" --no-same-owner
install -m 0755 "$tmp/supabase" "${KUNJ_PREFIX:-/usr/local}/bin/supabase"
rm -rf "$tmp"
kunj_done "$want"
