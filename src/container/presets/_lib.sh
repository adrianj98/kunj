# Shared helpers for kunj presets. Sourced, not executed. POSIX sh.
#
# Presets run as root inside the snapshot container, behind the firewall, with:
#   KUNJ_TOOL_NAME     the preset name
#   KUNJ_TOOL_VERSION  the value from blueprint.json ("" for true; arrays joined by spaces)
#   KUNJ_TOOL_USER     the sandbox user (commands run as them later)
#
# Everything a preset installs must live outside the user's home: /home/<user> is a volume and
# volumes are not part of `docker commit`. Install under $KUNJ_PREFIX (/usr/local) or /opt, and
# persist environment through kunj_env, which the snapshot turns into image ENV and the login
# shell sources.
#
# A custom preset (.kunj/presets/<name>.sh or ~/.kunj/presets/<name>.sh) is run the same way and
# can source this file too. It must end with `kunj_done <version>`: that is how kunj learns what
# was installed.
#
# KUNJ_PREFIX, KUNJ_ENV_FILE and KUNJ_PROFILE_DIR can be overridden so the tests run presets
# unprivileged; kunj itself never sets them.

KUNJ_PREFIX="${KUNJ_PREFIX:-/usr/local}"
KUNJ_ENV_FILE="${KUNJ_ENV_FILE:-/etc/kunj/env}"
KUNJ_PROFILE_DIR="${KUNJ_PROFILE_DIR:-/etc/profile.d}"

# Record KEY=VALUE for the image (ENV at commit time) and for login shells now.
kunj_env() {
  mkdir -p "$(dirname "$KUNJ_ENV_FILE")" "$KUNJ_PROFILE_DIR"
  # replace an existing key
  if [ -f "$KUNJ_ENV_FILE" ]; then grep -v "^${1%%=*}=" "$KUNJ_ENV_FILE" > "$KUNJ_ENV_FILE.tmp" || true; mv "$KUNJ_ENV_FILE.tmp" "$KUNJ_ENV_FILE"; fi
  echo "$1" >> "$KUNJ_ENV_FILE"
  # Single-quoted, so a login shell never expands ", $ or ` in a value
  sed "s/'/'\\\\''/g; s/^\([^=]*\)=\(.*\)\$/export \1='\2'/" "$KUNJ_ENV_FILE" > "$KUNJ_PROFILE_DIR/kunj-tools.sh"
}

# Architecture as download sites spell it. Not a pipeline, so an unsupported machine fails the
# `x="$(kunj_arch_node)"` assignment under set -e instead of yielding "".
kunj_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo x86_64 ;;
    aarch64|arm64) echo aarch64 ;;
    *) echo "$KUNJ_TOOL_NAME: unsupported architecture $(uname -m)" >&2; return 1 ;;
  esac
}
kunj_arch_node() { _a="$(kunj_arch)" || return 1; [ "$_a" = x86_64 ] && echo x64 || echo arm64; }      # node, temurin (x64)
kunj_arch_deb()  { _a="$(kunj_arch)" || return 1; [ "$_a" = x86_64 ] && echo amd64 || echo arm64; }    # debian, go

# Where the project tree is while presets run: the seed during a snapshot, else the workspace.
kunj_tree() {
  if [ -d /opt/kunj/seed ]; then echo /opt/kunj/seed; else echo /workspace; fi
}

# Fail unless every word of KUNJ_TOOL_VERSION matches the grep BRE $1 (whole word). Blueprint
# parsing already rejects options and paths; this keeps a preset safe on its own.
kunj_check_words() {
  set -f
  for _w in ${KUNJ_TOOL_VERSION:-}; do
    printf '%s\n' "$_w" | grep -qx "$1" || { echo "$KUNJ_TOOL_NAME: invalid value '$_w'" >&2; exit 1; }
  done
  set +f
}

kunj_need() { command -v "$1" >/dev/null 2>&1 || { echo "$KUNJ_TOOL_NAME: needs $1 in the image" >&2; exit 1; }; }

# Like kunj_need, but installs Debian package $2 (default $1) with apt-get when the command is missing.
kunj_need_pkg() {
  command -v "$1" >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${2:-$1}" >/dev/null \
      && rm -rf /var/lib/apt/lists/*
  fi
  kunj_need "$1"
}

# Last step of every preset: kunj reads the version from $KUNJ_RESULT_DIR/<name>.result.
kunj_done() {
  _d="${KUNJ_RESULT_DIR:-/tmp/kunj-presets}"
  if [ -d "$_d" ]; then echo "$KUNJ_TOOL_NAME $1" > "$_d/$KUNJ_TOOL_NAME.result"; fi
  echo "installed $KUNJ_TOOL_NAME $1"
}
