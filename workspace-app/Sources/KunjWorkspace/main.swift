import AppKit

// Kunj Workspace: one window listing every worktree and branch container as an environment.
//   --demo               show the mockup's environments (Demo/DemoData.swift) instead of kunj's
//   --screenshot <png>   write a PNG of the window after the first layout and quit
let app = NSApplication.shared
let delegate = AppDelegate(arguments: CommandLine.arguments)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
