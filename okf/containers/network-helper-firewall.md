---
type: Container
title: Network Helper and Firewall
description: A sidecar container sharing the branch container's network namespace holds NET_ADMIN, applies firewall.sh's egress rules and signals READY; the agent's container cannot change them.
resource: src/container/nethelper/firewall.sh
tags: [container, firewall, iptables, network, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Each branch container has a network helper, `<container>-net-helper`, run from the `kunj-nethelper` image
with `--network container:<main id>` and `NET_ADMIN`/`NET_RAW`. It shares the main container's network
namespace, so the iptables rules it installs apply to everything the agent does, while the main container
has those capabilities dropped and cannot undo them. Once the rules are in place the helper touches
`/tmp/kunj-ready` and prints `READY`; kunj execs nothing in main before that
(see [Lifecycle](/containers/lifecycle.md)).

The helper also hosts kunj's own tunnels: port forwards and the auto-forward poll exec `socat` in it rather
than in the main container (see [Forwarding](/containers/forwarding.md)).

# The image

`src/container/nethelper/Dockerfile`: `alpine:3.20` with `iptables ip6tables ipset bind-tools curl socat`,
`/firewall.sh` as ENTRYPOINT. Tag `kunj-nethelper:<version>-<hash>` (see [Images](/containers/images.md)).
`helperSpec()` in lifecycle.ts gives it labels `kunj.role=helper` and `kunj.version`, workdir `/`, no
volumes, no ports, `init: false`.

# Environment

Built by `firewallEnv()` in `src/lib/container/env.ts` and recorded in `kunj.options.helperEnv`:

| Variable | Source |
| --- | --- |
| `KUNJ_FW_MODE` | `allowlist` when `container.network.allow` is non-empty, else `default` (`firewallMode()`) |
| `KUNJ_FW_ALLOW_HOST` | `container.network.allowHost` |
| `KUNJ_FW_DOMAINS` | `container.network.allow`, plus `bedrock-runtime.<region>.amazonaws.com` with Bedrock, plus DinD registries in allowlist mode |
| `KUNJ_FW_GITHUB` | `1` when origin's host is `github.com` or a subdomain |
| `KUNJ_FW_ORIGIN_HOST` / `KUNJ_FW_ORIGIN_PORT` | Origin's host and port (`originPort()`: URL port or scheme default) |
| `KUNJ_FW_SUBNET` | Passed empty; detected from `eth0` |

`KUNJ_FW_REFRESH_SECONDS` (default 300) is a test override read by the script.

# Rules

All rules live in chain `KUNJ-OUT`, jumped to first from OUTPUT, for IPv4 and (when `ip6tables` works)
IPv6. Order:

| Rule | Effect |
| --- | --- |
| loopback, `ESTABLISHED,RELATED` | Accept |
| DNS | Only to Docker's resolver `127.0.0.11`; other port 53 rejected |
| Origin | Origin's addresses on `KUNJ_FW_ORIGIN_PORT` accepted, even private or the Docker host |
| Host | Gateway and `host.docker.internal` / `gateway.docker.internal` addresses rejected (accepted with allowHost) |
| Subnet | The branch network accepted (services stay reachable) |
| Private ranges | `0.0.0.0/8 10/8 100.64/10 172.16/12 192.168/16 169.254/16`, `fc00::/7 fe80::/10` rejected (accepted with allowHost) |
| Allowlist only | Destinations in ipsets `kunj-allow` / `kunj-allow6` accepted, everything else rejected; OUTPUT policy DROP |

The allowlist sets hold GitHub's `web`/`api`/`git` ranges from `api.github.com/meta` (when
`KUNJ_FW_GITHUB=1`), the resolved `KUNJ_FW_DOMAINS`, origin, and `ALWAYS_ALLOWED`
(`api.anthropic.com registry.npmjs.org nodejs.org`). Default mode leaves the open internet reachable and
only blocks the host and private ranges. IPv6 configured on eth0 without usable ip6tables is a fatal error.

# KUNJ-OUT-NEW: no gap on reload

A new helper on a running container must never leave it unfiltered. The rules are built in `KUNJ-OUT-NEW`
while the live chain stays in force, then `swap_chain()` inserts the jump to the new chain at position 1,
removes the old jumps, flushes and deletes `KUNJ-OUT` and renames the new chain. `recover_chain()` repairs
the leftovers of a helper killed mid-swap. The ipsets are likewise rebuilt as `*-new` and swapped in with
`ipset swap`, never flushed live.

# Verification and refresh

In allowlist mode, before READY the script proves the rules hold: `curl https://example.com` must fail with
exit 7, 28 or 35, and origin must answer on its port, 443 (curl or `nc`) or 22. Afterwards it re-resolves
the allowlist every `REFRESH_SECONDS`, only adding addresses (union with the live set) and keeping the old
sets when a refresh fails. `trap 'exit 0' TERM INT` makes `docker stop` prompt.

`kunj ct start` replaces a running helper whose image is not the current `kunj-nethelper` tag; `kunj ct
list` shows `[firewall helper down]` for a running main without a running helper.

# Related Concepts

* [Container Lifecycle](/containers/lifecycle.md) - READY gating, `bringUp()`
* [Images](/containers/images.md)
* [Forwarding](/containers/forwarding.md) - tunnels through the helper
* [Docker-in-Docker](/containers/docker-in-docker.md) - the one capability exception
* [Branch Containers](/containers/overview.md)

# Citations

[1] [src/container/nethelper/firewall.sh](/src/container/nethelper/firewall.sh)
[2] [src/container/nethelper/Dockerfile](/src/container/nethelper/Dockerfile)
[3] [src/lib/container/env.ts](/src/lib/container/env.ts)
[4] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[5] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
