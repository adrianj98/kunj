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
