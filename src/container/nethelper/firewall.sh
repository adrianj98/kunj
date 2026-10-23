#!/bin/sh
# Firewall for a kunj branch container. Runs as root in the kunj-nethelper container, which shares
# the agent container's network namespace (--network container:<id>) and has NET_ADMIN/NET_RAW;
# the agent's container has neither, so it cannot undo these rules.
#
# Environment:
#   KUNJ_FW_MODE         default | allowlist
#   KUNJ_FW_ALLOW_HOST   1 keeps the Docker host, private ranges and link-local reachable
#   KUNJ_FW_DOMAINS      space-separated extra domains for the allowlist
#   KUNJ_FW_GITHUB       1 allows GitHub's published ranges (api.github.com/meta)
#   KUNJ_FW_ORIGIN_HOST  host of the repository's origin; allowed, and must be reachable
#   KUNJ_FW_ORIGIN_PORT  port origin's URL connects to (git://, https on :8443, ssh on :2222); optional.
#                        With it, origin's addresses are reachable on that port even when they are
#                        private or the Docker host (a self-hosted origin), in both modes
#   KUNJ_FW_SUBNET       the branch network's subnet; detected from eth0 when empty
#
# Prints READY and creates /tmp/kunj-ready once the rules are in place, then keeps running
# (re-resolving the allowlist every 5 minutes, since CDN addresses rotate).
set -eu

MODE=${KUNJ_FW_MODE:-default}
ALLOW_HOST=${KUNJ_FW_ALLOW_HOST:-0}
DOMAINS=${KUNJ_FW_DOMAINS:-}
GITHUB=${KUNJ_FW_GITHUB:-0}
ORIGIN_HOST=${KUNJ_FW_ORIGIN_HOST:-}
ORIGIN_PORT=${KUNJ_FW_ORIGIN_PORT:-}
SUBNET=${KUNJ_FW_SUBNET:-}

CHAIN=KUNJ-OUT
SET4=kunj-allow
SET6=kunj-allow6
DOCKER_DNS=127.0.0.11
# Private, carrier-grade NAT (Tailscale and similar), link-local and "this network" ranges
PRIVATE4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16"
PRIVATE6="fc00::/7 fe80::/10"
ALWAYS_ALLOWED="api.anthropic.com registry.npmjs.org nodejs.org" # nodejs.org: the node preset
REFRESH_SECONDS=${KUNJ_FW_REFRESH_SECONDS:-300} # overridable for testing

log() { echo "kunj-firewall: $*"; }
die() { echo "kunj-firewall: ERROR: $*" >&2; exit 1; }

case "$MODE" in
  default | allowlist) ;;
  *) die "KUNJ_FW_MODE must be 'default' or 'allowlist' (got '$MODE')" ;;
esac

# Exit promptly on docker stop: as PID 1 the shell would otherwise ignore SIGTERM.
trap 'exit 0' TERM INT

# --- What this namespace looks like ----------------------------------------------------------

iptables -L OUTPUT -n >/dev/null 2>&1 || die "iptables is not usable; the helper needs --cap-add NET_ADMIN --cap-add NET_RAW"

# Some kernels (or Docker setups) have no IPv6 filtering; without IPv6 there is nothing to filter,
# so carry on with IPv4 only rather than refusing to start.
V6=1
if ! ip6tables -L OUTPUT -n >/dev/null 2>&1; then
  log "WARNING: ip6tables is not usable here (no IPv6 support?); applying IPv4 rules only"
  V6=0
fi

# The branch network's subnet stays reachable so sidecar services work. iptables masks an
# address/prefix like 172.18.0.2/16 to its network, so eth0's address with its prefix is enough.
if [ -z "$SUBNET" ]; then
  SUBNET=$(ip -o -f inet addr show dev eth0 2>/dev/null | awk '{print $4; exit}')
  [ -n "$SUBNET" ] || die "could not detect the container's subnet on eth0; set KUNJ_FW_SUBNET"
fi
SUBNET6=$(ip -o -f inet6 addr show dev eth0 2>/dev/null | awk '$4 !~ /^fe80/ {print $4; exit}')

# The default gateway is the Docker host on a Linux bridge network.
GW4=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
GW6=$(ip -f inet6 route 2>/dev/null | awk '/^default/ {print $3; exit}')

# Without ip6tables, IPv6 traffic would bypass every rule below. That is only acceptable when the
# namespace has no IPv6 route out; otherwise refuse to start rather than leave a hole.
if [ "$V6" = 0 ] && { [ -n "$SUBNET6" ] || [ -n "$GW6" ]; }; then
  die "IPv6 is configured on eth0 but ip6tables is not usable, so IPv6 traffic cannot be filtered"
fi

# --- Allowlist sets --------------------------------------------------------------------------

# Add an address or CIDR to the v4 or v6 set; anything that does not look like one is skipped,
# so a malformed DNS or API answer cannot inject ipset arguments.
add_ip() { # <set4> <set6> <address>
  case "$3" in
    '' | *[!0-9a-fA-F:./]*) log "WARNING: ignoring invalid address '$3'"; return 0 ;;
    *:*) if [ "$V6" = 1 ]; then ipset add -exist "$2" "$3" || log "WARNING: could not add $3"; fi ;;
    *) ipset add -exist "$1" "$3" || log "WARNING: could not add $3" ;;
  esac
}

# A and AAAA records through Docker's resolver, addresses only (dig +short also prints CNAMEs).
resolve() { # <host>
  case "$1" in
    *[!0-9.]* | '') ;;
    *) echo "$1"; return 0 ;; # already an IPv4 address
  esac
  case "$1" in
    *:*) echo "$1"; return 0 ;; # already an IPv6 address
  esac
  {
    dig +short +time=3 +tries=2 A "$1" 2>/dev/null || true
    if [ "$V6" = 1 ]; then dig +short +time=3 +tries=2 AAAA "$1" 2>/dev/null || true; fi
  } | grep -E '^([0-9]+\.){3}[0-9]+$|^[0-9a-fA-F]*:[0-9a-fA-F:]+$' || true
}

# The Docker host is not always the gateway: Docker Desktop's host.docker.internal is
# 192.168.65.254 while the gateway is 172.x.0.1, and other engines use other addresses. Block
# whatever these names resolve to (through DNS or this namespace's /etc/hosts); absence is fine.
HOST_ADDRS=$(for name in host.docker.internal gateway.docker.internal; do
  getent hosts "$name" 2>/dev/null | awk '{print $1}' || true
  resolve "$name"
done | sort -u)
HOST4=$(echo "$HOST_ADDRS" | grep -v ':' || true)
HOST6=$(echo "$HOST_ADDRS" | grep ':' || true)

# Origin is the one channel in and out, so it stays reachable on its own port even on a private
# address or the Docker host; every other port there is still blocked by host_rules.
ORIGIN_ADDRS=""
if [ -n "$ORIGIN_HOST" ] && [ -n "$ORIGIN_PORT" ]; then
  ORIGIN_ADDRS=$({
    getent hosts "$ORIGIN_HOST" 2>/dev/null | awk '{print $1}' || true
    resolve "$ORIGIN_HOST"
  } | grep -E '^([0-9]+\.){3}[0-9]+$|^[0-9a-fA-F]*:[0-9a-fA-F:]+$' | sort -u || true)
fi
ORIGIN4=$(echo "$ORIGIN_ADDRS" | grep -v ':' || true)
ORIGIN6=$(echo "$ORIGIN_ADDRS" | grep ':' || true)

log "mode=$MODE subnet=$SUBNET${SUBNET6:+ subnet6=$SUBNET6} gateway=${GW4:-none}${GW6:+ gateway6=$GW6} host=$(echo $HOST_ADDRS) allowHost=$ALLOW_HOST origin=$(echo $ORIGIN_ADDRS)${ORIGIN_PORT:+:$ORIGIN_PORT}"

# Fill <set4>/<set6> with GitHub's ranges and the resolved allowed domains. Returns 1 when the
# GitHub ranges cannot be fetched, so a refresh keeps the previous sets instead of losing GitHub.
# With <strict>=1 (at start) origin and the always-allowed hosts must resolve too; extra domains
# from the setting only warn.
populate() { # <set4> <set6> <strict>
  if [ "$GITHUB" = 1 ]; then
    meta=$(curl -fsS --max-time 15 https://api.github.com/meta) || { log "WARNING: could not fetch https://api.github.com/meta"; return 1; }
    # No jq in the image: flatten the JSON and cut out each flat string array by key
    flat=$(printf '%s' "$meta" | tr -d ' \t\r\n')
    count=0
    for key in web api git; do
      for cidr in $(printf '%s' "$flat" | sed -n "s/.*\"$key\":\[\([^]]*\)\].*/\1/p" | tr ',' ' ' | tr -d '"'); do
        add_ip "$1" "$2" "$cidr"
        count=$((count + 1))
      done
    done
    [ "$count" -gt 0 ] || { log "WARNING: api.github.com/meta had no web/api/git ranges"; return 1; }
  fi
  for host in $DOMAINS; do
    ips=$(resolve "$host")
    [ -n "$ips" ] || log "WARNING: $host did not resolve"
    for ip in $ips; do add_ip "$1" "$2" "$ip"; done
  done
  for host in $ORIGIN_HOST $ALWAYS_ALLOWED; do
    ips=$(resolve "$host")
    if [ -z "$ips" ]; then
      log "WARNING: $host did not resolve"
      [ "$3" = 1 ] && return 1
    fi
    for ip in $ips; do add_ip "$1" "$2" "$ip"; done
  done
  return 0
}

# Create <set> if missing; never flushes, because it may be the live set a restart inherits.
ensure_set() { # <set> <inet|inet6>
  ipset create -exist "$1" hash:net family "$2"
}

# Copy every member of <from> into <to>, so a refresh only adds: a host that times out or a CDN
# answering with a different subset keeps its last-known addresses.
union_into() { # <from> <to>
  ipset save "$1" 2>/dev/null | awk -v to="$2" '$1 == "add" { print "add", to, $3 }' | ipset restore -exist
}

members() { ipset list "$1" 2>/dev/null | sed '1,/^Members:/d' | sort; }

# Build fresh *-new sets and swap them in atomically, so the live sets are never flushed or empty
# (a restarted helper under policy DROP still reaches api.github.com through the old ones).
# <union>=1 keeps the live members as well. Returns 1, leaving the live sets alone, on failure.
rebuild_sets() { # <strict> <union>
  ensure_set "$SET4" inet
  ensure_set "$SET4-new" inet
  ipset flush "$SET4-new"
  if [ "$V6" = 1 ]; then
    ensure_set "$SET6" inet6
    ensure_set "$SET6-new" inet6
    ipset flush "$SET6-new"
  fi
  if populate "$SET4-new" "$SET6-new" "$1"; then
    if [ "$2" = 1 ]; then
      union_into "$SET4" "$SET4-new"
      if [ "$V6" = 1 ]; then union_into "$SET6" "$SET6-new"; fi
    fi
    status=0
    ipset swap "$SET4-new" "$SET4" || status=1
    if [ "$V6" = 1 ]; then ipset swap "$SET6-new" "$SET6" || status=1; fi
  else
    status=1
  fi
  ipset destroy "$SET4-new" 2>/dev/null || true
  ipset destroy "$SET6-new" 2>/dev/null || true
  return "$status"
}

# --- Rules -----------------------------------------------------------------------------------

# kunj's rules live in their own chain, jumped to first from OUTPUT, so a restarted helper
# replaces them instead of stacking duplicates and Docker's own rules are left alone. A new helper
# on a running container must never leave a gap, so the rules are built in $BUILD while the live
# chain stays in force, then swapped in: jump to the new chain first, drop the old one, rename.
BUILD="$CHAIN-NEW"

# Leftovers of a helper that died part way through a swap
recover_chain() { # <iptables|ip6tables>
  "$1" -L "$BUILD" -n >/dev/null 2>&1 || return 0
  if "$1" -L "$CHAIN" -n >/dev/null 2>&1; then
    # The old chain is only removed once the new one is jumped to: drop the half-built one
    while "$1" -D OUTPUT -j "$BUILD" 2>/dev/null; do :; done
    "$1" -F "$BUILD"
    "$1" -X "$BUILD"
  else
    # The swap had removed the old chain already: this one is the live one
    "$1" -E "$BUILD" "$CHAIN"
  fi
}

start_chain() { # <iptables|ip6tables>
  recover_chain "$1"
  "$1" -N "$BUILD"
}

swap_chain() { # <iptables|ip6tables>
  "$1" -I OUTPUT 1 -j "$BUILD"
  while "$1" -D OUTPUT -j "$CHAIN" 2>/dev/null; do :; done
  if "$1" -L "$CHAIN" -n >/dev/null 2>&1; then
    "$1" -F "$CHAIN"
    "$1" -X "$CHAIN"
  fi
  "$1" -E "$BUILD" "$CHAIN"
}

# Rules common to both families: loopback (where Docker's DNS proxy listens), replies to
# connections already accepted, and DNS only via Docker's embedded resolver, so DNS cannot be
# used to reach arbitrary resolvers.
base_rules() { # <iptables|ip6tables>
  "$1" -A "$BUILD" -o lo -j ACCEPT
  "$1" -A "$BUILD" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ "$1" = iptables ]; then
    "$1" -A "$BUILD" -d "$DOCKER_DNS" -p udp --dport 53 -j ACCEPT
    "$1" -A "$BUILD" -d "$DOCKER_DNS" -p tcp --dport 53 -j ACCEPT
  fi
  "$1" -A "$BUILD" -p udp --dport 53 -j REJECT
  "$1" -A "$BUILD" -p tcp --dport 53 -j REJECT
}

# Origin's addresses on origin's port, ahead of the host and private-range rejects.
origin_rules() { # <iptables|ip6tables> <addresses>
  for addr in $2; do "$1" -A "$BUILD" -d "$addr" -p tcp --dport "$ORIGIN_PORT" -j ACCEPT; done
}

# The host and the LAN: blocked unless allowHost (then explicitly accepted, which allowlist mode
# needs). The gateway and host addresses are matched before the subnet, because the gateway lies
# inside it; the private ranges after it, so sidecars stay reachable.
host_rules() { # <iptables|ip6tables> <gateway and host addresses> <subnet> <ranges>
  verdict=REJECT
  if [ "$ALLOW_HOST" = 1 ]; then verdict=ACCEPT; fi
  for addr in $2; do "$1" -A "$BUILD" -d "$addr" -j "$verdict"; done
  if [ -n "$3" ]; then "$1" -A "$BUILD" -d "$3" -j ACCEPT; fi
  for net in $4; do "$1" -A "$BUILD" -d "$net" -j "$verdict"; done
}

# allowlist: only the sets get out; everything else is rejected (fast failure for the agent)
# and OUTPUT's policy is DROP as a backstop. default: everything not blocked above is allowed.
final_rules() { # <iptables|ip6tables> <set>
  if [ "$MODE" = allowlist ]; then
    "$1" -A "$BUILD" -m set --match-set "$2" dst -j ACCEPT
    "$1" -A "$BUILD" -j REJECT
  fi
}

# After the swap: OUTPUT's policy is DROP as a backstop in allowlist mode
set_policy() { # <iptables|ip6tables>
  if [ "$MODE" = allowlist ]; then "$1" -P OUTPUT DROP; else "$1" -P OUTPUT ACCEPT; fi
}

if [ "$MODE" = allowlist ]; then
  # Fill the sets before the rules are (re)applied. On a first start nothing is blocked yet; on a
  # restart the previous live sets still let the GitHub fetch and the lookups through.
  rebuild_sets 1 0 || die "could not build the allowlist (GitHub ranges, origin or a required host did not resolve)"
  log "allowlist: $(members "$SET4" | grep -c .) IPv4 / $(members "$SET6" | grep -c .) IPv6 entries"
fi

start_chain iptables
base_rules iptables
origin_rules iptables "$ORIGIN4"
host_rules iptables "$GW4 $HOST4" "$SUBNET" "$PRIVATE4"
final_rules iptables "$SET4"
swap_chain iptables
set_policy iptables

if [ "$V6" = 1 ]; then
  start_chain ip6tables
  base_rules ip6tables
  # Neighbour discovery uses link-local addresses; without it IPv6 stops working entirely.
  for type in neighbour-solicitation neighbour-advertisement router-solicitation; do
    ip6tables -A "$BUILD" -p ipv6-icmp --icmpv6-type "$type" -j ACCEPT
  done
  origin_rules ip6tables "$ORIGIN6"
  host_rules ip6tables "$GW6 $HOST6" "$SUBNET6" "$PRIVATE6"
  final_rules ip6tables "$SET6"
  swap_chain ip6tables
  set_policy ip6tables
fi

# --- Verify ----------------------------------------------------------------------------------

# Prove the allowlist actually holds before the agent starts: an arbitrary site must be
# unreachable and origin reachable (HTTPS, or a bare TCP connect for SSH-only hosts).
if [ "$MODE" = allowlist ]; then
  # Only a refused/rejected (7), timed-out (28) or broken TLS (35) connection counts as blocked;
  # a DNS failure (6) or anything else proves nothing about the rules.
  rc=0
  curl --max-time 5 -s -o /dev/null https://example.com || rc=$?
  case "$rc" in
    7 | 28 | 35) log "verified: https://example.com is blocked (curl exit $rc)" ;;
    0) die "verification failed: https://example.com is reachable, the allowlist is not in effect" ;;
    *) die "verification failed: could not test https://example.com (curl exit $rc)" ;;
  esac
  if [ -n "$ORIGIN_HOST" ]; then
    # origin's own port first: an origin served elsewhere (git daemon, a custom https or ssh
    # port) has nothing listening on 443 or 22
    if { [ -n "$ORIGIN_PORT" ] && nc -z -w 5 "$ORIGIN_HOST" "$ORIGIN_PORT" 2>/dev/null; } \
      || curl --max-time 5 -sI -o /dev/null "https://$ORIGIN_HOST" \
      || nc -z -w 5 "$ORIGIN_HOST" 443 2>/dev/null \
      || nc -z -w 5 "$ORIGIN_HOST" 22 2>/dev/null; then
      log "verified: $ORIGIN_HOST is reachable"
    else
      die "verification failed: origin host $ORIGIN_HOST is not reachable through the allowlist"
    fi
  fi
fi

touch /tmp/kunj-ready
echo READY

# --- Stay up ---------------------------------------------------------------------------------

# `sleep & wait` so the TERM trap fires immediately rather than after the sleep ends.
if [ "$MODE" = allowlist ]; then
  while :; do
    sleep "$REFRESH_SECONDS" &
    wait $!
    before="$(members "$SET4")$(members "$SET6")"
    if rebuild_sets 0 1; then
      after="$(members "$SET4")$(members "$SET6")"
      if [ "$before" != "$after" ]; then
        log "allowlist changed: $(members "$SET4" | grep -c .) IPv4 / $(members "$SET6" | grep -c .) IPv6 entries"
      fi
    else
      log "WARNING: refresh failed, keeping the previous allowlist"
    fi
  done
else
  while :; do
    sleep 3600 &
    wait $!
  done
fi
