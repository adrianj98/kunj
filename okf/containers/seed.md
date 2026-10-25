---
type: Container
title: Container Seed
description: How a new branch container gets its clone - origin inspection on the host, then a POSIX seed script run as the sandbox user that clones origin, copies a snapshot's checkout or clones a host-made bundle.
resource: src/lib/container/seed.ts
tags: [container, git, clone, seed, bundle]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

A branch container's `/workspace` is its own clone, not a mount of the host's checkout. `src/lib/container/seed.ts`
has two halves: host-side helpers that inspect origin (`inspectOrigin`, `refExistsOnOrigin`, `pushBranch`,
`hostGitIdentity`) and `seedScript()`, which renders the POSIX `sh` script that lifecycle runs in the
container as the sandbox user after READY. The script is safe to re-run after a partial failure.

`seedIfNeeded()` in lifecycle.ts runs it unless `/workspace/.kunj-seeded` (`SEED_MARKER`) exists. It first
`chown`s `/workspace` and the home volume to the user (as root), installs the credential helper when there is
a token (see [Tokens](/containers/tokens.md)), streams a bundle in when there is one, and fails with
`StartError` code `seed` on a non-zero exit.

# Origin on the host

| Function | Detail |
| --- | --- |
| `stripUserinfo(url)` | Drops `user:token@` from URLs so a token in the host remote never reaches the container, argv or an error; `ssh://` keeps the user name |
| `parseOrigin(url)` | `host`, `credentialHost` (`host:port` when the URL has a port, as git sends `host=`), `isSsh` (ssh:// or scp-like) |
| `originPort(url)` | URL port, else 443/80/22/9418 by scheme, 22 for scp-like, 0 for a local path |
| `inspectOrigin(branch, cwd)` | Fetches `+refs/heads/<b>:refs/remotes/origin/<b>` (failure ignored), returns `OriginState`: `originUrl`, `originHost`, `credentialHost`, `branchOnOrigin`, `unpushed`, `isSsh` |
| `refExistsOnOrigin(ref)` | `git ls-remote --exit-code`; bare names tried as branch then tag; exit 2 is "no", other failures throw |
| `pushBranch(branch)` | `git push -u origin refs/heads/<b>:refs/heads/<b>` after the user confirms |

Network calls use `nonInteractiveEnv()` (`GIT_TERMINAL_PROMPT=0`, empty askpass, `ssh -o BatchMode=yes`) and
a 30 s timeout. An origin with no host (a local path) cannot be cloned in a container.

# The seed script

Always: `git config --global` user name and email from the host, `push.autoSetupRemote true`. With a token:
`credential.helper` pointing at the installed helper, and `url.https://<host>/.insteadOf` for
`git@<host>:` and `ssh://git@<host>/`, so SSH remotes work over HTTPS with the token.

| Source | Clone step |
| --- | --- |
| Origin (default) | `git clone --recurse-submodules <originUrl> /workspace` when `/workspace/.git` is absent |
| Snapshot (`seedFrom` = `SEED_DIR`) | Copy `/opt/kunj/seed` into `/workspace` (see sentinels), `git remote set-url origin`, drop stale `refs/remotes/origin/*` from a fresh copy except the base |
| Bundle (`bundlePath`) | `git clone --no-checkout -b <branch> <bundle> /workspace`, then `remote set-url origin` |

Then the branch:

* `-c` (create): `git fetch origin <base>`, then `git switch <branch>` if it exists locally, else
  `git switch -c <branch> --no-track origin/<base>` (never a bare switch that would pick up a
  remote-tracking ref).
* Bundle: `git switch <branch>` without fetching (that could need a token), make sure
  `refs/remotes/origin/<branch>` exists, `git submodule update --init --recursive` when `.gitmodules`
  exists. A bundle cannot seed a new branch.
* Otherwise: fetch the branch into `refs/remotes/origin/<branch>`; a fresh snapshot copy is moved there with
  `git switch -C`, any other checkout only switched to.

Finally the sentinel names are appended to `.git/info/exclude` and `touch /workspace/.kunj-seeded`.

# Sentinels

| File | Meaning |
| --- | --- |
| `.kunj-seeded` (`SEED_MARKER`) | Seed finished; an ignored file, never in a snapshot |
| `.kunj-copying` (`SEED_COPYING`) | A snapshot copy is in progress; only then may `/workspace` be wiped and recopied |
| `.kunj-fresh` (`SEED_FRESH`) | A complete snapshot copy whose branch must still be moved to origin's |

A snapshot copy replaces `/workspace` only when it has no `.git` or `.kunj-copying` is present, never a real
checkout (`.kunj-seeded` cannot decide this because `git clean -x` removes it).

# Bundle seeding

For a [snapshot](/containers/snapshots.md) the host fetches the branch with its own credentials and makes a
bundle; `StartOptions.bundle` (`hostPath`, `containerPath`) streams it in as the user (mode 0600). No token is
forwarded, the SSH `no-token` refusal and the unpushed gate are skipped, and the bundle file is removed
before the image is committed (`/tmp` is in the image). A failure hints that private submodules cannot be
fetched during a snapshot yet.

# Related Concepts

* [Container Lifecycle](/containers/lifecycle.md)
* [Tokens](/containers/tokens.md) - credential helper and insteadOf
* [Snapshots](/containers/snapshots.md), [Blueprints](/containers/blueprints.md)
* [Prune](/containers/prune.md) - reads which branches the clone saw on origin

# Citations

[1] [src/lib/container/seed.ts](/src/lib/container/seed.ts)
[2] [src/lib/container/lifecycle.ts](/src/lib/container/lifecycle.ts)
[3] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
[4] [CLAUDE.md](/CLAUDE.md)
