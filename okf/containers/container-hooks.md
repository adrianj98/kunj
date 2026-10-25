---
type: Container
title: Container Hooks
description: The pre/post-container-create and pre/post-container-delete hooks that kunj ct start, open and remove run around creating and removing a branch container.
resource: src/lib/hook-defs.ts
tags: [container, hooks]
timestamp: 2026-10-25T00:00:00Z
---

# Overview

Branch containers take part in kunj's [hook system](/features/hooks.md). Four hooks are declared in
`src/lib/hook-defs.ts` with the arguments `branch`, `container` and `image` (`CONTAINER_ARGS`), and run by
`runActionHook()` from `src/commands/container.ts`. Each argument is passed positionally, as
`KUNJ_BRANCH`, `KUNJ_CONTAINER`, `KUNJ_IMAGE` in the environment and as `${branch}`, `${container}`,
`${image}` in `hooks.<name>` config commands.

# The hooks

| Hook | When | `image` | Failure |
| --- | --- | --- | --- |
| `pre-container-create` | Before a start that will create a container | `''` (not resolved yet) | Aborts: nothing is created |
| `post-container-create` | After `startContainer` returns `created: true` (created and seeded) | The image used | Warning |
| `pre-container-delete` | Before `kunj ct remove` deletes, after the unpushed-work guard passed | The container's image | Aborts the removal |
| `post-container-delete` | After the container, helper, services, volumes and network are removed | The container's image | Warning |

# When a start creates

`startOrResume()` (shared by `kunj ct start` and `kunj ct open`) computes `willCreate` as `--rebuild` or "no
container of that name" (`inspectLabels()` returns null). The create hooks run only then: resuming an
existing container runs neither, and `--rebuild` counts as creating. The order is:

```
precheckDind -> containerSecrets (vault, checkSecrets) -> pre-container-create
  -> blueprint snapshot -> startContainer -> post-container-create (if created)
```

So a locked vault, a bad secret or Docker-in-Docker that cannot run fails before the hook, and a failing
pre hook stops the start before the snapshot build or any push.

# Removal

`kunj ct remove` runs `inspectForRemove()` first (unless `--force`) and refuses with the list of problems,
then `pre-container-delete`, then `removeContainer(..., { force: true })`, then `post-container-delete`.
`kunj ct prune` also runs the delete hooks for the containers it removes (see [Prune](/containers/prune.md)).

`--no-hooks` (`[start|remove|prune]`) skips them. In `--json` mode hook stdout goes to stderr so the JSON
document stays clean, and a failing pre hook is reported as error code `hook`. Quoting of `${...}` values in
config commands is handled by `expandVariablesQuoted()` (see
[Config variables](/architecture/config-variables.md)).

# Related Concepts

* [Hooks](/features/hooks.md)
* [Container Lifecycle](/containers/lifecycle.md)
* [Prune](/containers/prune.md)
* [Snapshots](/containers/snapshots.md) - built after the pre-create hook

# Citations

[1] [src/lib/hook-defs.ts](/src/lib/hook-defs.ts)
[2] [src/commands/container.ts](/src/commands/container.ts)
[3] [src/lib/hooks.ts](/src/lib/hooks.ts)
[4] [docs/specs/branch-containers.md](/docs/specs/branch-containers.md)
