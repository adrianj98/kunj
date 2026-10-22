#!/bin/sh
# kunj preset: java — Eclipse Temurin JDK. tools: { "java": "21" }
# Allowlist mode needs api.adoptium.net and github.com, objects.githubusercontent.com in container.network.allow.
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-21}"
KUNJ_TOOL_VERSION="$want" kunj_check_words '[0-9][0-9]*'
arch="$(kunj_arch)"; [ "$arch" = x86_64 ] && arch=x64   # Adoptium spells them x64 / aarch64
dest="$KUNJ_PREFIX/jdk-$want"
if [ ! -x "$dest/bin/java" ]; then
  mkdir -p "$dest"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/$want/ga/linux/$arch/jdk/hotspot/normal/eclipse" | tar -xz -C "$dest" --strip-components=1 --no-same-owner
fi
ln -sf "$dest/bin/java" $KUNJ_PREFIX/bin/java
ln -sf "$dest/bin/javac" $KUNJ_PREFIX/bin/javac
kunj_env "JAVA_HOME=$dest"
kunj_done "$("$dest/bin/java" -version 2>&1 | head -1 | cut -d'"' -f2)"
