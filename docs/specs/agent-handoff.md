# Handoff: start an agent in a new worktree from a conversation

*Decided 2026-11-04.* `/handoff` is a Claude Code skill shipped with kunj. In the middle of a
conversation (research, a design, a bug hunt) the user says `/handoff can you start that in a new
worktree`; the skill writes a brief from the conversation, creates a worktree for it, starts a Claude
agent there with the brief as its first prompt, and the workspace app switches to the new agent's tab.

## Status

| Part | State |
| --- | --- |
| CLI: `kunj agent start --detach --prompt-file --open-in-app` | To do |
| CLI: `kunj events` agent event `open`, `id`, `worktree` | To do |
| Workspace app: open, select and focus the handed-off agent | To do |
| Skill: `skills/handoff/SKILL.md`, `kunj install skill`, offered by `kunj setup` | To do |

## The skill

`skills/handoff/SKILL.md` in the kunj package. When invoked it:

1. **Writes the brief** to a temporary file, from the conversation so far: the goal; what was found,
   with `file:line`; decisions made and by whom; constraints and the user's standing instructions that
   matter; suggested first steps; what not to redo. It is written for a reader who has seen none of the
   conversation. The user's words after `/handoff` say what to hand off (default: the work being
   discussed).
2. **Picks the branch:** a name the user gave, else a short kebab-case name from the topic. The branch
   starts from kunj's default base (`resolveBaseRef()`); "from this branch" in the request starts it
   from the current branch (`--base <current>`).
3. **Runs**
   ```bash
   kunj worktree add -c <branch> --json
   kunj agent start <branch> --session <id> --detach --open-in-app --prompt-file <brief> --json
   ```
   `<id>` is `handoff` (or `handoff-2`, … when taken). A failed step is reported with kunj's message
   and nothing after it runs; the worktree is not removed.
4. **Reports** the branch, the worktree path, the session, and how to attach from a terminal
   (`kunj agent <branch> --session <id>`).

The skill needs no app: outside it the agent runs in tmux and the user attaches with that command.

## CLI

**`kunj agent start` options** (start only; the others refuse them):

| Option | Effect |
| --- | --- |
| `--detach` | Start the tmux session without attaching (`new-session -d`) and return; needs no terminal. A session already running is left as it is (`started: false`). Refused with `--no-tmux`, `agent.tmux: false` or no tmux (`tmux-missing`). |
| `--prompt-file <f>` | The agent's first prompt. Copied to `~/.kunj/<repo>/agent-prompts/<session>.md` (0600); the command becomes `claude … "$(cat '<copy>')"`. Only for a claude command (`prompt-needs-claude`); ignored with a warning when the session already runs. Up to 256 KB (`prompt-too-large`). |
| `--open-in-app` | Sets the tmux user option `@kunj_open` to `app` on the new session. |
| `--json` | With `--detach`: `AgentStartJson` `{ branch, worktree, session, id, started }`. |

**`kunj events`.** The agent poll reads `@kunj_open` and `@kunj_worktree` in the same `tmux
list-sessions` call. A new session's event gains `id` (its `--session` id or null), `worktree` (the
tagged path) and `open: 'app'` when the option is set. Fields are only added (`EventJson`).

## Workspace app

On an `agent` event with `running: true` and `open: 'app'`:

1. Refresh the listing (as for any event) and find the environment whose worktree path is `worktree`.
2. If no tab already has that session, open an agent tab with `session: id` (it runs
   `kunj agent start <branch> --session <id>`, which attaches to the running session).
3. Select the environment and focus the tab, bringing the window forward.

Only the poll's new-session event triggers it, so a session that started while the app was closed is
not opened on the next launch; its worktree shows in the sidebar with a running agent. A worktree that
is not in the listing yet is retried on the next refresh for 30 s.

## Install

- The npm package's `files` gains `skills`.
- `kunj install skill` copies `skills/handoff/` to `~/.claude/skills/handoff/`, replacing an older copy
  kunj wrote (a `.kunj-version` file in it) and refusing to overwrite one it did not write without
  `--force`. It is not in `kunj install all`'s download list (no release asset).
- `kunj setup` offers it after the companion apps.

## Testing

- Jest: argv for `--detach` (`-d`, no attach) and `--open-in-app` (`set-option @kunj_open app`); the
  prompt copy and the quoted command; refusals (`--no-tmux`, not claude, too large); the events poll
  parsing `@kunj_open`; `install skill` copy, version marker, refusal.
- KunjWorkspaceCore: `EventStream` parses `open`, `id`, `worktree`; the "which environment, open or
  focus" decision as a pure function.
- Manual: `/handoff` from an agent tab in the app opens the new tab.
