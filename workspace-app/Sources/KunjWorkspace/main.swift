import AppKit

// Kunj Workspace: one window listing every worktree and branch container as an environment.
//   --screenshot <png>   write a PNG of the window after the first layout and quit
let app = NSApplication.shared
let delegate = AppDelegate(arguments: CommandLine.arguments)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
