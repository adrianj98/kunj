#!/bin/sh
# kunj preset: java — Eclipse Temurin JDK. tools: { "java": "21" }
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-21}"
arch="$(kunj_arch_node)"; [ "$arch" = arm64 ] && arch=aarch64
[ "$arch" = x64 ] && arch=x64
dest="/usr/local/jdk-$want"
if [ ! -x "$dest/bin/java" ]; then
  mkdir -p "$dest"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/$want/ga/linux/$arch/jdk/hotspot/normal/eclipse" | tar -xz -C "$dest" --strip-components=1 --no-same-owner
fi
ln -sf "$dest/bin/java" /usr/local/bin/java
ln -sf "$dest/bin/javac" /usr/local/bin/javac
kunj_env "JAVA_HOME=$dest"
kunj_done "$("$dest/bin/java" -version 2>&1 | head -1 | cut -d'"' -f2)"
