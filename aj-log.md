# aj-log

Changes made with Claude, and why.

## 2026-10-08 — Colour in editors opened by KunjBar, click feedback

- `openWorktree()` (src/lib/worktree.ts) no longer passes `NO_COLOR`/`FORCE_COLOR` to the editor it launches.
  The macOS app and VS Code extension set them so the CLI prints plain JSON, and VS Code handed them on to
  every terminal in the window, so tools there (e.g. Claude Code) lost all colour.
- macOS app: clicking a worktree row now shows it was clicked — the row tints blue while pressed and shows
  "Opening…" with a spinner until the open finishes (at least 0.6s so it is visible). Repeat clicks while
  opening are ignored.

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
