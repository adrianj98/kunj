#!/bin/sh
# kunj preset: playwright — browsers + OS deps, shared system-wide. tools: { "playwright": "chromium" } | true (all)
# Uses the project's @playwright/test version when the tree declares one, so browsers match.
# Allowlist mode needs playwright.download.prss.microsoft.com, cdn.playwright.dev and the apt mirror in container.network.allow.
set -eu
. "$(dirname "$0")/_lib.sh"
kunj_need node; kunj_need npx
browsers="${KUNJ_TOOL_VERSION:-}"
tree="$(kunj_tree)"
pw="$(node -e 'const p=require(process.argv[1]+"/package.json");const d={...(p.dependencies||{}),...(p.devDependencies||{})};console.log((d["@playwright/test"]||d["playwright"]||"").replace(/^[^0-9]*/,""))' "$tree" 2>/dev/null || true)"
export PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
# shellcheck disable=SC2086
npx --yes "playwright@${pw:-latest}" install --with-deps $browsers
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
kunj_env PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright
kunj_done "${pw:-latest} ${browsers:-all}"
