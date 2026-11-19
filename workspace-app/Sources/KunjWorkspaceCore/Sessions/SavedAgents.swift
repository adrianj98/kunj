import Foundation

// Resume Agent…: `kunj agent saved <branch> --json` (AgentSavedJson in src/lib/json-types.ts) lists
// the Claude conversations of a worktree's agent sessions that no longer run (a closed tab, an
// ended session, a reboot); picking one opens an agent tab with `--session <id> --resume`.

public struct SavedAgentsJson: Decodable, Equatable, Sendable {
    public var branch: String
    public var worktree: String
    public var items: [SavedAgent]
}

public struct SavedAgent: Decodable, Equatable, Sendable {
    /// The tmux session the agent ran in
    public var session: String
    /// Its `--session <id>`; nil for the worktree's default agent session
    public var id: String?
    /// Claude Code's session id
    public var conversation: String
    /// ISO 8601
    public var savedAt: String
    /// The first prompt, shortened; nil when the conversation has none yet
    public var title: String?

    public init(session: String, id: String?, conversation: String, savedAt: String, title: String?) {
        self.session = session
        self.id = id
        self.conversation = conversation
        self.savedAt = savedAt
        self.title = title
    }
}

/// `kunj agent saved <branch>` for a worktree; nil for a container (agents there do not save one yet).
public func savedAgentsArguments(_ env: Environment) -> [String]? {
    guard env.kind == .worktree else { return nil }
    return ["agent", "saved", env.branch]
}

/// `kunj agent forget <branch> --all`: empties the list.
public func forgetSavedAgentsArguments(_ env: Environment) -> [String]? {
    guard env.kind == .worktree else { return nil }
    return ["agent", "forget", env.branch, "--all"]
}

/// The menu line: the first prompt (or "New conversation") and how long ago it was saved.
public func savedAgentTitle(_ item: SavedAgent, now: Date = Date()) -> String {
    let title = item.title ?? "New conversation"
    guard let date = parseDate(item.savedAt) else { return title }
    return "\(title)  ·  \(relativeTime(date, now: now))"
}

/// Whether an agent tab's conversation can be resumed: a worktree agent of the default agent
/// command (`kunj agent …`, not `ct agent` nor `--agent antigravity`).
public func canResumeAgent(_ spec: TerminalSpec) -> Bool {
    spec.agent == nil && spec.arguments.contains("agent") && !spec.arguments.contains("ct")
}
