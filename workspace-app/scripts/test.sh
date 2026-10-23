#!/bin/bash
# Run the package's tests (swift test) under the Command Line Tools.
#
#   scripts/test.sh                       all tests, build dir .build
#   scripts/test.sh --filter KunjCLITests extra arguments go to `swift test`
#   SCRATCH=.build/me scripts/test.sh     own build dir (--scratch-path, relative to workspace-app/), so parallel
#                                         builds by other agents/shells never wait on yours
#
# SwiftTerm is fetched first (scripts/prepare-swiftterm.sh): SwiftPM resolves every
# dependency even when only the Core tests build. The default SDK is tried first; when the
# build itself fails (no test ran), the installed CLT SDKs are tried newest first, because
# some CLT SDKs lack plugins the toolchain needs (see macos-app/scripts/test.sh).
set -uo pipefail
cd "$(dirname "$0")/.."
./scripts/prepare-swiftterm.sh || exit 1

args=()
if [ -n "${SCRATCH:-}" ]; then args=(--scratch-path "$SCRATCH"); fi
args+=("$@")

run() { swift test ${args[@]+"${args[@]}"} 2>&1; }
ran() { grep -qE "Executed [0-9]+ test|Test run with [0-9]+ test|Test Suite '.*' (passed|failed)" <<<"$1"; }

# The SDK that worked last time is remembered per build dir, so later runs skip the failing default.
SDK_FILE="${SCRATCH:-.build}/.kunj-sdk"
# An SDKROOT set by the caller is used as is; a remembered one may still fall back.
USER_SDK="${SDKROOT:-}"
if [ -z "$USER_SDK" ] && [ -f "$SDK_FILE" ] && [ -d "$(cat "$SDK_FILE")" ]; then export SDKROOT="$(cat "$SDK_FILE")"; fi

out="$(run)"; status=$?
# A failed incremental compile can leave the explicit-module caches reporting "plugin for
# module 'TestingMacros' not found" even with an SDK that works; clear them and retry once.
if [ $status -ne 0 ] && ! ran "$out" && grep -q "plugin for module" <<<"$out"; then
  echo "Clearing the module caches after a macro plugin error and retrying" >&2
  rm -rf "${SCRATCH:-.build}/out"
  out="$(run)"; status=$?
fi
# "Executed" / "Test Suite" means the build worked and tests ran: report as is.
if [ $status -ne 0 ] && ! ran "$out" \
   && [ -z "$USER_SDK" ] && [ "$(xcode-select -p)" = "/Library/Developer/CommandLineTools" ]; then
  for sdk in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX[0-9]*.*.sdk 2>/dev/null | sort -rV); do
    [ "$sdk" = "${SDKROOT:-}" ] && continue
    tried="the default SDK"; [ -n "${SDKROOT:-}" ] && tried="$(basename "$SDKROOT")"
    echo "Build failed with $tried; trying $(basename "$sdk")" >&2
    # After a failed compile the explicit-module caches can keep reporting
    # "plugin for module 'TestingMacros' not found"; clearing them fixes that.
    if grep -q "plugin for module" <<<"$out"; then rm -rf "${SCRATCH:-.build}/out"; fi
    out="$(SDKROOT="$sdk" run)"; status=$?
    if [ $status -eq 0 ] || ran "$out"; then mkdir -p "$(dirname "$SDK_FILE")"; echo "$sdk" > "$SDK_FILE"; break; fi
  done
fi
printf '%s\n' "$out"
exit $status
