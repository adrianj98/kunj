---
type: Container
title: Container Tokens
description: How a branch container gets a git token - from container.env or, for a GitHub origin, gh auth token - and how git-credential-kunj hands it only to origin's host.
resource: src/lib/container/tokens.ts
tags: [container, credentials, github, gh, security]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A container clones and pushes over HTTPS with a token, because it has no SSH keys and the host's agent is
never forwarded. The token comes from the host environment through `container.env` or, failing that, from
`gh auth token` for a GitHub origin (`src/lib/container/tokens.ts`). It travels only in the `docker run`
env-file. Inside, git asks `git-credential-kunj`, which answers only for origin's `host[:port]`, so a token
forwarded for GitHub is never sent to another host the repository or the agent points git at.

The agent can read the token. Prefer a repository-scoped token; `container.useGhToken: false` stops kunj
asking gh.

# Where the token comes from

`withHostTokens(env, config, originHost, lookup)` is called lazily by `startContainer` (only for a new
container's env-file, or when a resumed container still needs seeding):

| Condition | Result (`github`) |
| --- | --- |
| The forwarded env already has one of `TOKEN_KEYS` (`GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`) | `env` |
| `container.useGhToken` is false, or `container.env` does not name `GH_TOKEN` | `null` |
| Origin is not `github.com` and `ghKnowsHost()` is false | `null` |
| `gh auth token --hostname <host>` prints a token | `GH_TOKEN` added, `gh` |

`ghAuthToken()` uses `execFile` (no shell), a 10 s timeout and `GH_PROMPT_DISABLED=1`, and rejects output
with whitespace. `ghKnowsHost()` reads the top-level keys of gh's `hosts.yml` in `GH_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/gh`, else `~/.config/gh`. A container-targeted `GH_TOKEN` stored with `kunj secret` wins
over both. Snapshots get no token (their env is empty and the bundle needs none). Tests pass
`StartOptions.tokenLookup` (`TokenLookup`: `gh(host)`, `ghKnowsHost(host)`) so they never reach the real gh.

An SSH origin with no token is refused on a new container (`StartError` code `no-token`), unless the start
seeds from a bundle.

# Inside the container

`installCredentialHelper()` (lifecycle.ts) streams `src/container/sandbox/git-credential-kunj` into
`$HOME/.kunj/bin/` (mode 0755, owned by the user) of every container that gets a token, whatever the image;
the sandbox image also ships it at `/usr/local/bin`. The [seed script](/containers/seed.md) sets
`credential.helper` to it and rewrites `git@<host>:` and `ssh://git@<host>/` to `https://<host>/`.

The helper (POSIX sh):

* acts only on `get` (store and erase do nothing);
* reads `host=` from git's request and exits silently unless it equals `$KUNJ_CREDENTIAL_HOST`, which
  lifecycle sets last in the container env from `parseOrigin().credentialHost`, after the devcontainer's
  `containerEnv` so the branch cannot override it;
* prints `username=x-access-token` with `GH_TOKEN` or `GITHUB_TOKEN`, or `username=oauth2` with
  `GITLAB_TOKEN`.

# kunj ct token status

`githubTokenSource()` runs the same decision without returning the token. `kunj ct token status` uses
origin's host (`github.com` outside a repository) and prints where the token would come from;
`--json` prints `ContainerTokenStatusJson`:

```json
{ "github": { "source": "env" | "gh" | null, "enabled": true } }
```

`enabled` is `container.useGhToken !== false`. It does not know about a `GH_TOKEN` stored in the vault, since
that would need an unlock.

# Related Concepts

* [Seed](/containers/seed.md) - credential helper config and insteadOf
* [Env and status](/containers/env-and-status.md) - `container.env`
* [Container Lifecycle](/containers/lifecycle.md)
* [Secrets resolution and delivery](/secrets/resolution-and-delivery.md)
* [Workspace app](/apps/workspace-app.md) - Settings shows the token source

# Citations

[1] [src/lib/container/tokens.ts](/src/lib/container/tokens.ts)
[2] [src/container/sandbox/git-credential-kunj](/src/container/sandbox/git-credential-kunj)
[3] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[4] [src/lib/container/env.ts](/src/lib/container/env.ts)
[5] [src/commands/container.ts](/src/commands/container.ts)
[6] [src/lib/json-types.ts](/src/lib/json-types.ts)
[7] [src/settings/container.ts](/src/settings/container.ts)
