import Foundation

public enum EnvironmentKind: String, Codable, Sendable {
    case worktree, container
}

/// What the environment's agent is doing. `unknown` when kunj could not tell (no tmux).
public enum AgentActivity: Equatable, Sendable {
    case none, running, waiting, unknown
}

/// The sidebar's status dot: amber waiting for input, green agent running, idle otherwise.
public enum DotColor: Equatable, Sendable {
    case green, amber, idle
}

/// `running`/`stopped` for a container, `ok`/`missing` for a worktree.
public enum EnvState: Equatable, Sendable {
    case running, stopped, ok, missing
}

public struct PortInfo: Equatable, Sendable {
    public var container: Int
    public var host: Int
    /// `publish` or `forward`
    public var kind: String
    public var service: String?

    public init(container: Int, host: Int, kind: String, service: String?) {
        self.container = container
        self.host = host
        self.kind = kind
        self.service = service
    }
}

public struct RepoRef: Equatable, Hashable, Sendable {
    public var name: String
    /// What every kunj call runs in: the repository's root (the git dir for a bare repo).
    public var root: String
    public var bare: Bool

    public init(name: String, root: String, bare: Bool) {
        self.name = name
        self.root = root
        self.bare = bare
    }
}

/// `"<repo>|<kind>|<branch>"`: a worktree and a container on one branch are two environments, and
/// a branch may contain `/`, so the branch is last and the id is never split on it.
public func environmentId(repo: String, kind: EnvironmentKind, branch: String) -> String {
    "\(repo)|\(kind.rawValue)|\(branch)"
}

/// An agent's `state` counts only while it runs: a crashed agent never fires SessionEnd and leaves
/// its last state behind.
public func agentActivity(running: Bool?, state: String?) -> AgentActivity {
    switch running {
    case .none: return .unknown
    case .some(false): return .none
    case .some(true): return state == "waiting" ? .waiting : .running
    }
}

/// One row of the sidebar: a worktree or a branch container of a repository.
public struct Environment: Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: EnvironmentKind
    public var repo: RepoRef
    public var branch: String
    /// The worktree's path (nil for a container)
    public var path: String?
    public var containerName: String?
    public var state: EnvState
    public var agent: AgentActivity
    /// The host tmux session of `kunj agent` (worktrees only)
    public var agentSession: String?
    public var dirty: Bool?
    public var changedFiles: Int?
    public var ahead: Int?
    public var behind: Int?
    public var upstream: String?
    public var pullRequest: PullRequestInfo?
    public var ports: [PortInfo]
    public var services: [ServiceState]
    public var createdAt: Date?
    public var exists: Bool
    public var isMain: Bool

    public init(id: String, kind: EnvironmentKind, repo: RepoRef, branch: String, path: String?,
                containerName: String?, state: EnvState, agent: AgentActivity, agentSession: String?,
                dirty: Bool?, changedFiles: Int?, ahead: Int?, behind: Int?, upstream: String?,
                pullRequest: PullRequestInfo?, ports: [PortInfo], services: [ServiceState], createdAt: Date?,
                exists: Bool, isMain: Bool) {
        self.id = id
        self.kind = kind
        self.repo = repo
        self.branch = branch
        self.path = path
        self.containerName = containerName
        self.state = state
        self.agent = agent
        self.agentSession = agentSession
        self.dirty = dirty
        self.changedFiles = changedFiles
        self.ahead = ahead
        self.behind = behind
        self.upstream = upstream
        self.pullRequest = pullRequest
        self.ports = ports
        self.services = services
        self.createdAt = createdAt
        self.exists = exists
        self.isMain = isMain
    }

    public static func environmentId(repo: String, kind: EnvironmentKind, branch: String) -> String {
        KunjWorkspaceCore.environmentId(repo: repo, kind: kind, branch: branch)
    }

    /// The sidebar's status verb, first match wins: missing worktree, stopped container, agent
    /// waiting, agent running, PR merged, PR open, dirty, ahead, clean.
    public var statusVerb: String {
        if state == .missing { return "Missing" }
        if state == .stopped { return "Stopped" }
        if agent == .waiting { return "Waiting for input" }
        if agent == .running { return "Running" }
        if let pr = pullRequest {
            if pr.state == "merged" { return "Merged #\(pr.number)" }
            if pr.state == "open" { return "PR #\(pr.number) \(pr.draft ? "draft" : "open")" }
        }
        if dirty == true {
            // a container reports dirty without a count
            guard let n = changedFiles, n > 0 else { return "Changed files" }
            return n == 1 ? "1 changed file" : "\(n) changed files"
        }
        if let ahead, ahead > 0 { return "↑\(ahead) unpushed" }
        return "Clean"
    }

    public var dot: DotColor {
        switch agent {
        case .waiting: return .amber
        case .running: return .green
        case .none, .unknown: return .idle
        }
    }

    /// The header's mono meta line: `repo / branch`, kind, ahead/behind, PR, ports (empty parts left out).
    public var metaLine: [String] {
        var parts = ["\(repo.name) / \(branch)", kind.rawValue]
        var counts: [String] = []
        if let ahead, ahead > 0 { counts.append("↑\(ahead)") }
        if let behind, behind > 0 { counts.append("↓\(behind)") }
        if !counts.isEmpty {
            parts.append(counts.joined(separator: " ") + (upstream.map { " from \($0)" } ?? ""))
        }
        if let pr = pullRequest {
            let state = pr.state == "open" && pr.draft ? "draft" : pr.state
            var s = "#\(pr.number) \(state)"
            if pr.state == "open" {
                switch pr.checks {
                case "success": s += " ✓"
                case "failure": s += " ✗"
                case "pending": s += " …"
                default: break
                }
            }
            parts.append(s)
        }
        parts += ports.map { ":\($0.host)" }
        return parts
    }
}
