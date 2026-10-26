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
    /// A shell tab's tmux session id (`kunj worktree shell|ct shell --session`): saved with the tab
    /// so a relaunch reattaches it, and ended (`--kill`) when the tab is closed.
    public var session: String?
    /// An agent tab's `kunj agent --agent` name (`antigravity`); nil for the default agent.
    public var agent: String?

    public init(executable: String, arguments: [String], cwd: String, environment: [String: String],
                title: String, closeOnExitZero: Bool, session: String? = nil, agent: String? = nil) {
        self.executable = executable
        self.arguments = arguments
        self.cwd = cwd
        self.environment = environment
        self.title = title
        self.closeOnExitZero = closeOnExitZero
        self.session = session
        self.agent = agent
    }
}

/// The agents an agent tab can run besides the default (`agent.command`): `kunj agent --agent <name>`.
public enum AgentChoice: String, CaseIterable, Sendable {
    case antigravity

    /// The tab's title and the menu's name.
    public var title: String {
        switch self {
        case .antigravity: return "antigravity"
        }
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
    /// A named agent (`--agent`) in a container: `kunj ct agent` runs only `container.agentCommand`.
    case agentNotInContainer

    /// The inline message the terminal column shows.
    public var message: String {
        switch self {
        case .worktreeMissing: return "The worktree directory is missing"
        case .containerStopped: return "Start the container first"
        case .noWorktree: return "There is nothing to run here"
        case .agentNotInContainer: return "Only the default agent runs in a container"
        }
    }
}

/// The process of a `kind` tab in `env`: a worktree shell is `shell -l` in the worktree; a
/// worktree agent `kunj agent <branch>`, a container shell/agent `kunj ct shell|agent <branch>` and
/// an action `kunj <action…>` run through `/usr/bin/env` with the CLI's command parts in the
/// repository root (`cwd` overrides it, for `kunj pr` in a worktree). Every environment is
/// `terminalEnv` cleaned by `ShellEnvironment.terminalEnvironment` with the CLI's login PATH.
/// Shells and agents are refused on a missing worktree or a stopped container; actions are not
/// (`ct start` is how a stopped container starts). A shell with a `session` id runs through kunj
/// (`kunj worktree shell <branch> --session <id>`, `kunj ct shell <branch> --session <id>`), which
/// keeps it in a tmux session when tmux is there, so it outlives the app. An `agent` name runs
/// `kunj agent <branch> --agent <name>`, in worktrees only.
public func terminalSpec(cli: KunjCLI, env: Environment, kind: TabKind, action: [String] = [], shell: String,
                         terminalEnv: [String: String], cwd: String? = nil, session: String? = nil,
                         agent: AgentChoice? = nil) throws -> TerminalSpec {
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
        if kind == .agent {
            var s = kunj(["agent", env.branch] + (session.map { ["--session", $0] } ?? [])
                         + (agent.map { ["--agent", $0.rawValue] } ?? []), title: agent?.title ?? "agent")
            s.session = session
            s.agent = agent?.rawValue
            return s
        }
        guard let path = env.path else { throw TerminalSpecError.noWorktree }
        if let session {
            var s = kunj(["worktree", "shell", env.branch, "--session", session],
                         title: URL(fileURLWithPath: shell).lastPathComponent)
            s.session = session
            return s
        }
        return TerminalSpec(executable: shell, arguments: ["-l"], cwd: cwd ?? path, environment: environment,
                            title: URL(fileURLWithPath: shell).lastPathComponent, closeOnExitZero: false)
    case .container:
        if kind == .agent, agent != nil { throw TerminalSpecError.agentNotInContainer }
        guard env.state == .running else { throw TerminalSpecError.containerStopped(env.branch) }
        var s = kunj(["ct", kind == .agent ? "agent" : "shell", env.branch] + (session.map { ["--session", $0] } ?? []),
                     title: kind == .agent ? "agent" : "shell")
        s.session = session
        return s
    }
}

/// The kunj arguments that end a shell or agent tab's tmux session (the tab was closed, not the
/// app quit).
public func sessionKillArguments(env: Environment, kind: TabKind, session: String) -> [String] {
    switch (env.kind, kind) {
    case (.worktree, .agent): return ["agent", "stop", env.branch, "--session", session]
    case (.container, .agent): return ["ct", "agent", env.branch, "--kill", "--session", session]
    case (.worktree, _): return ["worktree", "shell", env.branch, "--session", session, "--kill"]
    case (.container, _): return ["ct", "shell", env.branch, "--session", session, "--kill"]
    }
}

/// Closing an environment ends every shell and agent session of its branch, the ones started
/// outside the app too.
public func closeEnvironmentArguments(env: Environment) -> [[String]] {
    env.kind == .worktree
        ? [["worktree", "shell", env.branch, "--kill"], ["agent", "stop", env.branch, "--all"]]
        : [["ct", "shell", env.branch, "--kill"], ["ct", "agent", env.branch, "--kill"]]
}

/// A new shell or agent tab's session id: 8 lowercase hex characters.
public func newTabSession() -> String {
    String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)).lowercased()
}

/// The exit code of a waitpid status (SwiftTerm's forkpty path reports the raw status, so `exit 1`
/// arrives as 256): the code for a normal exit, 128 + the signal for a killed process, as a shell
/// reports it.
public func exitCode(waitStatus: Int32) -> Int32 {
    let signal = waitStatus & 0x7f
    return signal == 0 ? (waitStatus >> 8) & 0xff : 128 + signal
}

/// The tab bar's dot for a tab: a live agent tab is amber while its environment waits for input,
/// green otherwise; a live action tab (a long kunj command) is green; anything else has none.
public func tabDot(kind: TabKind, running: Bool, agent: AgentActivity) -> DotColor? {
    guard running else { return nil }
    switch kind {
    case .agent: return agent == .waiting ? .amber : .green
    case .action: return .green
    case .shell, .editor: return nil
    }
}
