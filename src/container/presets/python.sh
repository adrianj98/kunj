#!/bin/sh
# kunj preset: python — a CPython via uv, plus uv itself. tools: { "python": "3.12" }
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need curl
want="${KUNJ_TOOL_VERSION:-3.12}"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi
export UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python
mkdir -p "$UV_PYTHON_INSTALL_DIR"
uv python install "$want"
py="$(uv python find "$want")"
ln -sf "$py" /usr/local/bin/python3
ln -sf "$py" /usr/local/bin/python
chmod -R a+rX /usr/local/share/uv
kunj_env UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python
kunj_done "$("$py" --version | cut -d' ' -f2)"
