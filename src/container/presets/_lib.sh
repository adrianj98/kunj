# Shared helpers for kunj presets. Sourced, not executed. POSIX sh.
#
# Presets run as root inside the snapshot container, behind the firewall, with:
#   KUNJ_TOOL_NAME     the preset name
#   KUNJ_TOOL_VERSION  the value from blueprint.json ("" for true; arrays joined by spaces)
#   KUNJ_TOOL_USER     the sandbox user (commands run as them later)
#
# Everything a preset installs must live outside the user's home: /home/<user> is a volume and
# volumes are not part of `docker commit`. Use /usr/local or /opt, and persist environment through
# kunj_env, which the snapshot turns into image ENV and the login shell sources.

KUNJ_ENV_FILE=/etc/kunj/env

# Record KEY=VALUE for the image (ENV at commit time) and for login shells now.
kunj_env() {
  mkdir -p /etc/kunj /etc/profile.d
  # replace an existing key
  if [ -f "$KUNJ_ENV_FILE" ]; then grep -v "^${1%%=*}=" "$KUNJ_ENV_FILE" > "$KUNJ_ENV_FILE.tmp" || true; mv "$KUNJ_ENV_FILE.tmp" "$KUNJ_ENV_FILE"; fi
  echo "$1" >> "$KUNJ_ENV_FILE"
  printf 'export %s\n' "$(sed 's/^\([^=]*\)=\(.*\)$/\1="\2"/' "$KUNJ_ENV_FILE" | tr '\n' ' ')" > /etc/profile.d/kunj-tools.sh
}

# Architecture in the two spellings download sites use: "x64 amd64" or "arm64 aarch64".
kunj_arch() {
  case "$(uname -m)" in
    x86_64) echo "x64 amd64" ;;
    aarch64|arm64) echo "arm64 aarch64" ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}
kunj_arch_node() { kunj_arch | cut -d' ' -f1; }   # x64 | arm64
kunj_arch_deb()  { kunj_arch | cut -d' ' -f2; }   # amd64 | aarch64 (go/jdk/uv spellings differ; see each preset)

# Where the project tree is while presets run: the seed during a snapshot, else the workspace.
kunj_tree() {
  if [ -d /opt/kunj/seed ]; then echo /opt/kunj/seed; else echo /workspace; fi
}

kunj_need() { command -v "$1" >/dev/null 2>&1 || { echo "$KUNJ_TOOL_NAME: needs $1 in the image" >&2; exit 1; }; }

kunj_done() { echo "installed $KUNJ_TOOL_NAME $1"; }
