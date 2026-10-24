import Foundation

/// What a tab of the left column holds. `editor` tabs are Monaco, not a terminal; the rest are PTYs.
public enum TabKind: String, Codable, CaseIterable, Sendable {
    case shell, agent, action, editor
}

/// How a terminal tab starts its process. `arguments` exclude the program itself; for a login
/// shell they are `["-l"]` and the tab passes `execName` (`-zsh`) itself.
public struct TerminalSpec: Equatable, Sendable {
    public var executable: String
    public var arguments: [String]
    public var cwd: String
    public var environment: [String: String]
    public var title: String
    /// Action tabs close themselves when kunj exits 0 (not `kunj pr`, whose output holds the URL).
    public var closeOnExitZero: Bool

    public init(executable: String, arguments: [String], cwd: String, environment: [String: String],
                title: String, closeOnExitZero: Bool) {
        self.executable = executable
        self.arguments = arguments
        self.cwd = cwd
        self.environment = environment
        self.title = title
        self.closeOnExitZero = closeOnExitZero
    }
}

/// Why a tab cannot start: never a PTY that exits at once.
public enum TerminalSpecError: Error, Equatable, Sendable {
    /// The worktree's directory is gone (`exists == false`).
    case worktreeMissing
    /// The container is not running; start it first.
    case containerStopped(String)
    /// No process for this: a worktree without a path, an `editor` tab, or an empty action.
    case noWorktree

    /// The inline message the terminal column shows.
    public var message: String {
        switch self {
        case .worktreeMissing: return "The worktree directory is missing"
        case .containerStopped: return "Start the container first"
        case .noWorktree: return "There is nothing to run here"
        }
    }
}

/// The process of a `kind` tab in `env`: a worktree shell is `shell -l` in the worktree; a
/// worktree agent `kunj agent <branch>`, a container shell/agent `kunj ct shell|agent <branch>` and
/// an action `kunj <action…>` run through `/usr/bin/env` with the CLI's command parts in the
/// repository root (`cwd` overrides it, for `kunj pr` in a worktree). Every environment is
/// `terminalEnv` cleaned by `ShellEnvironment.terminalEnvironment` with the CLI's login PATH.
/// Shells and agents are refused on a missing worktree or a stopped container; actions are not
/// (`ct start` is how a stopped container starts).
public func terminalSpec(cli: KunjCLI, env: Environment, kind: TabKind, action: [String] = [], shell: String,
                         terminalEnv: [String: String], cwd: String? = nil) throws -> TerminalSpec {
    let environment = ShellEnvironment.terminalEnvironment(path: cli.path, base: terminalEnv)
    func kunj(_ args: [String], title: String, closeOnExitZero: Bool = false) -> TerminalSpec {
        TerminalSpec(executable: "/usr/bin/env", arguments: cli.commandParts + args, cwd: cwd ?? env.repo.root,
                     environment: environment, title: title, closeOnExitZero: closeOnExitZero)
    }

    switch kind {
    case .editor:
        throw TerminalSpecError.noWorktree
    case .action:
        guard !action.isEmpty else { throw TerminalSpecError.noWorktree }
        return kunj(action, title: action.prefix(2).joined(separator: " "), closeOnExitZero: action.first != "pr")
    case .shell, .agent:
        break
    }

    switch env.kind {
    case .worktree:
        guard env.exists, env.state != .missing else { throw TerminalSpecError.worktreeMissing }
        if kind == .agent { return kunj(["agent", env.branch], title: "agent") }
        guard let path = env.path else { throw TerminalSpecError.noWorktree }
        return TerminalSpec(executable: shell, arguments: ["-l"], cwd: cwd ?? path, environment: environment,
                            title: URL(fileURLWithPath: shell).lastPathComponent, closeOnExitZero: false)
    case .container:
        guard env.state == .running else { throw TerminalSpecError.containerStopped(env.branch) }
        return kind == .agent
            ? kunj(["ct", "agent", env.branch], title: "agent")
            : kunj(["ct", "shell", env.branch], title: "shell")
    }
}
