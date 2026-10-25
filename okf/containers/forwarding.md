---
type: Container
title: Port Forwarding
description: Host 127.0.0.1 listeners tunnelled into a branch container or service through docker exec, manual or automatic, tracked in a pid registry.
resource: src/lib/container/forward.ts
tags: [container, ports, forwarding, socat]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Branch containers publish no ports by default. `kunj ct forward` opens a listener on the host's
`127.0.0.1` and, for each connection, runs `docker exec -i … socat` that copies the connection to
`127.0.0.1:<port>` inside. Branch-container ports are tunnelled through the
[network helper](/containers/network-helper-firewall.md), which shares the container's network
namespace and is kunj's own code, so nothing is exec'd in the main container (which may not be READY
after a quick restart). A [service](/containers/services.md)'s port is tunnelled through its own container.

Three modules: `forward.ts` (the listener and tunnel), `autoforward.ts` (`--auto` polling, the forward
registry, detached spawning and logs) and `pidregistry.ts` (the generic registry of records owned by
background processes, shared with the [MCP bridge](/containers/mcp-bridge.md)).

# Commands

| Command | Behaviour |
| --- | --- |
| `kunj ct forward [branch] <port>` | host port = container port; next free OS port if taken |
| `kunj ct forward [branch] <hostPort>:<port>` | explicit host port (`parseForwardSpec()`) |
| `kunj ct forward [branch] <service>:<port>` | into a sidecar service; needs socat, bash or nc in its image (`TUNNEL_PROBE`) |
| `kunj ct forward [branch] --auto` | foreground: forwards every new listener, prints `+`/`-` lines (NDJSON `{ event, port, hostPort }` with `--json`) |
| `kunj ct forward [branch] --auto --detach` | background forwarder; one per container (`alreadyRunning: true` if one exists) |

Manual forwards print `localhost:<host> → [service]:<port>` (or `{ forwards: [...] }` with `--json`)
and run until Ctrl-C. `kunj ct agent` starts a detached `--auto` forwarder unless
`container.forward.auto` is `false`, the backend has no `features.localPorts`, or `forwarderFor()`
finds one already registered (see [container agents](/containers/container-agents.md)).

# The tunnel

`forwardPort()` creates a `net.Server` with `allowHalfOpen` and runs `tunnelCommand()` per connection:

| Tool | Command |
| --- | --- |
| socat | `socat -t 10 - TCP:127.0.0.1:<port>` (always in the network helper) |
| nc | `nc 127.0.0.1 <port>` |
| bash | `exec 3<>/dev/tcp/127.0.0.1/<port>; cat <&3 & cat >&3` (cannot half-close) |

A helper image without socat gives `HELPER_NO_SOCAT` (restart the container to replace the helper).
`listenLocal()` with `nextFree` tries up to 100 ports above the preferred one, else an OS-assigned port.

# Automatic forwarding

`runAutoForward()` polls `cat /proc/net/tcp /proc/net/tcp6` in the helper every 2 s (`POLL_MS`), not
`ss`, which most images lack. `parseProcNetTcp()` keeps `LISTEN` sockets on `0.0.0.0`, `::` or `127.*`
(excluding Docker DNS `127.0.0.11`); `::1`-only listeners are skipped because the tunnel connects to
`127.0.0.1`. `diffPorts()` never forwards ports below 1024 or in the ignore list, which is
`container.forward.ignore` plus ports already published with `start -p` (`autoForwardIgnore()`).
A port that fails to forward is not retried until its listener goes away.

The forwarder is bound to one run of the main container and of the helper (`containerRun()`'s
`startedAt`): every 5 s (`STATE_POLL_MS`) it checks both and exits when either stopped or restarted;
a failed inspect gets one second chance. All forwards close on exit.

# Registry

`~/.kunj/container-forwards.json` (`forwardsFile()`), a `pidRegistry`: a JSON array, dead pids pruned
on read, written to a temp file and renamed.

| `ForwardRecord` field | Meaning |
| --- | --- |
| `pid` | the owning kunj process |
| `container` / `containerId` | branch container name and id (`recordIsFor()` prefers the id) |
| `port` / `hostPort` | container and host port; `port: 0` marks a running `--auto` forwarder |
| `kind` | always `'forward'` |
| `service` | set for `<service>:<port>` forwards |

`startForwarder()` registers the port-0 record immediately after `spawnDetached()`, so a second
`agent` sees it. Each change rewrites all of the forwarder's own records from memory. `kunj ct list
--json` shows forwards as `ports` entries with `kind: 'forward'`, `pid` and optional `service`.
Before `kunj ct start` replaces an out-of-date helper, `stopHelperUsers()` in
[lifecycle](/containers/lifecycle.md) SIGTERMs registered forwarders and bridges (only pids whose `ps`
command line is `kunj ct|container forward|mcp`). [Prune](/containers/prune.md) drops records of
containers that no longer exist.

Detached forwarders log to `~/.kunj/logs/<container>-forward.log` (`detachedLogFile()`, `openLog()`:
dir 0700, file 0600, `O_NOFOLLOW`, truncated past 1 MB).

# Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `container.forward.auto` | `true` | `kunj ct agent` starts a background `forward --auto` |
| `container.forward.ignore` | `[]` | container ports `--auto` never forwards |
| `container.publish` | `[]` | ports always published at start (ignored by `--auto`) |

# Related Concepts

* [Network helper and firewall](/containers/network-helper-firewall.md) - where tunnels exec
* [Services](/containers/services.md) - `<service>:<port>`
* [MCP bridge](/containers/mcp-bridge.md) - shares `pidRegistry`, uses forwarded ports as allowed origins
* [Container agents](/containers/container-agents.md) - spawns the auto forwarder
* [Env and status](/containers/env-and-status.md) - `ct list --json`

# Citations

[1] [src/lib/container/forward.ts](/src/lib/container/forward.ts)
[2] [src/lib/container/autoforward.ts](/src/lib/container/autoforward.ts)
[3] [src/lib/container/pidregistry.ts](/src/lib/container/pidregistry.ts)
[4] [src/commands/container.ts](/src/commands/container.ts)
[5] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[6] [src/settings/container.ts](/src/settings/container.ts)
[7] [docs/specs/container-phase-2.md](/docs/specs/container-phase-2.md)
