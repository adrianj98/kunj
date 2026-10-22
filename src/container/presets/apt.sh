#!/bin/sh
# kunj preset: apt — Debian/Ubuntu packages. tools: { "apt": ["jq", "postgresql-client"] }
# Allowlist mode needs the image's package mirror (deb.debian.org for Debian) in container.network.allow.
set -eu
. "$(dirname "$0")/_lib.sh"
[ -n "${KUNJ_TOOL_VERSION:-}" ] || { echo "apt: list the packages to install" >&2; exit 1; }
kunj_need apt-get
# Package names only: an option (-o...) or a path (.deb) would run code as root
kunj_check_words '[a-z0-9][a-z0-9+.:=~-]*'
set -f
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# shellcheck disable=SC2086
apt-get install -y -qq --no-install-recommends $KUNJ_TOOL_VERSION
rm -rf /var/lib/apt/lists/*
kunj_done "$KUNJ_TOOL_VERSION"
