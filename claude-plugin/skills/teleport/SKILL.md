---
name: teleport
description: Continue a Claude Code web session (claude.ai/code) in a new kunj worktree - creates the worktree, starts claude --teleport <session> there as a kunj agent, and the Kunj Workspace app switches to it. Use when the user says /teleport <session id or URL>, or asks to bring a web session down into its own worktree or agent tab.
---

# Teleport a web session into a new worktree

The user gives a Claude Code web session: an id such as `session_01GswEqFVAEhfqNDfU19ZpW8`, or its
`https://claude.ai/code/session_…` URL. It is continued locally by `claude --teleport`, run as a kunj
agent in a fresh worktree of this repository. Write no brief: the session brings its own conversation.
Do not continue its work in this session.

1. **Branch**: the name the user gave, else `teleport-<the last 8 characters of the id, lowercased>`.
   Check it is free (`git rev-parse --verify --quiet refs/heads/<branch>` must fail; else add `-2`).
   It starts from kunj's default base; claude then checks out the web session's own branch there.
2. **Create the worktree and start the agent**, from inside the repository:
   ```bash
   kunj worktree add -c <branch> --json
   kunj agent start <branch> --session teleport --detach --open-in-app --teleport <session> --json
   ```
   - If `worktree add` fails, report kunj's message and stop.
   - `started: false` means a `teleport` session already runs there: retry with `--session teleport-2`.
   - Error code `bad-teleport-id`: the id is not a session id; show the message and stop.
   - Any other failure: report it, leave the worktree, and give the command to retry.
     The JSON's `teleport` says how it went (kunj watches for up to 20 s):
     - `switched`: claude checked out the web session's branch; report `teleport.branch` as the branch the
       worktree is on (kunj deletes the placeholder branch it was created on).
     - `failed`: claude could not teleport; show `teleport.message` (for example `Session not found: …`,
       a wrong id or a session of another account or repository). The agent's pane stays open with the
       error. Say the worktree stayed on the placeholder branch, and offer to remove it
       (`kunj worktree remove <branch>`); do not retry with the same id.
     - `pending`: show `teleport.message` (usually: answer Claude's folder-trust question in the agent's tab).
3. **Report** briefly: the branch and worktree path (`worktree` in the JSON), that claude is teleporting
   the session there and the Kunj Workspace app opens its tab (when it runs), and how to attach:
   `kunj agent <branch> --session <id>`, and the branch the worktree ended on (`teleport` above). When
   the web session's branch is checked out in another worktree, claude cannot check it out here; then
   the user runs `kunj agent start <that branch> --teleport <session>` there instead.
