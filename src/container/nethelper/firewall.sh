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
SUBNET=${KUNJ_FW_SUBNET:-}

CHAIN=KUNJ-OUT
SET4=kunj-allow
SET6=kunj-allow6
DOCKER_DNS=127.0.0.11
PRIVATE4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16"
PRIVATE6="fc00::/7 fe80::/10"
ALWAYS_ALLOWED="api.anthropic.com registry.npmjs.org"
REFRESH_SECONDS=300

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

# The default gateway is the Docker host (host.docker.internal on a bridge network).
GW4=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
GW6=$(ip -f inet6 route 2>/dev/null | awk '/^default/ {print $3; exit}')

log "mode=$MODE subnet=$SUBNET${SUBNET6:+ subnet6=$SUBNET6} gateway=${GW4:-none}${GW6:+ gateway6=$GW6} allowHost=$ALLOW_HOST"

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

# Fill <set4>/<set6> with GitHub's ranges and the resolved allowed domains. Returns 1 when the
# GitHub ranges cannot be fetched, so a refresh keeps the previous sets instead of losing GitHub.
populate() { # <set4> <set6>
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
  for host in $DOMAINS $ORIGIN_HOST $ALWAYS_ALLOWED; do
    ips=$(resolve "$host")
    [ -n "$ips" ] || log "WARNING: $host did not resolve"
    for ip in $ips; do add_ip "$1" "$2" "$ip"; done
  done
  return 0
}

create_sets() { # <set4> <set6>
  ipset create -exist "$1" hash:net family inet
  ipset flush "$1"
  if [ "$V6" = 1 ]; then
    ipset create -exist "$2" hash:net family inet6
    ipset flush "$2"
  fi
}

members() { ipset list "$1" 2>/dev/null | sed '1,/^Members:/d' | sort; }

# --- Rules -----------------------------------------------------------------------------------

# kunj's rules live in their own chain, jumped to first from OUTPUT, so a restarted helper
# replaces them instead of stacking duplicates and Docker's own rules are left alone.
reset_chain() { # <iptables|ip6tables>
  "$1" -N "$CHAIN" 2>/dev/null || "$1" -F "$CHAIN"
  while "$1" -D OUTPUT -j "$CHAIN" 2>/dev/null; do :; done
  "$1" -I OUTPUT 1 -j "$CHAIN"
}

# Rules common to both families: loopback (where Docker's DNS proxy listens), replies to
# connections already accepted, and DNS only via Docker's embedded resolver, so DNS cannot be
# used to reach arbitrary resolvers.
base_rules() { # <iptables|ip6tables>
  "$1" -A "$CHAIN" -o lo -j ACCEPT
  "$1" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ "$1" = iptables ]; then
    "$1" -A "$CHAIN" -d "$DOCKER_DNS" -p udp --dport 53 -j ACCEPT
    "$1" -A "$CHAIN" -d "$DOCKER_DNS" -p tcp --dport 53 -j ACCEPT
  fi
  "$1" -A "$CHAIN" -p udp --dport 53 -j REJECT
  "$1" -A "$CHAIN" -p tcp --dport 53 -j REJECT
}

# The host and the LAN: blocked unless allowHost. The gateway is matched before the subnet,
# because it lies inside the subnet; the private ranges after it, so sidecars stay reachable.
host_rules() { # <iptables|ip6tables> <gateway> <subnet> <ranges>
  verdict=REJECT
  [ "$ALLOW_HOST" = 1 ] && verdict=ACCEPT
  [ -n "$2" ] && "$1" -A "$CHAIN" -d "$2" -j "$verdict"
  [ -n "$3" ] && "$1" -A "$CHAIN" -d "$3" -j ACCEPT
  for net in $4; do "$1" -A "$CHAIN" -d "$net" -j "$verdict"; done
}

# allowlist: only the sets get out; everything else is rejected (fast failure for the agent)
# and OUTPUT's policy is DROP as a backstop. default: everything not blocked above is allowed.
final_rules() { # <iptables|ip6tables> <set>
  if [ "$MODE" = allowlist ]; then
    "$1" -A "$CHAIN" -m set --match-set "$2" dst -j ACCEPT
    "$1" -A "$CHAIN" -j REJECT
    "$1" -P OUTPUT DROP
  else
    "$1" -P OUTPUT ACCEPT
  fi
}

if [ "$MODE" = allowlist ]; then
  # Resolve before any rule exists, while DNS and HTTPS are still open
  create_sets "$SET4" "$SET6"
  populate "$SET4" "$SET6" || die "could not build the allowlist"
  log "allowlist: $(members "$SET4" | grep -c .) IPv4 / $(members "$SET6" | grep -c .) IPv6 entries"
fi

reset_chain iptables
base_rules iptables
host_rules iptables "$GW4" "$SUBNET" "$PRIVATE4"
final_rules iptables "$SET4"

if [ "$V6" = 1 ]; then
  reset_chain ip6tables
  base_rules ip6tables
  # Neighbour discovery uses link-local addresses; without it IPv6 stops working entirely.
  for type in neighbour-solicitation neighbour-advertisement router-solicitation; do
    ip6tables -A "$CHAIN" -p ipv6-icmp --icmpv6-type "$type" -j ACCEPT
  done
  host_rules ip6tables "$GW6" "$SUBNET6" "$PRIVATE6"
  final_rules ip6tables "$SET6"
fi

# --- Verify ----------------------------------------------------------------------------------

# Prove the allowlist actually holds before the agent starts: an arbitrary site must be
# unreachable and origin reachable (HTTPS, or a bare TCP connect for SSH-only hosts).
if [ "$MODE" = allowlist ]; then
  if curl --max-time 5 -s -o /dev/null https://example.com; then
    die "verification failed: https://example.com is reachable, the allowlist is not in effect"
  fi
  log "verified: https://example.com is blocked"
  if [ -n "$ORIGIN_HOST" ]; then
    if curl --max-time 5 -sI -o /dev/null "https://$ORIGIN_HOST" \
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
    # Fill fresh sets and swap them in atomically, so there is never a window without them
    create_sets "$SET4-new" "$SET6-new"
    if populate "$SET4-new" "$SET6-new"; then
      before="$(members "$SET4")$(members "$SET6")"
      ipset swap "$SET4-new" "$SET4"
      [ "$V6" = 1 ] && ipset swap "$SET6-new" "$SET6"
      after="$(members "$SET4")$(members "$SET6")"
      if [ "$before" != "$after" ]; then
        log "allowlist changed: $(members "$SET4" | grep -c .) IPv4 / $(members "$SET6" | grep -c .) IPv6 entries"
      fi
    else
      log "WARNING: refresh failed, keeping the previous allowlist"
    fi
    ipset destroy "$SET4-new" 2>/dev/null || true
    ipset destroy "$SET6-new" 2>/dev/null || true
  done
else
  while :; do
    sleep 3600 &
    wait $!
  done
fi
