import Foundation

/// The user's shell environment. Apps launched from Finder get a minimal PATH, and kunj is a
/// `#!/usr/bin/env node` script, so kunj, node, tmux and claude must be found on the PATH a
/// login + interactive shell builds (nvm, Homebrew, … from .zprofile/.zshrc), as macos-app does.
public enum ShellEnvironment {
    /// Appended to every resolved PATH, and the whole PATH when the shell gives nothing.
    public static let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    private static let marker = "__KUNJ_PATH__"

    /// The resolved PATH and whether the interactive login shell ran past its cap.
    public struct LoginPath: Equatable, Sendable {
        public let path: String
        public let timedOut: Bool
        public init(path: String, timedOut: Bool) {
            self.path = path
            self.timedOut = timedOut
        }
    }

    /// PATH from `$SHELL -l -i -c 'printf …'`, the marker separating it from whatever the
    /// profile prints; capped at `timeout` so a slow or hanging profile cannot stall the app.
    /// Call it once, off the main thread.
    public static func loginPath(timeout: TimeInterval = 5) async -> String {
        await resolveLoginPath(timeout: timeout).path
    }

    /// `loginPath(timeout:)` with an explicit shell (tests use a script that never finishes).
    public static func loginPath(timeout: TimeInterval, shell: String) async -> String {
        await resolveLoginPath(timeout: timeout, shell: shell).path
    }

    /// `loginPath` that also says whether the interactive shell timed out. Then it asks a login
    /// shell that is not interactive (`-l -c`: .zprofile but not .zshrc), with the same cap:
    /// launched from Finder, a .zshrc that touches a protected folder (~/Downloads, ~/Documents)
    /// can wait on a privacy prompt for longer than the cap, while Homebrew's PATH is usually set
    /// in .zprofile.
    public static func resolveLoginPath(
        timeout: TimeInterval = 5,
        shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    ) async -> LoginPath {
        switch await shellPath(shell: shell, flags: ["-l", "-i"], timeout: timeout) {
        case .some(let path?): return LoginPath(path: path, timedOut: false)
        case .some(nil): return LoginPath(path: fallbackPath, timedOut: false)
        case nil:
            let path = await shellPath(shell: shell, flags: ["-l"], timeout: timeout) ?? nil
            return LoginPath(path: path ?? fallbackPath, timedOut: true)
        }
    }

    /// nil when the shell timed out, `.some(nil)` when it gave no PATH, else PATH + fallback.
    private static func shellPath(shell: String, flags: [String], timeout: TimeInterval) async -> String?? {
        let output = try? await runProcess(
            executable: shell,
            arguments: flags + ["-c", "printf '\(marker)%s\(marker)' \"$PATH\""],
            cwd: NSHomeDirectory(), environment: ProcessInfo.processInfo.environment,
            stdin: nil, timeout: timeout, drainGrace: 0.5)
        guard let output else { return .some(nil) }
        if output.timedOut { return nil }
        let parts = String(decoding: output.stdout, as: UTF8.self).components(separatedBy: marker)
        guard parts.count >= 3, !parts[1].isEmpty else { return .some(nil) }
        return .some(parts[1] + ":" + fallbackPath)
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

/// The line under the window's discovery error when kunj was not found after the login shell
/// timed out: why the PATH may be short and where to set the command instead; nil otherwise.
public func discoveryErrorDetail(_ error: KunjCLIError, loginPath: ShellEnvironment.LoginPath) -> String? {
    guard error.code == .notFound, loginPath.timedOut else { return nil }
    return "Your login shell did not start in time, so the PATH was \(loginPath.path). "
        + "Set the full kunj command in Settings (⌘,)."
}
