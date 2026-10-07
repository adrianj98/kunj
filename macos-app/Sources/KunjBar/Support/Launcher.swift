// Opens things outside the app: terminals, Finder, the browser, and scripts
// that need a terminal (`kunj pr` is interactive).

import AppKit

enum Launcher {
    static let terminalApps = ["Terminal", "iTerm", "Ghostty", "Warp", "WezTerm", "kitty", "Alacritty"]

    static func openTerminal(at path: String) {
        let app = UserDefaults.standard.kunjTerminalApp
        run("/usr/bin/open", ["-a", app, path])
    }

    // Run a command in a new terminal window via a temporary .command file,
    // which Terminal and iTerm execute when opened. The shell stays open
    // afterwards so the output can be read.
    static func runInTerminal(_ command: String, cwd: String, title: String) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kunjbar", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(title.replacingOccurrences(of: "/", with: "-"))-\(UUID().uuidString.prefix(8)).command")
        let script = """
        #!/bin/zsh -l
        export PATH=\(shellQuote(ShellEnvironment.path))
        cd \(shellQuote(cwd)) || exit 1
        \(command)
        rm -f \(shellQuote(file.path))
        exec "${SHELL:-/bin/zsh}" -l
        """
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        } catch {
            return
        }
        let app = UserDefaults.standard.kunjTerminalApp
        run("/usr/bin/open", ["-a", app, file.path])
    }

    static func revealInFinder(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    static func openURL(_ string: String) {
        if let url = URL(string: string) { NSWorkspace.shared.open(url) }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private static func run(_ executable: String, _ args: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        try? process.run()
    }
}
