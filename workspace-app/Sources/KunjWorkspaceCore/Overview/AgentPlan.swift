import Foundation

// The Overview window's model: `kunj agent plan --all --json` and `kunj ct agent <branch> --plan --json`
// (AgentPlanJson in src/lib/json-types.ts), which agents the window lists and the text it shows.
// The geometry is in OverviewLayout.swift. Spec: docs/specs/agent-overview.md.

// ---- kunj agent plan --json

public struct AgentPlanJson: Decodable, Equatable, Sendable {
    public var plans: [AgentPlan]
    public init(plans: [AgentPlan]) { self.plans = plans }
}

/// One stop: a task of the agent's task list. `status` is `pending`, `in_progress` or `completed`.
public struct PlanStep: Decodable, Equatable, Sendable {
    public var id: String
    public var subject: String
    public var status: String
    public var startedAt: String?
    public var completedAt: String?

    public init(id: String, subject: String, status: String, startedAt: String? = nil, completedAt: String? = nil) {
        self.id = id; self.subject = subject; self.status = status
        self.startedAt = startedAt; self.completedAt = completedAt
    }

    public var isDone: Bool { status == "completed" }
}

/// Something between two stops. `type` is `branch`, `worktree`, `fork` or `compact`.
public struct PlanMarker: Decodable, Equatable, Sendable {
    public var type: String
    public var afterStep: Int?
    public var from: String?
    public var to: String?
    public var at: String

    public init(type: String, afterStep: Int?, from: String? = nil, to: String? = nil, at: String = "") {
        self.type = type; self.afterStep = afterStep; self.from = from; self.to = to; self.at = at
    }
}

public struct PlanSubagent: Decodable, Equatable, Sendable {
    public var id: String
    public var type: String
    public var task: String?
    public var fromStep: Int?
    public var toStep: Int?
    public var running: Bool
    public var steps: [PlanStep]

    public init(id: String, type: String, task: String?, fromStep: Int?, toStep: Int?, running: Bool, steps: [PlanStep] = []) {
        self.id = id; self.type = type; self.task = task; self.fromStep = fromStep; self.toStep = toStep
        self.running = running; self.steps = steps
    }
}

public struct PlanParent: Decodable, Equatable, Sendable {
    public var session: String
    public var step: Int?
    public init(session: String, step: Int?) { self.session = session; self.step = step }
}

/// One agent session's plan.
public struct AgentPlan: Decodable, Equatable, Sendable {
    public var session: String
    /// The `--session <id>`; nil for the default session
    public var id: String?
    public var branch: String
    public var worktree: String
    public var container: String?
    public var title: String?
    /// nil: tmux could not be asked
    public var running: Bool?
    /// `running`, `waiting` or nil
    public var state: String?
    public var steps: [PlanStep]
    public var current: Int?
    public var markers: [PlanMarker]
    public var subagents: [PlanSubagent]
    public var parent: PlanParent?
    public var updatedAt: String?

    public init(session: String, id: String? = nil, branch: String, worktree: String = "", container: String? = nil,
                title: String? = nil, running: Bool? = true, state: String? = nil, steps: [PlanStep] = [],
                current: Int? = nil, markers: [PlanMarker] = [], subagents: [PlanSubagent] = [],
                parent: PlanParent? = nil, updatedAt: String? = nil) {
        self.session = session; self.id = id; self.branch = branch; self.worktree = worktree
        self.container = container; self.title = title; self.running = running; self.state = state
        self.steps = steps; self.current = current; self.markers = markers; self.subagents = subagents
        self.parent = parent; self.updatedAt = updatedAt
    }

    public var isWaiting: Bool { running != false && state == "waiting" }
}

// ---- arguments

/// Every host agent of the repository kunj runs in.
public func agentPlanArguments() -> [String] { ["agent", "plan", "--all"] }

/// The agents of one branch container; `remote` is the environment's `remoteArguments`.
public func containerAgentPlanArguments(branch: String, remote: [String]) -> [String] {
    ["ct", "agent", branch, "--plan"] + remote
}

// ---- what the window lists

/// One repository's agents, in the order the window shows them.
public struct OverviewRepo: Equatable, Sendable {
    public var name: String
    public var root: String
    public var plans: [AgentPlan]
    public init(name: String, root: String, plans: [AgentPlan]) { self.name = name; self.root = root; self.plans = plans }
}

public enum OverviewFilter: String, CaseIterable, Sendable {
    case all, waiting, running

    public var title: String {
        switch self {
        case .all: return "All"
        case .waiting: return "Waiting"
        case .running: return "Running"
        }
    }

    public func includes(_ plan: AgentPlan) -> Bool {
        switch self {
        case .all: return true
        case .waiting: return plan.isWaiting
        case .running: return !plan.isWaiting
        }
    }
}

/// The agents the window shows: a session that ended is left out (its record stays for
/// `kunj agent plan`), one whose state is unknown (no tmux) is kept.
public func activePlans(_ plans: [AgentPlan]) -> [AgentPlan] {
    plans.filter { $0.running != false }
}

/// An agent with its handed-off children: `lanes[0]` is the root, a child follows its parent.
public struct OverviewFamily: Equatable, Sendable {
    public struct Lane: Equatable, Sendable {
        public var plan: AgentPlan
        /// Index into `lanes` of the lane this one branches off; nil for the root
        public var parent: Int?
        public init(plan: AgentPlan, parent: Int?) { self.plan = plan; self.parent = parent }
    }
    public var lanes: [Lane]
    public init(lanes: [Lane]) { self.lanes = lanes }
}

/// Groups plans into families by `parent.session`. A plan whose parent is not listed (it ended) is a
/// root. Order: roots as given, each followed by its children depth first. A parent cycle (which
/// kunj never writes) is broken by treating its first member as a root.
public func overviewFamilies(_ plans: [AgentPlan]) -> [OverviewFamily] {
    let sessions = Set(plans.map { $0.session })
    var children: [String: [AgentPlan]] = [:]
    var roots: [AgentPlan] = []
    for p in plans {
        if let parent = p.parent?.session, parent != p.session, sessions.contains(parent) {
            children[parent, default: []].append(p)
        } else {
            roots.append(p)
        }
    }
    var placed = Set<String>()
    func add(_ plan: AgentPlan, parent: Int?, into lanes: inout [OverviewFamily.Lane]) {
        guard !placed.contains(plan.session) else { return }
        placed.insert(plan.session)
        lanes.append(OverviewFamily.Lane(plan: plan, parent: parent))
        let index = lanes.count - 1
        for child in children[plan.session] ?? [] { add(child, parent: index, into: &lanes) }
    }
    var families: [OverviewFamily] = []
    for root in roots {
        var lanes: [OverviewFamily.Lane] = []
        add(root, parent: nil, into: &lanes)
        if !lanes.isEmpty { families.append(OverviewFamily(lanes: lanes)) }
    }
    // members of a cycle have no root: each one not yet placed starts a family
    for p in plans where !placed.contains(p.session) {
        var lanes: [OverviewFamily.Lane] = []
        add(p, parent: nil, into: &lanes)
        families.append(OverviewFamily(lanes: lanes))
    }
    return families
}

/// A family is shown when any of its lanes passes the filter, so a child is never drawn without the
/// line it branches from.
public func filterFamilies(_ families: [OverviewFamily], _ filter: OverviewFilter) -> [OverviewFamily] {
    families.filter { $0.lanes.contains { filter.includes($0.plan) } }
}

// ---- text

/// The lane's name: the plan's title, else the branch.
public func planTitle(_ plan: AgentPlan) -> String {
    let t = plan.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return t.isEmpty ? plan.branch : t
}

/// The mono line under the name: "feat/x · worktree", "feat/x · container", "handoff · feat/x",
/// with "agent <id>" added for one of several agents.
public func planPlace(_ plan: AgentPlan, isChild: Bool) -> String {
    let kind = plan.container != nil ? "container" : "worktree"
    let extra = plan.id.map { " · agent \($0)" } ?? ""
    return isChild ? "handoff · \(plan.branch)\(extra)" : "\(plan.branch) · \(kind)\(extra)"
}

/// "Waiting for input", "Step 3 of 5", "All 5 steps done", "Working" (no task list).
public func planStatus(_ plan: AgentPlan) -> String {
    if plan.isWaiting { return "Waiting for input" }
    let n = plan.steps.count
    if n == 0 { return "Working" }
    guard let current = plan.current, current < n else { return "All \(n) step\(n == 1 ? "" : "s") done" }
    return "Step \(current + 1) of \(n)"
}

/// "7 agents · 2 waiting for you", "1 agent", "No agents running".
public func overviewSummary(_ repos: [OverviewRepo]) -> String {
    let plans = repos.flatMap { $0.plans }
    if plans.isEmpty { return "No agents running" }
    let waiting = plans.filter { $0.isWaiting }.count
    let base = "\(plans.count) agent\(plans.count == 1 ? "" : "s")"
    return waiting == 0 ? base : "\(base) · \(waiting) waiting for you"
}

/// A marker's label: "main → feat/x" for a branch, the folders for a worktree, "fork" for a copy.
/// nil for a marker the window does not draw (`compact`, or a type this build does not know).
public func markerLabel(_ marker: PlanMarker) -> String? {
    switch marker.type {
    case "branch":
        return "\(marker.from ?? "?") → \(marker.to ?? "?")"
    case "worktree":
        func folder(_ path: String?) -> String {
            guard let path, !path.isEmpty else { return "?" }
            return (path as NSString).lastPathComponent
        }
        return "\(folder(marker.from)) → \(folder(marker.to))"
    case "fork":
        return "fork"
    default:
        return nil
    }
}

/// "subagent · write the tests", with " · done" once it ended.
public func subagentLabel(_ sub: PlanSubagent) -> String {
    let task = sub.task?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return "subagent · \(task.isEmpty ? sub.type : task)\(sub.running ? "" : " · done")"
}
