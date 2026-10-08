# aj-log

Changes made with Claude, and why.

## 2026-10-08 — New Worktree in a bare repository: "Could not list branches"

- `getGitRoot()` (src/lib/git.ts) used `git rev-parse --show-toplevel`, which fails in a bare repository, so
  `kunj list` found no branches and the macOS app's New Worktree sheet showed "No branches found". It now falls
  back to the repository directory (`--absolute-git-dir`) when the repository is bare.
- `kunj list --json` printed plain text when there were no branches; it now prints `{"branches": []}`.

## 2026-10-08 — Colour in editors opened by KunjBar, click feedback

- The macOS app and VS Code extension no longer run kunj with `NO_COLOR=1 FORCE_COLOR=0`. `kunj worktree open`
  inherited them and VS Code handed them on to every terminal in the window, so tools there (e.g. Claude Code)
  lost all colour. Instead the CLI turns chalk off itself whenever `--json` is passed (src/index.ts), which
  also covers an inherited `FORCE_COLOR=1` - chalk already skips colour when output is piped.
- macOS app: clicking a worktree row now shows it was clicked — the row tints blue and shows "Opening…" with a
  spinner until the open finishes (at least 0.6s so it is visible). Repeat clicks while opening are ignored.
  A first version also tracked the mouse-down with a `DragGesture(minimumDistance: 0)`; that swallowed the
  row's tap so clicking opened nothing, and it was removed.
- The spinner replaces the row's icon and stays until the editor registers its session (the worktree turns
  "open"), up to 15s, instead of disappearing as soon as the CLI returns.
- Released as v1.1.1.
- macOS app: the panel closes after clicking a worktree, "Open in New Window" or "Open Terminal"
  (`MenuBarAnchor.closePanel()`). Released as v1.1.2.
- Colour was still missing in a window opened at 10:51: the installed VS Code extension was the old build,
  which still set NO_COLOR when it ran `kunj worktree open`. Reinstalled it from the repo. VS Code itself
  doesn't need restarting (its main process never had the variables); only windows opened before the fix do.

## 2026-10-07 — Release v1.1.0

Released everything since v1.0.1 so `kunj repos` / `kunj install` reach npm and the release carries the
macOS app zip (`kunj install macos` needs a release that has one).

- `kunj repos` — registry of repositories kunj has been used in (`~/.kunj/repos.json`), so the macOS app can discover them.
- macOS menu bar app (`macos-app/`) — same features as the VS Code extension; open worktrees first and highlighted,
  "Open only" toggle, adaptive light/dark palette, panel stays pinned under the menu bar when it shrinks.
- Release workflow attaches `Kunj-macos-<version>.zip` (unsigned) next to the `.vsix`.
- `kunj install [vscode|macos|all]` — downloads and installs the companion apps; offered at the end of `kunj setup`.
- Also in this release: hooks, new branches from the fetched default branch, `worktree add -c`, config variables,
  bare repository support, keep files.
