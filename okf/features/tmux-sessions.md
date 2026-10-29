---
type: Feature
title: tmux sessions
description: kunj sessions lists every tmux session kunj started (host and container) with its worktree, attached terminals, CPU, memory and orphan state, and ends them; the workspace app's Sessions window shows it.
resource: src/lib/sessions.ts
tags: [feature, tmux, agents, shells, workspace-app, json]
timestamp: 2026-10-27T00:00:00Z
---

# Overview

`kunj sessions [list|kill]` (src/commands/sessions.ts, on the [fast path](/architecture/fast-path.md))
finds stray [agent](/features/worktree-agents.md) and [shell](/features/persistent-shells.md) sessions.
Spec: docs/specs/tmux-sessions.md. JSON: `SessionsJson` / `SessionsKillJson` in
[the contract](/architecture/json-contract.md).

# How it reads tmux

`SESSIONS_SCRIPT` is one `sh -c`: `tmux list-sessions`, `list-panes -a`, `list-clients`, then
`ps -axo pid=,ppid=,pcpu=,rss=,comm=`, sections marked `#sessions`, `#panes`, `#clients`, `#ps`, fields
separated by a literal tab (tmux does not expand `\t`). `parseSessionsOutput()` reads it; the same
script runs in containers through `ContainerCommand.sessionsExec()` (only with `--containers`).

* Owner: the `@kunj_worktree` user option (`SESSION_WORKTREE_OPTION`), which `agentArgv(…, { worktree })`
  sets on host sessions, else the session names each worktree's current branch would give
  (`expectedOwners()`: `git worktree list` per repository in `repos.json`).
* Usage: `treeUsage()` sums `pcpu` and RSS over each pane's process tree.
* Attached: `clientVia()` names the app a tmux client runs in.
* Orphans (never while attached): `worktree-gone` (tagged directory missing, or untagged and no worktree
  of a listed repository matches; a failed `git worktree list` marks its repository `unlisted`, never
  gone), `idle` (quiet for `--idle-hours`, default 24).

# Ending

`kill` ends only kunj names (`isKunjHostSession`, `CONTAINER_SESSION`); `--orphans` adds the current
orphans; `--if-detached` (implied by `--orphans`, used by End Orphans) re-checks attachment right
before each kill; `--container` execs the kill in that branch container. `--json` exits 0 and lists failures.

# Workspace app

Window > Sessions (⌘⇧S) polls `kunj sessions list [--containers] --json` every 5 s while open; a
session whose id matches an open tab is "Tab open" and is skipped by End Orphans. The sidebar rows
show each worktree's summed host-session usage (`sessionUsageByWorktree()`, `formatUsageShort()`) from
its own `kunj sessions list --json` poll (5 s, no `--containers`, only while the window is visible).

# Following a checkout

Lookups by worktree (`worktree list`, `kunj agent`, `kunj worktree shell`) read names with their
`@kunj_worktree` tag (`readTaggedTmuxSessions()`) and take a tagged session by its tag
(`worktreeAgentSessions()`, `worktreeShellSessions()`, `pickSession()`), so an agent that checked out
another branch in its worktree keeps its session.
The workspace app moves a worktree's tabs, saved layout and selection to the new branch's
environment (`worktreeMoves()`, `EnvironmentStore.onWorktreesMoved`, `TabRegistry.move`).
