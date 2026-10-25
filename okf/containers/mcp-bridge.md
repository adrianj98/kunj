---
type: Container
title: Host MCP Bridge
description: Bridges a host stdio MCP server (v1 only a Chrome DevTools browser) into a branch container over a Unix socket, behind a deny-by-default request filter.
resource: src/lib/container/mcpbridge.ts
tags: [container, mcp, browser, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

The agent in a branch container cannot reach the host, but it is useful for it to check the dev server
it started in a real browser. The bridge runs an MCP server on the host and lets the container's Claude
Code talk to it. The host connects in: it keeps one `docker exec -i -u <user> … socat
UNIX-LISTEN:/run/kunj-mcp/<name>.sock,unlink-early,mode=600 STDIO` open, and the container's Claude
Code entry runs `socat - UNIX-CONNECT:<sock>`. When a client sends its first message that passes the
filter, the host starts the stdio server and pipes the two together line by line.

The server runs outside the sandbox and on the Mac's network, so the filter is deny by default. The
feature is off while `container.mcp` is empty, and it is read from host config only, never a blueprint.

# Configuration

`container.mcp` is `{ name: { command?, args?, env?, allowOrigins? } }`. `mcpServers()` accepts only
`chrome` (`BROWSER_SERVER`); other names warn and are skipped. `{"chrome": {}}` (or `true`) is the
default browser:

| Field | Default |
| --- | --- |
| command / args | `npx -y chrome-devtools-mcp@1.12.0 --categoryPerformance=false --categoryMemory=false --fileNavigations=false --no-usage-statistics` (`CHROME_DEVTOOLS_MCP`) |
| env | `CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY=1` |
| profile | `throwawayProfile`: per session `--userDataDir` and `TMPDIR` in a `kunj-mcp-*` temp dir whose prefs block downloads (`download_restrictions: 3`); deleted at session end and on process exit |
| allowOrigins | unset: only the host ports forwarded for the container |

Custom `args` drop the pin, hardening flags and throwaway profile (warned). The server's env is only
`PATH`, `HOME` and `cfg.env` (`serverEnv()`), never the forwarded container env.

# Request filter (container to host)

`makeRequestFilter()` per line:

| Rule | Detail |
| --- | --- |
| methods | `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `resources/list`, `resources/templates/list`, `logging/setLevel`, `notifications/*` (not `roots/list_changed`), and responses |
| tools | only keys of `BROWSER_TOOL_ARGS` (pages, input, snapshot/screenshot, console, network, emulation); each with its own argument list plus `pageId` |
| paths | `isPathKey()` at any depth (`path`, `file`, `dir`, `*Path`, `*File`, `*Dir`, ...); deeper than 32 levels counts as one |
| navigation | `navigate_page`/`new_page` `url` must pass `originPolicy()`: `allowOrigins` (scheme+host, port if given) or `http(s)://localhost|127.0.0.1:<forwarded host port>` |
| ids | string up to 256 chars or safe integer; a duplicate id in flight is refused |
| batches | one `BATCH_REFUSAL` error, id null |
| malformed | dropped (logged once) |

Refusals are JSON-RPC errors (code -32602) quoting container text clipped to 100 characters. Navigation
limits cover explicit navigation only: a click or script can still move the page.

# Host to container

Every reply whose result has a tool list is filtered by shape (`filterToolsList()`, schemas cut to
allowed, non-path arguments). The `initialize` reply's `instructions` gets `portHint()` (the
forwarded-port map, and that localhost is the host). The server's `roots/list` is answered empty by
the bridge; `roots` is stripped from the client's `initialize` capabilities, and container replies to
requests the server never issued or the bridge answered are dropped.

# Bounds

| Constant | Value | On overflow |
| --- | --- | --- |
| `MAX_LINE_BYTES` | 4 MB from the container | session ends |
| `MAX_SERVER_LINE_BYTES` | 16 MB from the server | session ends |
| `MAX_BUFFERED_TO_CONTAINER` | 8 MB waiting for the container | session ends |
| `MAX_REPLY_BYTES` | 1 MB for a bridge refusal | session ends |

Reading from the container pauses while either side does not drain. A thrown error ends the session,
never the process.

# Container side and lifecycle

`runBridge()` is bound to one container run (`containerRun()` `startedAt`; two failed checks end it).
As root it runs only `PREPARE`: `mkdir`/`chown`/`chmod 700` of `/run/kunj-mcp` (refusing a symlink;
exit 3 when socat is missing). The listener, its pid file and `stopCommand()` run as the user, and the
stop kills the pid only if its `/proc/<pid>/cmdline` is that socat. One session at a time per server
(socat without `fork`); a listener ending without a client retries with backoff up to 30 s.

`installMcpConfig()` merges `mcpServers.<name>` into the container user's `~/.claude.json`
(`mergeClaudeConfig()`, atomic, umask 077); `startContainer` does it after READY and seed, and
`kunj ct agent` again. `kunj ct agent` then spawns a detached `kunj ct mcp <branch>` unless
`bridgeFor()` finds one; `kunj ct mcp` is the foreground form (stops on SIGINT, SIGTERM, SIGHUP).
Bridges are recorded in `~/.kunj/container-bridges.json` (`BridgeRecord { pid, container, name }`, the
`pidRegistry` shared with [forwarding](/containers/forwarding.md)), log to
`~/.kunj/logs/<container>-mcp.log`, and appear in `ct list --json` as `bridges: [{ name, pid }]`.

To bump the pin: `npm pack` the new version, re-read its tools and schema keys, update
`BROWSER_TOOL_ARGS`, never add a tool or argument that takes a host path.

# Related Concepts

* [Forwarding](/containers/forwarding.md) - forwarded ports are the default allowed origins
* [Container agents](/containers/container-agents.md) - `kunj ct agent` starts the bridge
* [Lifecycle](/containers/lifecycle.md) - helper replacement stops bridges
* [Overview](/containers/overview.md) - security model

# Citations

[1] [src/lib/container/mcpbridge.ts](/src/lib/container/mcpbridge.ts)
[2] [src/lib/container/pidregistry.ts](/src/lib/container/pidregistry.ts)
[3] [src/commands/container.ts](/src/commands/container.ts)
[4] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[5] [src/settings/container.ts](/src/settings/container.ts)
[6] [docs/specs/container-phase-2.md](/docs/specs/container-phase-2.md)
[7] [CLAUDE.md](/CLAUDE.md)
