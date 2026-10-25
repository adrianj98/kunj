---
type: Container
title: Container Images
description: Which image a branch container runs (setting, devcontainer, kunj-sandbox or a blueprint snapshot), how kunj's own images are tagged by a hash of their build context, and how they are built.
resource: src/lib/container/image.ts
tags: [container, docker, image, devcontainer, build]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

`src/lib/container/image.ts` decides which image a branch container runs and builds it when it is missing.
Resolution is pure (the caller reads the devcontainer and its Dockerfile from git), so lifecycle tests run on
a fake backend. Build contexts are streamed to `docker build` as ustar archives written by kunj itself
(owner 0:0, mtime 0, sorted, so the same input always gives the same bytes), with no tar dependency.

kunj's own build contexts live in `src/container/` (`sandbox/`, `nethelper/`, `sandbox-dind/`, `presets/`).
`scripts/copy-container-assets.js` runs as part of `npm run build`: it replaces `dist/container` with a copy
of `src/container` and chmods `*.sh`, `git-credential-kunj` and `kunj-dind-start` to 0755.
`sandboxAssetsDir()` finds them at `dist/container` (or `src/container` under ts-jest).

# Resolution order

`resolveImage(input)` returns an `ImageSource` (`kind`, `tag`, optional `build`, `user`, `spec`, `base`):

| Order | `kind` | Tag | User |
| --- | --- | --- | --- |
| 1 | `blueprint` | The snapshot tag, when a snapshot was found (not with `--image` or `--no-snapshot`) | The snapshot's user |
| 2 | `setting` | `--image`, else `container.image` (must pass `isImageRef`) | `''` (image's own USER) |
| 3 | `devcontainer` with `image` | That image | `remoteUser` |
| 4 | `devcontainer` with `build` | `kunj-<imageRepoName(repo)>:<imageHash>` | `remoteUser` |
| 5 | `sandbox` | `SANDBOX_IMAGE(version)` | `dev` |

With `container.dockerInDocker` on, lifecycle swaps the result for `dindSource()` (see
[Docker-in-Docker](/containers/docker-in-docker.md)). The devcontainer is read on the host from
`origin/<branch>` (or the base for `-c`), never from the working tree.

# Tags and asset hashes

| Image | Tag |
| --- | --- |
| Sandbox | `kunj-sandbox:<version>-<assetHash('sandbox')>` |
| Network helper | `kunj-nethelper:<version>-<assetHash('nethelper')>` (`resolveHelperImage()`) |
| Sandbox with Docker | `kunj-sandbox-dind:<version>-<hash>`, also hashing the sandbox tag it is built FROM (`DIND_IMAGE` in dind.ts) |
| Devcontainer build | `kunj-<repo>:<imageHash(dockerfileText, treeId, buildArgs)>` |

`assetHash(name)` is 12 hex of `directoryHash()`: SHA-1 over the directory's relative paths, sizes and
contents (not modes, since the build copy chmods). So editing a Dockerfile or `firewall.sh` rebuilds even at
the same version. `ensureImage()` builds only when the tag is missing (base image first), printing
`Building image <tag> (first use; this can take a few minutes)…`; a source without `build` that is missing
fails with `Image not found`.

# The sandbox image

`src/container/sandbox/Dockerfile`: `debian:bookworm-slim` with git, git-lfs, curl, tmux, socat, iproute2,
procps, zsh, openssh-client, gnupg, Node 22 from NodeSource, `gh`, and `@anthropic-ai/claude-code` installed
globally under `/usr`. It copies `git-credential-kunj` to `/usr/local/bin` and `zshrc` to `/etc/zsh/zshrc`
(sources `/etc/profile.d/*.sh`, so preset tool env applies), creates user `dev` (uid 1000, zsh) and
`/workspace`, sets `NPM_CONFIG_PREFIX=/home/dev/.npm-global`, `LANG=C.UTF-8`, `TERM=xterm-256color`, and
runs as `dev`. It has no sudo and no iptables: the helper owns the firewall.

# Devcontainer support

`src/lib/container/devcontainer.ts` reads `.devcontainer/devcontainer.json` or `.devcontainer.json`
(`DEVCONTAINER_PATHS`) as JSONC (`parseJsonc()`: comments and trailing commas). Supported keys:

| Key | Use |
| --- | --- |
| `image` | Validated with `isImageRef` |
| `build.dockerfile`, `build.context`, `build.args` | Must stay inside the repository; the Dockerfile inside the context |
| `containerEnv` | Applied before kunj's env (cannot override tokens or `KUNJ_*`) |
| `remoteUser` | Root (or uid 0) refused, at parse and again in the running image |
| `forwardPorts` | Published |
| `postCreateCommand`, `postStartCommand` | Run as the user in `/workspace` (string or string array) |
| `dockerComposeFile`, `service` | Sidecar services (see [Services](/containers/services.md)) |

Other keys are listed in `ignoredKeys` and printed as a warning. A devcontainer build context is
`git archive`d at the ref. Builds are not behind the firewall, so when the context differs from the default
branch's, start prints `BUILD_NETWORK_WARNING`.

# Related Concepts

* [Container Lifecycle](/containers/lifecycle.md)
* [Network helper and firewall](/containers/network-helper-firewall.md)
* [Snapshots](/containers/snapshots.md), [Presets](/containers/presets.md)
* [Docker-in-Docker](/containers/docker-in-docker.md)
* [Release process](/architecture/release-process.md) - the build step

# Citations

[1] [src/lib/container/image.ts](/src/lib/container/image.ts)
[2] [src/lib/container/devcontainer.ts](/src/lib/container/devcontainer.ts)
[3] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[4] [src/container/sandbox/Dockerfile](/src/container/sandbox/Dockerfile)
[5] [src/container/sandbox/zshrc](/src/container/sandbox/zshrc)
[6] [src/container/sandbox-dind/Dockerfile](/src/container/sandbox-dind/Dockerfile)
[7] [scripts/copy-container-assets.js](/scripts/copy-container-assets.js)
[8] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
