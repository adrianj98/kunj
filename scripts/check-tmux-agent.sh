#!/bin/bash
# Checks the tmux behaviour kunj agent relies on, with the argv agentArgv() builds.
# Run it in a throwaway container (needs only Docker; installs tmux inside):
#   docker run --rm -e TERM=xterm-256color -v "$PWD/scripts/check-tmux-agent.sh:/check.sh:ro" debian:trixie-slim timeout 120 bash /check.sh
set -u
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux bsdutils procps >/dev/null 2>&1
echo "tmux: $(tmux -V)"
export TMUX_TMPDIR=/tmp/tm; mkdir -p $TMUX_TMPDIR
cd /tmp
pass() { echo "PASS $1"; }; fail() { echo "FAIL $1 — $2"; }

# The exact kunj argv, run in a pseudo-terminal (script), then detached from outside.
kunj_agent() { # name branch command
  local name=$1 branch=$2 cmd=$3
  script -qec "tmux -u new-session -A -s $name -c /tmp -e KUNJ_BRANCH=$branch -e KUNJ_REPO=app -e KUNJ_WORKTREE=/wt/$branch '$cmd' ';' set-option -t $name window-size latest" /dev/null >/tmp/$name.out 2>&1 &
  echo $!
}
detach_all() { sleep 1.5; tmux detach-client -s "$1" 2>/dev/null; sleep 0.5; }

# 1. A server already running with another agent's values
tmux -u new-session -d -s first -c /tmp -e KUNJ_BRANCH=first 'sleep 600'

# 2. New session through the kunj argv: does it get its own -e values?
kunj_agent b1 feature-b 'printenv KUNJ_BRANCH KUNJ_WORKTREE > /tmp/b1.env; sleep 600' >/dev/null
detach_all b1
got=$(tr '\n' ' ' < /tmp/b1.env 2>/dev/null)
[ "$got" = "feature-b /wt/feature-b " ] && pass "-e on a running server gives the new session its own values ($got)" || fail "-e values" "got '$got'"

# Without -e (the old behaviour) the value comes from the server, i.e. not feature-c
script -qec "tmux -u new-session -A -s c1 -c /tmp 'printenv KUNJ_BRANCH > /tmp/c1.env; sleep 600'" /dev/null >/dev/null 2>&1 &
detach_all c1
echo "  (control, no -e: KUNJ_BRANCH='$(cat /tmp/c1.env 2>/dev/null)' — the bug the fix removed)"

# 3. window-size latest set on create
ws=$(tmux show-options -t b1 -v window-size 2>&1)
[ "$ws" = "latest" ] && pass "window-size latest set when the session is created" || fail "window-size on create" "got '$ws'"

# 4. Reattach (-A, session exists): does the trailing set-option still run?
tmux set-option -t b1 window-size smallest
kunj_agent b1 feature-b 'ignored on attach' >/dev/null
detach_all b1
ws=$(tmux show-options -t b1 -v window-size 2>&1)
[ "$ws" = "latest" ] && pass "-A reattach runs the trailing set-option (window-size latest again)" || fail "set-option on -A attach" "got '$ws'; client output: $(tr -d '\r' < /tmp/b1.out | head -3)"
n=$(tmux list-sessions -F '#{session_name}' | grep -c '^b1$')
[ "$n" = "1" ] && pass "-A reattach reuses the session (no duplicate)" || fail "duplicate session" "$n"

# 5. Two clients attached together: size follows the latest
script -qec "stty cols 200 rows 50; tmux attach -t b1" /dev/null >/dev/null 2>&1 & sleep 1
script -qec "stty cols 90 rows 30; tmux attach -t b1" /dev/null >/dev/null 2>&1 & sleep 1.5
sz=$(tmux display-message -p -t b1 '#{window_width}x#{window_height}')
echo "  two clients (200x50 then 90x30): window is $sz"
[ "${sz%x*}" = "90" ] && pass "window follows the latest client" || fail "latest client size" "$sz"
tmux detach-client -s b1 2>/dev/null; sleep 0.5

# 6. From inside a real pane: TMUX set -> refused; TMUX removed (what kunj does) -> works
tmux new-session -d -s outer -x 120 -y 30 'bash --norc'
sleep 0.5
tmux send-keys -t outer "tmux -u new-session -A -s n1 -c /tmp 'sleep 600' ';' set-option -t n1 window-size latest; echo EXIT=\$?" Enter
sleep 1.5
pane=$(tmux capture-pane -p -t outer | tr -s '\n')
echo "$pane" | grep -q "nested with care" && pass "inside a pane with TMUX set, tmux refuses: $(echo "$pane" | grep nested)" || fail "nesting refusal" "$pane"
tmux send-keys -t outer "env -u TMUX tmux -u new-session -A -s n2 -c /tmp -e KUNJ_BRANCH=n2 'sleep 600' ';' set-option -t n2 window-size latest" Enter
sleep 1.5
tmux has-session -t n2 2>/dev/null && pass "inside a pane with TMUX removed (kunj's env), the agent session starts" || fail "start with TMUX removed" "$(tmux capture-pane -p -t outer | tail -3)"

# 7. Session names kunj generates are accepted (dots and colons already replaced)
tmux new-session -d -s 'kunj-app-feature-v1-2-hotfix-a1b2c3' 'sleep 600' && pass "kunj-style session name accepted"

tmux kill-server
