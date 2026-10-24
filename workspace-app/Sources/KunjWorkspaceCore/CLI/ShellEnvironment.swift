import Foundation

/// The user's shell environment. Apps launched from Finder get a minimal PATH, and kunj is a
/// `#!/usr/bin/env node` script, so kunj, node, tmux and claude must be found on the PATH a
/// login + interactive shell builds (nvm, Homebrew, … from .zprofile/.zshrc), as macos-app does.
public enum ShellEnvironment {
    /// Appended to every resolved PATH, and the whole PATH when the shell gives nothing.
    public static let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    private static let marker = "__KUNJ_PATH__"

    /// PATH from `$SHELL -l -i -c 'printf …'`, the marker separating it from whatever the
    /// profile prints; capped at `timeout` so a slow or hanging profile cannot stall the app.
    /// Call it once, off the main thread.
    public static func loginPath(timeout: TimeInterval = 5) async -> String {
        await loginPath(timeout: timeout, shell: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
    }

    /// `loginPath(timeout:)` with an explicit shell (tests use a script that never finishes).
    public static func loginPath(timeout: TimeInterval, shell: String) async -> String {
        let output = try? await runProcess(
            executable: shell,
            arguments: ["-l", "-i", "-c", "printf '\(marker)%s\(marker)' \"$PATH\""],
            cwd: NSHomeDirectory(), environment: ProcessInfo.processInfo.environment,
            stdin: nil, timeout: timeout, drainGrace: 0.5)
        guard let output, !output.timedOut else { return fallbackPath }
        let parts = String(decoding: output.stdout, as: UTF8.self).components(separatedBy: marker)
        guard parts.count >= 3, !parts[1].isEmpty else { return fallbackPath }
        return parts[1] + ":" + fallbackPath
    }

    /// The environment of every child the app starts (PTYs and kunj calls): `base` (the app's own
    /// environment) with PATH from the login shell, `TERM=xterm-256color`, `COLORTERM=truecolor`,
    /// `LANG` kept or `en_US.UTF-8`, and the colour overrides, terminal-program and Claude Code
    /// markers removed (a `claude` started under them would think it runs inside another one).
    public static func terminalEnvironment(
        path: String, base: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var env = base.filter { key, _ in
            !(key == "NO_COLOR" || key == "FORCE_COLOR" || key == "TERM_SESSION_ID"
                || key.hasPrefix("TERM_PROGRAM") || key.hasPrefix("CLAUDECODE") || key.hasPrefix("CLAUDE_CODE"))
        }
        env["PATH"] = path
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        if (env["LANG"] ?? "").isEmpty { env["LANG"] = "en_US.UTF-8" }
        return env
    }
}
