import Foundation

// The Overview window's model: `kunj agent overview --containers --json` (AgentOverviewJson in
// src/lib/json-types.ts). kunj decides which agents are shown, how they group, their text and every
// position (src/lib/agent-overview.ts); the app decodes that, filters families and strokes them.
// Nothing about the layout belongs here. Spec: docs/specs/agent-overview.md.
//
// Coordinates are in points, y down. Inside a family, x is measured from the right edge of the label
// column (`metrics.labelWidth` wide) and y from the family's top.

public struct AgentOverviewJson: Decodable, Equatable, Sendable {
    public struct Repo: Decodable, Equatable, Sendable {
        public var name: String
        public var root: String
    }
    public struct Metrics: Decodable, Equatable, Sendable {
        public var labelWidth: Double
        public var stopSpacing: Double
    }
    public struct Containers: Decodable, Equatable, Sendable {
        public var available: Bool
        public var message: String?
        /// Branches whose running container has an agent that could not be read
        public var unreadable: [String]?
    }

    public var repo: Repo
    public var agents: Int
    public var waiting: Int
    public var summary: String
    public var metrics: Metrics
    public var families: [OverviewFamily]
    /// Whether the repository's branch containers could be asked for their agents
    public var containers: Containers?
}

/// An agent with the agents it handed work to: `lanes[0]` is the root.
public struct OverviewFamily: Decodable, Equatable, Sendable {
    public var width: Double
    public var height: Double
    public var lanes: [OverviewLane]
}

public struct OverviewLane: Decodable, Equatable, Sendable {
    public var session: String
    /// The `--session <id>`; nil for the default session
    public var id: String?
    public var branch: String
    public var worktree: String
    public var container: String?
    /// The label column's three lines
    public var title: String
    public var place: String
    public var status: String
    public var waiting: Bool
    /// A handed-off agent: indented under the lane it branches from
    public var child: Bool
    public var top: Double
    public var height: Double
    /// y of the line
    public var y: Double
    public var stops: [OverviewStop]
    public var line: OverviewLine?
    public var loops: [OverviewLoop]
    public var markers: [OverviewMarker]
    public var elbow: OverviewElbow?
    /// No task list: the one stop's label goes right of it
    public var labelBeside: Bool
}

public enum OverviewStopKind: Equatable, Sendable {
    case done, current, todo
}

public struct OverviewStop: Decodable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// `done`, `current` or `todo`
    public var kind: String
    public var label: String

    /// A kind a newer kunj adds is drawn as a step to come.
    public var stopKind: OverviewStopKind {
        switch kind {
        case "done": return .done
        case "current": return .current
        default: return .todo
        }
    }
}

/// The line between a lane's first and last stop, drawn as done up to `doneToX` (nil: none of it).
public struct OverviewLine: Decodable, Equatable, Sendable {
    public var fromX: Double
    public var toX: Double
    public var doneToX: Double?
}

/// A subagent: a loop that leaves the line at `fromX`, runs along `y` and rejoins at `toX`.
public struct OverviewLoop: Decodable, Equatable, Sendable {
    public var fromX: Double
    public var toX: Double
    public var lineY: Double
    public var y: Double
    public var running: Bool
    public var doneToX: Double
    public var stops: [OverviewStop]
    public var label: String
}

/// A branch or worktree change: a diamond on the line, its label at `labelY`.
public struct OverviewMarker: Decodable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var labelY: Double
    public var label: String
}

/// From the parent's stop down to a child's line.
public struct OverviewElbow: Decodable, Equatable, Sendable {
    public var fromX: Double
    public var fromY: Double
    public var toX: Double
    public var toY: Double
}

// ---- arguments

/// The running agents of the repository kunj runs in, its branch containers' included.
public func agentOverviewArguments() -> [String] { ["agent", "overview", "--containers"] }

// ---- what the window does itself: the filter, the total, and which lane a click is on

public enum OverviewFilter: String, CaseIterable, Sendable {
    case all, waiting, running

    public var title: String {
        switch self {
        case .all: return "All"
        case .waiting: return "Waiting"
        case .running: return "Running"
        }
    }

    public func includes(_ lane: OverviewLane) -> Bool {
        switch self {
        case .all: return true
        case .waiting: return lane.waiting
        case .running: return !lane.waiting
        }
    }
}

/// A family is shown when any of its lanes passes the filter, so a child is never drawn without the
/// line it branches from.
public func filterFamilies(_ families: [OverviewFamily], _ filter: OverviewFilter) -> [OverviewFamily] {
    families.filter { $0.lanes.contains { filter.includes($0) } }
}

/// The window's one line over several repositories: kunj's own summary for one, the totals for more.
public func overviewSummary(_ repos: [AgentOverviewJson]) -> String {
    if repos.count == 1 { return repos[0].summary }
    let agents = repos.reduce(0) { $0 + $1.agents }
    let waiting = repos.reduce(0) { $0 + $1.waiting }
    if agents == 0 { return "No agents running" }
    let base = "\(agents) agent\(agents == 1 ? "" : "s")"
    return waiting == 0 ? base : "\(base) · \(waiting) waiting for you"
}

/// The lane at `y` (from the family's top), for a click.
public func laneIndex(at y: Double, in family: OverviewFamily) -> Int? {
    family.lanes.firstIndex { y >= $0.top && y < $0.top + $0.height }
}

// ---- which repositories the Overview asks (its drop-down)

/// The Overview's repository drop-down: the repositories with an open session (the default), every
/// listed repository, or one.
public enum OverviewScope: Equatable, Sendable {
    case open, all
    case repo(String)
}

/// The repositories to ask for `scope`, in the listing's order. `open` is the roots of the
/// repositories with an open session (a tab, or tabs saved from an earlier run). A single repository
/// no longer listed asks none.
public func overviewRepos(_ repos: [RepoRef], open: Set<String>, scope: OverviewScope) -> [RepoRef] {
    switch scope {
    case .open: return repos.filter { open.contains($0.root) }
    case .all: return repos
    case .repo(let root): return repos.filter { $0.root == root }
    }
}

/// The drop-down's title for `scope`.
public func overviewScopeTitle(_ scope: OverviewScope, repos: [RepoRef], open: Set<String>) -> String {
    switch scope {
    case .open:
        let n = repos.filter { open.contains($0.root) }.count
        return "Open sessions (\(n) repositor\(n == 1 ? "y" : "ies"))"
    case .all: return "All repositories"
    case .repo(let root): return repos.first { $0.root == root }?.name ?? "Repository"
    }
}
