# Applications

Consumers of the CLI's JSON contract, and the documentation site. Each is a separate package in the repository.

# Concepts

* [VS Code Extension (Kunj Worktrees)](/apps/vscode-extension.md) - A VS Code extension that shows the repository's git worktrees and branch containers in a tree view and drives every action through the kunj CLI's JSON output.
* [macOS Menu Bar App (Kunj.app)](/apps/macos-app.md) - A SwiftUI menu bar app that lists the worktrees and branch containers of every repository kunj knows, opens them, notifies on pull request changes and organizes editor and terminal windows across desktops.
* [Workspace App (Kunj Workspace.app)](/apps/workspace-app.md) - A native macOS app that shows every worktree and branch container as an environment with its own terminals, agent tabs, Changes diff and editor tabs, all driven through kunj's JSON commands.
* [Docs Site and Landing Page](/apps/docs-site.md) - The Astro Starlight user documentation in docs-site/ and the static landing page in site/, published together to GitHub Pages under /kunj/.
