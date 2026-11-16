---
type: Container
title: Remotes
description: The kunj serve machines a laptop knows, kept in ~/.kunj/remotes.json, how each is reached (an SSH tunnel or a URL) and the rule on plain http.
resource: src/lib/remotes.ts
tags: [container, remote, serve, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`kunj remote` (src/commands/remote.ts) records the machines running `kunj serve` in `~/.kunj/remotes.json`
(0600, written atomically). `container.remote` or `--remote <name>` sends a repository's containers there
through `RemoteKunjBackend`; see [Container Backend](/containers/backend.md). Spec:
docs/specs/remote-containers.md.

# Entries

| Field | Meaning |
|---|---|
| `ssh`, `port` | Reached through `ssh -N -L` to the box's loopback (default port 7433) |
| `url` | Reached directly; trailing slashes stripped |
| `insecure` | `url` is plain http to a non-loopback address, added with `--allow-insecure-http` |
| `token` | The server's bearer token; never printed by `list` or `--json` |

# Plain http

`checkRemoteUrl()` accepts `https://` anywhere and `http://` only to loopback (`127.x`, `localhost`,
`::1`), so a plaintext LAN connection is never configured by accident. `--allow-insecure-http` on
`remote add --url` lifts that for a network that already encrypts (Tailscale, WireGuard): the entry gets
`insecure: true` (`isInsecureUrl()`), `add` warns on stderr, `remote list` shows `(unencrypted)` and
`remote list --json` reports `insecure`. The rule is only checked at `add`; the client sends to whatever
URL the entry holds. The server must also listen there: `kunj serve --listen <addr> --allow-remote-listen`.

# What the server refuses

`Guard.runSpec()` (src/lib/serve/guard.ts) checks every container a client asks `kunj serve` to create:
labels must include `kunj.repo` and be `kunj.*` only; volumes must be named volumes (never host paths)
mounted at absolute paths, and an existing volume must carry `kunj.repo`; `networkOf` must name a kunj
container; `privileged`, `securityOpt` and capabilities outside kunj's own set (`CHOWN`, `DAC_OVERRIDE`,
`FOWNER`, `SETUID`, `SETGID`, `NET_ADMIN`, `NET_RAW`) need `--allow-privileged`, and `runtime` needs
`--allow-runtime`. On the client, `kunj ct` keeps one backend per remote per command and closes its SSH
tunnel when the command ends (`ContainerCommand.closeBackends()`).

# Frames

Exec streams travel as binary WebSocket frames (src/lib/serve/protocol.ts). A frame carries at most
1 MB of data (`MAX_FRAME_DATA`): `encodeFrames()` splits a larger chunk, on the client's stdin and on
the server's `frameWriter`. A stream's chunk has no size limit (a tar stream yields a whole file at
once), and both ends refuse a frame over their 16 MB `maxPayload`. `attachWebSockets` listens for
`error` on every socket, so a refused frame or a reset connection ends that one stream and is logged;
it never ends the server.

# Terminal size and a lost terminal

A TTY exec (`shell`, `attach`, `agent`) goes through `execTty()` in docker.ts. The pty's first size is
set by `ConsoleSize` in the create call and by a resize after the start, retried up to
`FIRST_RESIZE_TRIES` (5) times while the daemon refuses it. In `serveExec` (streams.ts) the request and
the first `resize` are two frames: a resize that lands while the exec is being created is applied once
the pty exists. Before this a terminal sometimes stayed 80x24 (1 in 10 on a loaded Docker Desktop).
When the exec is unknown at the end (Docker restarted, the container stopped) `wait()` rejects with
`The terminal ended because the container stopped or Docker restarted…`, not the daemon's exec id.

A closed remote terminal is not hung up in the container: closing the hijacked connection leaves the
exec's process running (measured on Docker 29.7.2), and `wait()` polls 30 s before it rejects. Open; see
docs/specs/remote-containers.md.

# Starting the server

`kunj serve` calls `backend.info()` (`docker info`) before it listens, so a daemon that is down fails
early. A busy Docker Desktop can take tens of seconds or never answer: after `slowDockerMs` (5 s,
`ServeCommandDeps`) the command prints one `Waiting for Docker to answer…` line on stderr, and clears
the timer when `info()` settles. Nothing listens until then.
