# Branch Containers

`kunj container` (alias `ct`): a branch in a sandboxed Docker container with its own clone. Code in `src/lib/container/`, image build contexts in `src/container/`.

# Foundation

* [Branch Containers](/containers/overview.md) - kunj container (alias ct) runs a branch in a sandboxed Docker container with its own clone of the repository, mainly so an agent can run with permissions skipped.
* [Container Backend](/containers/backend.md) - ContainerBackend is the only seam between kunj and a container engine; LocalDockerBackend in docker.ts is the one module that spawns docker, and FakeBackend replaces it in unit tests.
* [Container Naming and Labels](/containers/naming-and-labels.md) - How branch containers, helpers, volumes and networks are named, and the kunj.* Docker labels that are the container system's only state.
* [Container Lifecycle](/containers/lifecycle.md) - How kunj starts, resumes, stops and removes a branch container, with READY gating, dropped capabilities, rollback on failure and the unpushed-work remove guard.
* [Network Helper and Firewall](/containers/network-helper-firewall.md) - A sidecar container sharing the branch container's network namespace holds NET_ADMIN, applies firewall.sh's egress rules and signals READY; the agent's container cannot change them.
* [Container Images](/containers/images.md) - Which image a branch container runs (setting, devcontainer, kunj-sandbox or a blueprint snapshot), how kunj's own images are tagged by a hash of their build context, and how they are built.
* [Container Seed](/containers/seed.md) - How a new branch container gets its clone - origin inspection on the host, then a POSIX seed script run as the sandbox user that clones origin, copies a snapshot's checkout or clones a host-made bundle.

# Inside a Container

* [Container Env and Status](/containers/env-and-status.md) - What environment a branch container gets, how exec and shell run commands in it, and how STATUS_SCRIPT feeds the agent and git fields of kunj ct list --json and kunj events.
* [Container Tokens](/containers/tokens.md) - How a branch container gets a git token - from container.env or, for a GitHub origin, gh auth token - and how git-credential-kunj hands it only to origin's host.
* [Container Agents](/containers/container-agents.md) - kunj ct agent runs container.agentCommand in a tmux session inside the branch container (agent or agent-<id>), kunj ct attach reattaches, and the agent's state is read back by STATUS_SCRIPT.
* [Container Files](/containers/files.md) - kunj ct file read|write reads and writes text files in a branch container's /workspace as the sandbox user, for the workspace app's editor tabs.
* [Container Editor Open](/containers/editor-open.md) - kunj ct open attaches VS Code or Cursor to a running branch container through the Dev Containers extension, resuming the container first when needed.
* [Container Hooks](/containers/container-hooks.md) - The pre/post-container-create and pre/post-container-delete hooks that kunj ct start, open and remove run around creating and removing a branch container.

# Phase 2

* [Sidecar Services](/containers/services.md) - Postgres, Redis and other service containers started next to a branch container on its own network, reachable by service name.
* [Port Forwarding](/containers/forwarding.md) - Host 127.0.0.1 listeners tunnelled into a branch container or service through docker exec, manual or automatic, tracked in a pid registry.
* [Container Prune](/containers/prune.md) - kunj ct prune plans and removes branch containers whose branch left origin, orphaned Docker objects and superseded images, failing safe at every rule.
* [Docker-in-Docker](/containers/docker-in-docker.md) - Opt-in dockerd inside a branch container, via the sysbox runtime or privileged mode, on the kunj-sandbox-dind image.
* [Host MCP Bridge](/containers/mcp-bridge.md) - Bridges a host stdio MCP server (v1 only a Chrome DevTools browser) into a branch container over a Unix socket, behind a deny-by-default request filter.

# Blueprints

* [Blueprints](/containers/blueprints.md) - The .kunj/blueprint.json file that says how a new branch container is set up (tools, setup, maintain, lockfiles, services), its resolution, validation and hash.
* [Blueprint Presets](/containers/presets.md) - Root-run POSIX sh tool installers named by a blueprint's tools, found in the repo, the host or kunj's built-ins, sharing _lib.sh.
* [Blueprint Snapshots](/containers/snapshots.md) - The committed kunj-blueprint-<repo>:<hash> image a new branch container starts from, built from a host-made git bundle with no secrets, and how start finds, builds and provisions around it.
