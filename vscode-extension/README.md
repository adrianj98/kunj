# Kunj Worktrees for VS Code

A Worktrees view for VS Code that is driven entirely by the [kunj](https://github.com/adrianj98/kunj) CLI.

- Lists every git worktree of the repository you have open.
- Shows which worktrees are **open in other VS Code windows** (and which one is this window).
- Click a worktree to open it. If it is already open elsewhere, VS Code focuses that window instead of opening a duplicate.
- Create, remove and prune worktrees, open a terminal in one, reveal it in the file manager, copy its path, or add it to the current workspace.
- Per-worktree status: uncommitted change count and ahead/behind of upstream.
- The related pull request for each worktree: number, open/draft/merged/closed state and CI check result. Click the PR icon to open it in the browser, or create one with `kunj pr` from the context menu.
- Status bar item showing the current worktree; click it to jump to another one.

Everything the extension does is a `kunj worktree … --json` call. The extension never runs git itself, so the CLI stays the single source of truth and the same information is available from your terminal:

```bash
kunj worktree                # list worktrees, including which editor windows have them open
kunj worktree add <branch>   # create a worktree (default: ../<repo>-worktrees/<branch>)
kunj worktree open <branch>  # open in your editor
kunj worktree pr <branch> -w # show the pull request for a worktree (and open it)
kunj worktree remove <branch>
kunj worktree prune
kunj worktree session list   # editor windows currently registered
```

## Requirements

- The `kunj` CLI on your `PATH` (`npm install -g kunj`), or point `kunj.cliPath` at it, for example `node /path/to/kunj/dist/index.js`.
- git 2.31 or newer (for `git worktree list --porcelain` and `--path-format`).
- Optional: the GitHub CLI (`gh`) or GitLab CLI (`glab`), logged in, for pull request information. Without it the view simply omits PRs.

## How "open in other windows" works

When a window activates the extension, it registers itself with `kunj worktree session start --pid <extension host pid>`. Sessions live in `~/.kunj/worktree-sessions.json`. The CLI prunes any session whose process is no longer alive, so windows closed without a clean shutdown disappear automatically. Each window also sends a heartbeat every five minutes and removes its session on deactivate.

The view watches that file, so opening or closing a worktree in one window updates the other windows within a second. It also refreshes when the window regains focus and every `kunj.worktrees.refreshInterval` seconds.

Remote workspaces (SSH, WSL, containers) work as long as `kunj` is installed on the remote side, because the extension host and the CLI both run there.

## Commands

| Command | Description |
| --- | --- |
| Kunj: Refresh Worktrees | Re-run `kunj worktree list` |
| Kunj: Add Worktree… | Pick an existing branch or create a new one, choose a folder, then open it |
| Kunj: Open Worktree… | Quick pick of all worktrees with their open state |
| Kunj: Prune Stale Worktrees | `kunj worktree prune` |
| Open Pull Request, Copy Pull Request URL | From `kunj worktree list --json`; a worktree without one gets Create Pull Request… which runs `kunj pr` in a terminal |
| Open Worktree / in New Window / in Current Window | Context menu on a worktree |
| Add Worktree to Workspace | Adds the folder to the multi-root workspace |
| Open Terminal in Worktree | Integrated terminal with the worktree as cwd |
| Reveal Worktree in File Manager, Copy Worktree Path | Utilities |
| Remove Worktree… | `kunj worktree remove`, offering `--force` when the CLI refuses because the worktree is open elsewhere or has uncommitted changes |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kunj.cliPath` | `kunj` | Executable to run. May include leading arguments. |
| `kunj.worktrees.clickAction` | `newWindow` | `newWindow`, `currentWindow` or `ask` |
| `kunj.worktrees.refreshInterval` | `30` | Seconds between automatic refreshes, `0` to disable |
| `kunj.worktrees.showStatus` | `true` | Run `git status` per worktree to show change counts |
| `kunj.worktrees.showPullRequests` | `true` | Look up the pull request for each worktree via `gh`/`glab` |
| `kunj.worktrees.showPath` | `true` | Show the worktree path next to its branch |
| `kunj.worktrees.showStatusBar` | `true` | Show the current worktree in the status bar |
| `kunj.worktrees.trackSessions` | `true` | Register this window so other windows can see it |

The CLI side has two settings of its own (`kunj config --set worktree.baseDir=…` and `worktree.editorCommand`) that control where new worktrees go and which editor `kunj worktree open` launches.

## Building from source

```bash
cd vscode-extension
npm install
npm run build          # bundles to dist/extension.js
npm run package        # produces kunj-worktrees-<version>.vsix
code --install-extension kunj-worktrees-0.1.0.vsix
```

For development, open the `vscode-extension` folder in VS Code and press F5 to launch an Extension Development Host. Set `kunj.cliPath` to `node /path/to/kunj/dist/index.js` if the CLI is not linked globally.
