import Foundation

// The Sessions window's model: `kunj sessions list --json` (SessionsJson in src/lib/json-types.ts),
// the `kill` arguments, and the text the table shows.

// ---- kunj sessions list --json

public struct SessionsJson: Decodable, Equatable, Sendable {
    /// `ok`, `missing` or `failed`
    public var tmux: String
    public var idleHours: Double
    public var sessions: [TmuxSession]
    public var containers: SessionsContainers?
}

public struct TmuxSession: Decodable, Equatable, Sendable {
    public var name: String
    /// `agent` or `shell`
    public var kind: String
    public var id: String?
    public var repo: SessionRepo?
    public var worktree: SessionWorktree?
    public var branch: String?
    public var container: String?
    public var command: String?
    public var cwd: String?
    public var createdAt: String?
    public var lastActivityAt: String?
    public var attached: [SessionAttach]
    public var usage: SessionUsage?
    /// `worktree-gone`, `idle` or nil
    public var orphan: String?

    public init(name: String, kind: String, id: String? = nil, repo: SessionRepo? = nil, worktree: SessionWorktree? = nil,
                branch: String? = nil, container: String? = nil, command: String? = nil, cwd: String? = nil,
                createdAt: String? = nil, lastActivityAt: String? = nil, attached: [SessionAttach] = [],
                usage: SessionUsage? = nil, orphan: String? = nil) {
        self.name = name; self.kind = kind; self.id = id; self.repo = repo; self.worktree = worktree
        self.branch = branch; self.container = container; self.command = command; self.cwd = cwd
        self.createdAt = createdAt; self.lastActivityAt = lastActivityAt; self.attached = attached
        self.usage = usage; self.orphan = orphan
    }
}

public struct SessionRepo: Decodable, Equatable, Sendable {
    public var name: String
    public var root: String
    public init(name: String, root: String) { self.name = name; self.root = root }
}

public struct SessionWorktree: Decodable, Equatable, Sendable {
    public var path: String
    public var branch: String?
    public init(path: String, branch: String?) { self.path = path; self.branch = branch }
}

public struct SessionAttach: Decodable, Equatable, Sendable {
    public var tty: String
    public var pid: Int
    public var via: String?
    public init(tty: String, pid: Int, via: String?) { self.tty = tty; self.pid = pid; self.via = via }
}

public struct SessionUsage: Decodable, Equatable, Sendable {
    /// ps's percentage: 100 is one core
    public var cpu: Double
    public var memoryBytes: Double
    public init(cpu: Double, memoryBytes: Double) { self.cpu = cpu; self.memoryBytes = memoryBytes }
}

public struct SessionsContainers: Decodable, Equatable, Sendable {
    public var available: Bool
    public var message: String?
    public var items: [SessionsContainerItem]
}

public struct SessionsContainerItem: Decodable, Equatable, Sendable {
    public var container: String
    public var repo: String?
    public var branch: String?
    public var tmux: String
    public var count: Int
}

/// `kunj sessions kill --json`
public struct SessionsKillJson: Decodable, Equatable, Sendable {
    public var killed: [String]
    public var failed: [SessionsKillFailure]
}

public struct SessionsKillFailure: Decodable, Equatable, Sendable {
    public var name: String
    public var container: String?
    public var error: String
}

// ---- arguments

public func sessionsListArguments(containers: Bool) -> [String] {
    ["sessions", "list"] + (containers ? ["--containers"] : [])
}

/// One `kill` per container, host sessions together: `kunj sessions kill <names…> [--container <c>]`.
/// `ifDetached` (End Orphans) leaves a session running when a terminal attached to it since the listing.
public func sessionsKillArguments(_ sessions: [TmuxSession], ifDetached: Bool = false) -> [[String]] {
    var host: [String] = []
    var byContainer: [String: [String]] = [:]
    var order: [String] = []
    for s in sessions {
        if let c = s.container {
            if byContainer[c] == nil { order.append(c) }
            byContainer[c, default: []].append(s.name)
        } else {
            host.append(s.name)
        }
    }
    let flag = ifDetached ? ["--if-detached"] : []
    var out: [[String]] = []
    if !host.isEmpty { out.append(["sessions", "kill"] + host + flag) }
    for c in order { out.append(["sessions", "kill"] + byContainer[c]! + ["--container", c] + flag) }
    return out
}

// ---- what the table shows

/// Which sessions the window lists.
public enum SessionsFilter: String, CaseIterable, Sendable {
    case all, orphans, detached

    public var title: String {
        switch self {
        case .all: return "All"
        case .orphans: return "Orphans"
        case .detached: return "Detached"
        }
    }

    public func includes(_ s: TmuxSession, tabbed: Bool) -> Bool {
        switch self {
        case .all: return true
        case .orphans: return s.orphan != nil && !tabbed
        case .detached: return s.attached.isEmpty
        }
    }
}

/// Where a session belongs: "repo · branch", "repo · container branch", or "repo · worktree removed".
public func sessionPlace(_ s: TmuxSession) -> String {
    let repo = s.repo?.name ?? "?"
    if s.container != nil { return "\(repo) · \(s.branch ?? "?") (container)" }
    if let wt = s.worktree { return "\(repo) · \(wt.branch ?? (wt.path as NSString).lastPathComponent)" }
    return "\(repo) · worktree removed"
}

/// "Kunj Workspace", "Terminal, /dev/ttys004", or "—" when nothing is attached.
public func sessionAttachedText(_ s: TmuxSession) -> String {
    if s.attached.isEmpty { return "—" }
    return s.attached.map { $0.via ?? $0.tty }.joined(separator: ", ")
}

public func sessionStatusText(_ s: TmuxSession, tabbed: Bool) -> String {
    switch s.orphan {
    case "worktree-gone": return "Orphan: worktree removed"
    case "idle": return tabbed ? "Idle (tab open)" : "Orphan: idle"
    default: return tabbed ? "Tab open" : (s.attached.isEmpty ? "Detached" : "Attached")
    }
}

public func formatCPU(_ usage: SessionUsage?) -> String {
    guard let u = usage else { return "—" }
    return u.cpu >= 10 ? String(format: "%.0f%%", u.cpu) : String(format: "%.1f%%", u.cpu)
}

public func formatMemory(_ usage: SessionUsage?) -> String {
    guard let b = usage?.memoryBytes else { return "—" }
    if b >= 1024 * 1024 * 1024 { return String(format: "%.1f GB", b / (1024 * 1024 * 1024)) }
    if b >= 1024 * 1024 { return String(format: "%.0f MB", b / (1024 * 1024)) }
    return String(format: "%.0f KB", b / 1024)
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

/// "now", "5m", "3h", "2d" since an ISO date; "—" when unknown.
public func formatAge(_ iso: String?, now: Date = Date()) -> String {
    guard let iso, let date = isoFormatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "—" }
    let s = max(0, now.timeIntervalSince(date))
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86400 { return "\(Int(s / 3600))h" }
    return "\(Int(s / 86400))d"
}

/// A session has an open tab when its id is one of the tabs' session ids (tab ids are random).
public func sessionIsTabbed(_ s: TmuxSession, tabSessionIds: Set<String>) -> Bool {
    guard let id = s.id else { return false }
    return tabSessionIds.contains(id)
}

/// Totals for the footer: count, CPU and memory of the listed sessions.
public func sessionsSummary(_ sessions: [TmuxSession]) -> String {
    let cpu = sessions.compactMap { $0.usage?.cpu }.reduce(0, +)
    let mem = sessions.compactMap { $0.usage?.memoryBytes }.reduce(0, +)
    let orphans = sessions.filter { $0.orphan != nil }.count
    let n = sessions.count
    return "\(n) session\(n == 1 ? "" : "s") · \(orphans) orphaned · \(formatCPU(SessionUsage(cpu: cpu, memoryBytes: mem))) CPU · \(formatMemory(SessionUsage(cpu: cpu, memoryBytes: mem)))"
}

// ---- the sidebar's usage

/// The host sessions' usage summed per worktree path (standardized), for the sidebar rows.
/// Container sessions are left out: the sidebar's poll does not exec into containers.
public func sessionUsageByWorktree(_ sessions: [TmuxSession]) -> [String: SessionUsage] {
    var out: [String: SessionUsage] = [:]
    for s in sessions where s.container == nil {
        guard let path = s.worktree?.path, let u = s.usage else { continue }
        let key = (path as NSString).standardizingPath
        let sum = out[key] ?? SessionUsage(cpu: 0, memoryBytes: 0)
        out[key] = SessionUsage(cpu: sum.cpu + u.cpu, memoryBytes: sum.memoryBytes + u.memoryBytes)
    }
    return out
}

/// "65% 425M", "0.1% 19M", "3% 1.2G": a sidebar row's usage, short enough for its status line.
public func formatUsageShort(_ u: SessionUsage) -> String {
    let cpu = formatCPU(u)
    let b = u.memoryBytes
    let mem = b >= 1024 * 1024 * 1024 ? String(format: "%.1fG", b / (1024 * 1024 * 1024))
        : String(format: "%.0fM", b / (1024 * 1024))
    return "\(cpu) \(mem)"
}
