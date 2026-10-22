#!/bin/sh
# kunj preset: rust — rustup toolchain shared system-wide. tools: { "rust": "stable" } | "1.80"
# Allowlist mode needs sh.rustup.rs and static.rust-lang.org in container.network.allow.
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-stable}"
KUNJ_TOOL_VERSION="$want" kunj_check_words '[0-9a-z][0-9a-z.-]*'
export RUSTUP_HOME=$KUNJ_PREFIX/rustup CARGO_HOME=$KUNJ_PREFIX/cargo
curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain "$want" --profile minimal
for b in cargo rustc rustup rustfmt cargo-clippy; do
  if [ -e "$CARGO_HOME/bin/$b" ]; then ln -sf "$CARGO_HOME/bin/$b" "$KUNJ_PREFIX/bin/$b"; fi
done
chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"
kunj_env RUSTUP_HOME=$KUNJ_PREFIX/rustup
kunj_env CARGO_HOME=$KUNJ_PREFIX/cargo
kunj_done "$("$CARGO_HOME/bin/rustc" --version | cut -d' ' -f2)"
