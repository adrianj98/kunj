---
name: handoff
description: Hand off the work being discussed to a new agent in a new kunj worktree - writes a brief from this conversation, creates the worktree, starts a Claude agent there with the brief as its first prompt, and the Kunj Workspace app switches to it. Use when the user says /handoff, "hand this off", "start that in a new worktree", or asks for a new agent to pick up the research or plan just discussed.
---

# Hand off to a new worktree

The user wants the work in this conversation picked up by a fresh agent in its own worktree. The new
agent sees nothing of this conversation except the brief you write, so the brief is the whole job.

## 1. Write the brief

Write it to a new temporary file (`mktemp -t kunj-handoff`, or the scratchpad directory). Markdown,
for a capable engineer who has seen none of this conversation:

- **Goal**: what to build, fix or find out, and what done looks like. Take it from the user's words
  after `/handoff`; without any, the work this conversation was converging on.
- **Context**: the repository, and why this work exists.
- **What is known**: findings with `path:line`, commands that were run and what they showed, links.
  Facts, not the story of how you got there.
- **Decisions**: what was decided and by whom (the user's choices are binding), and options already
  ruled out with the reason.
- **Constraints**: the user's standing instructions that matter here (commit rules, tests to run or not,
  style), and anything to avoid.
- **First steps**: where to start.
- **Open questions**: what is still undecided; say to ask the user rather than guess.

Keep it as long as it needs to be and no longer; under 256 KB. Never put secrets, tokens or
credentials in it.

## 2. Pick the branch

- The name the user gave, else a short kebab-case name from the goal (`lsp-vite-build`).
- It starts from kunj's default base. Only when the user says to build on the current branch
  ("from this branch"), add `--base <current branch>`.
- Check the name is free: `git rev-parse --verify --quiet refs/heads/<branch>` must fail. If it is
  taken, add a suffix (`-2`).

## 3. Create the worktree and start the agent

Run from inside the repository:

```bash
kunj worktree add -c <branch> --json
kunj agent start <branch> --session handoff --detach --open-in-app --prompt-file <brief> --json
```

- If `worktree add` fails, stop and report kunj's message; do not start an agent.
- If `agent start` says `started: false`, a `handoff` session already runs there: retry with
  `--session handoff-2` (then `-3`, …).
- If `agent start` fails, report it and leave the worktree in place, with the command to retry.

## 4. Report

Tell the user, briefly:

- the branch and the worktree path (`worktree` in the JSON),
- that the agent has started with the brief, and that the Kunj Workspace app opens its tab (if the app
  is running),
- how to attach from a terminal:
  ```bash
  kunj agent <branch> --session <id>
  ```
- the brief's file path, so they can read what was handed over.

Do not continue the handed-off work yourself in this session.
