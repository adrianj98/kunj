# Kunj for the macOS menu bar

A menu bar app with the features of the [VS Code extension](../vscode-extension/README.md), for every
repository kunj knows about rather than one editor window:

- Worktrees of every repository, one section each, with uncommitted changes, ahead/behind, which
  editor windows have them open, and their pull request (state, checks, review)
- Click a worktree to open it in your editor (`worktree.editorCommand`, default `code`; an already
  open VS Code window is focused). Hover for new window, terminal and remove buttons; right-click for
  the rest: open/copy the pull request, create one (`kunj pr` in a terminal), reveal in Finder, copy
  the path or branch
- New Worktree window: check out an existing branch or create one from the repository default
  (fetched from origin) or any base
- Remove with the same force confirmation as the extension, prune stale worktrees
- Notifications when a pull request's checks fail or pass, or it is approved or merged; failing
  checks count in the menu bar
- Filter field and an **Open only** toggle (just the worktrees open in an editor), launch at login, settings for the CLI path, refresh interval and terminal app

Everything goes through the kunj CLI (`kunj ... --json`); the app never runs git itself.

## Which repositories are shown

`kunj repos`: every repository kunj has run in, including any folder an editor with the kunj VS Code
extension has open. Add others with **Add Repository…** in the ⚙ menu (or `kunj repos add <path>`),
and hide one with **Remove from List** in its ⋯ menu (or `kunj repos remove <path>`).

## Install from a release

```bash
kunj install macos
```

downloads the app from the newest release, installs it to /Applications (or ~/Applications), clears
the quarantine and launches it. Run it again to update.

By hand: each [GitHub release](https://github.com/adrianj98/kunj/releases) has `Kunj-macos-<version>.zip`. Unzip it,
move `Kunj.app` to /Applications and, because the app is not signed or notarized, clear the quarantine
before the first launch:

```bash
xattr -dr com.apple.quarantine /Applications/Kunj.app
```

## Build and install

Requires macOS 14, the Swift toolchain (Xcode or the Command Line Tools) and the kunj CLI on your
shell's `PATH` (`npm install -g kunj`, or set the command in Settings, e.g.
`node /path/to/kunj/dist/index.js`).

```bash
cd macos-app
scripts/bundle.sh            # builds build/Kunj.app (universal, ad-hoc signed)
scripts/bundle.sh --install  # also copies it to /Applications and launches it
```

The app is not notarized. If macOS refuses to open it, right-click it and choose **Open**, or run
`xattr -dr com.apple.quarantine /Applications/Kunj.app`.

For development, `swift build` and run `.build/debug/KunjBar` (notifications need the bundled app).
