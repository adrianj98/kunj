import Foundation

/// A tab worth restoring: shells reattach to their tmux session (or restart without one), agent tabs reattach to tmux, editor tabs reopen `path`
/// (relative to the worktree or /workspace). Action tabs are never saved.
public struct SavedTab: Codable, Equatable, Sendable {
    public var kind: TabKind
    public var title: String
    public var path: String?
    /// A shell tab's tmux session id (`TerminalSpec.session`); absent in files from before it.
    public var session: String?

    public init(kind: TabKind, title: String, path: String?, session: String? = nil) {
        self.kind = kind
        self.title = title
        self.path = path
        self.session = session
    }
}

/// One environment's entry in the layout file.
public struct BranchLayout: Codable, Equatable, Sendable {
    public var tabs: [SavedTab]
    public var active: Int?
    public var lastActivity: Date?

    public init(tabs: [SavedTab] = [], active: Int? = nil, lastActivity: Date? = nil) {
        self.tabs = tabs
        self.active = active
        self.lastActivity = lastActivity
    }

    enum CodingKeys: String, CodingKey { case tabs, active, lastActivity }

    /// Tabs this build cannot read (a kind from a newer app) are skipped, not the whole entry.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tabs = (try c.decodeIfPresent([Lenient<SavedTab>].self, forKey: .tabs) ?? []).compactMap(\.value)
        active = try? c.decodeIfPresent(Int.self, forKey: .active)
        lastActivity = try? c.decodeIfPresent(Date.self, forKey: .lastActivity)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(tabs, forKey: .tabs)
        try c.encodeIfPresent(active, forKey: .active)
        try c.encodeIfPresent(lastActivity, forKey: .lastActivity)
    }
}

/// `~/.kunj/<repo>/workspace.json`: one object keyed by `layoutKey(kind:branch:)`. A worktree and
/// a container on one branch are two environments, hence the kind in the key; the file is per
/// repository, so a `/` in a branch needs no escaping.
public struct WorkspaceLayout: Codable, Equatable, Sendable {
    public var branches: [String: BranchLayout]

    public init(branches: [String: BranchLayout] = [:]) {
        self.branches = branches
    }

    /// Entries that do not decode are skipped.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode([String: Lenient<BranchLayout>].self)
        branches = raw.compactMapValues(\.value)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(branches)
    }
}

private struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// `"<kind>:<branch>"`, e.g. `worktree:feature/x`.
public func layoutKey(kind: EnvironmentKind, branch: String) -> String {
    "\(kind.rawValue):\(branch)"
}

/// `<home>/.kunj/<repoName>/workspace.json`
public func layoutPath(repoName: String, home: String = NSHomeDirectory()) -> String {
    URL(fileURLWithPath: home).appendingPathComponent(".kunj").appendingPathComponent(repoName)
        .appendingPathComponent("workspace.json").path
}

// MARK: saving and restoring one environment's tabs

/// The tabs of an environment as the file keeps them: action tabs dropped, `active` (an index into
/// `open`) moved to its place among the rest, nil when the active tab is an action tab.
public func tabsToSave(_ open: [SavedTab], active: Int?) -> (tabs: [SavedTab], active: Int?) {
    var tabs: [SavedTab] = []
    var newActive: Int?
    for (i, tab) in open.enumerated() where tab.kind != .action {
        if i == active { newActive = tabs.count }
        tabs.append(tab)
    }
    return (tabs, newActive)
}

/// The tabs to reopen when an environment is selected for the first time in a session, and which
/// one becomes active. nil while the environment cannot run them (a missing worktree, a stopped
/// container): the caller tries again on a later selection, and must not save over the entry
/// meanwhile. An agent tab comes back only while its agent runs (it reattaches to its tmux
/// session; restoring one that ended would start a new agent): each tab whose session is among
/// `env.agentSessions`, once per session, or, when the sessions are not known (an older kunj),
/// one tab while any agent runs. `kinds` are the kinds the app can reopen (editor tabs once they exist).
public func restorePlan(_ entry: BranchLayout, env: Environment,
                        kinds: Set<TabKind> = [.shell, .agent]) -> (tabs: [SavedTab], active: Int?)? {
    guard env.state == .ok || env.state == .running else { return nil }
    let agentRuns = env.agent == .running || env.agent == .waiting
    var tabs: [SavedTab] = []
    var active: Int?
    var agentSessions: Set<String?> = []
    for (i, tab) in entry.tabs.enumerated() where kinds.contains(tab.kind) && tab.kind != .action {
        if tab.kind == .agent {
            guard agentRuns, !agentSessions.contains(tab.session) else { continue }
            if let running = env.agentSessions {
                guard running.contains(where: { $0.id == tab.session }) else { continue }
            } else if !agentSessions.isEmpty {
                continue
            }
            agentSessions.insert(tab.session)
        }
        if i == entry.active { active = tabs.count }
        tabs.append(tab)
    }
    return (tabs, active)
}

/// Which environments changed since the last listing, for `lastActivity`. The first listing only
/// primes (launching the app is not activity); after that an environment whose state differs from
/// the last time it was listed, or one never listed before, is reported. An environment missing from
/// a listing is remembered, because a failed `ct list` (Docker restarting) or `worktree list` drops
/// environments for a listing: one that comes back unchanged is not activity. A pull request that
/// appears or disappears is not either (`worktree list` reports none when `gh` fails); its changes are.
public struct ActivityTracker: Sendable {
    private var seen: [String: Environment]?

    public init() {}

    /// The ids, in listing order, of environments that changed or appeared.
    public mutating func changed(_ repos: [RepoEnvironments]) -> [String] {
        let envs = repos.flatMap(\.environments)
        let before = seen
        var now = before ?? [:]
        for env in envs { now[env.id] = env }
        seen = now
        guard let before else { return [] }
        var changed: [String] = []
        for env in envs where !changed.contains(env.id) {
            if let old = before[env.id], Self.sameActivity(old, env) { continue }
            changed.append(env.id)
        }
        return changed
    }

    private static func sameActivity(_ a: Environment, _ b: Environment) -> Bool {
        guard a.pullRequest == nil || b.pullRequest == nil else { return a == b }
        var a = a, b = b
        a.pullRequest = nil
        b.pullRequest = nil
        return a == b
    }
}

/// The layout at `path`; empty when the file is missing or not a layout.
public func loadLayout(path: String) -> WorkspaceLayout {
    guard let data = FileManager.default.contents(atPath: path) else { return WorkspaceLayout() }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return (try? decoder.decode(WorkspaceLayout.self, from: data)) ?? WorkspaceLayout()
}

/// Writes `layout` to a temporary file next to `path` and renames it over `path`, creating the
/// parent directories, so a reader never sees half a file.
public func saveLayout(_ layout: WorkspaceLayout, path: String) throws {
    let url = URL(fileURLWithPath: path)
    let dir = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(layout)
    let temp = dir.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    try data.write(to: temp)
    if rename(temp.path, url.path) != 0 {
        let code = errno
        try? FileManager.default.removeItem(at: temp)
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
}

/// The layout files of every repository, cached in memory: `update` changes an entry and saves
/// that repository's file `debounceMs` later (one write for a burst of changes); `flush` writes
/// everything pending now (call it before the app terminates). Safe to use from any thread.
public final class LayoutStore: @unchecked Sendable {
    private let home: String
    private let debounceMs: Int
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "kunj.layout")
    private var cache: [String: WorkspaceLayout] = [:]
    private var pending: [String: DispatchWorkItem] = [:]

    public init(home: String = NSHomeDirectory(), debounceMs: Int = 500) {
        self.home = home
        self.debounceMs = debounceMs
    }

    /// `fallback`: the folder name a build before `kunjName` saved under, read while `repo` has no
    /// file (the next save writes under `repo`)
    public func layout(repo: String, fallback: String? = nil) -> WorkspaceLayout {
        lock.lock(); defer { lock.unlock() }
        return cached(repo, fallback: fallback)
    }

    /// Changes the entry `key` of `repo` (created empty when absent) and schedules the save.
    public func update(repo: String, fallback: String? = nil, key: String, _ change: (inout BranchLayout) -> Void) {
        lock.lock()
        var layout = cached(repo, fallback: fallback)
        var entry = layout.branches[key] ?? BranchLayout()
        change(&entry)
        layout.branches[key] = entry
        cache[repo] = layout
        pending[repo]?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.save(repo: repo) }
        pending[repo] = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + .milliseconds(debounceMs), execute: item)
    }

    /// Writes every pending repository now.
    public func flush() {
        lock.lock()
        let repos = Array(pending.keys)
        for item in pending.values { item.cancel() }
        lock.unlock()
        for repo in repos { save(repo: repo) }
    }

    private func cached(_ repo: String, fallback: String? = nil) -> WorkspaceLayout {
        if let layout = cache[repo] { return layout }
        var path = layoutPath(repoName: repo, home: home)
        if let fallback, fallback != repo, !FileManager.default.fileExists(atPath: path) {
            path = layoutPath(repoName: fallback, home: home)
        }
        let layout = loadLayout(path: path)
        cache[repo] = layout
        return layout
    }

    private func save(repo: String) {
        lock.lock()
        guard pending.removeValue(forKey: repo) != nil, let layout = cache[repo] else { lock.unlock(); return }
        // Written under the lock, so a flush and a timer never write one file at once out of order.
        do {
            try saveLayout(layout, path: layoutPath(repoName: repo, home: home))
        } catch {
            NSLog("Could not save the layout of %@: %@", repo, "\(error)")
        }
        lock.unlock()
    }
}
