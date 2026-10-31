import Foundation

/// The ⌘K search: a repository whose name matches keeps all its rows; otherwise a row stays when its
/// branch or kind matches (case-insensitive substring). Repositories left with no rows are dropped.
public func filterEnvironments(_ repos: [RepoEnvironments], query: String) -> [RepoEnvironments] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if q.isEmpty { return repos }
    return repos.compactMap { group in
        if group.repo.name.lowercased().contains(q) { return group }
        var g = group
        g.environments = group.environments.filter {
            $0.branch.lowercased().contains(q) || $0.kind.rawValue.contains(q)
        }
        return g.environments.isEmpty ? nil : g
    }
}

/// The sidebar foot's `N agents running`: agents running or waiting for input.
public func agentsRunning(_ repos: [RepoEnvironments]) -> Int {
    repos.reduce(0) { n, g in n + g.environments.filter { $0.agent == .running || $0.agent == .waiting }.count }
}

/// Environment ids in sidebar order (⌘1–9 selects the nth).
public func environmentIds(_ repos: [RepoEnvironments]) -> [String] {
    repos.flatMap { $0.environments.map(\.id) }
}

/// One repository in the sidebar: the rows it lists and how many of its environments are not open.
public struct SidebarGroup: Equatable, Sendable {
    public var repo: RepoRef
    public var environments: [Environment]
    /// Environments that are not open: the `N more…` row (when expanded, they are listed too)
    public var more: Int
    public var expanded: Bool
}

/// The sidebar's rows: only open sessions (`isOpen`: tabs in the app or saved ones, the selection),
/// and any environment whose agent is running or waiting. Each repository keeps its header and a
/// `N more…` row for the rest; a repository in `expanded` lists them all. A search lists every
/// environment that matches, open or not, so any one can be opened. With `hideEmpty` a repository
/// with no open session is left out (search and New Session still reach it).
public func sidebarGroups(_ repos: [RepoEnvironments], query: String, isOpen: (Environment) -> Bool,
                          expanded: Set<String>, hideEmpty: Bool = false) -> [SidebarGroup] {
    if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return filterEnvironments(repos, query: query).map {
            SidebarGroup(repo: $0.repo, environments: $0.environments, more: 0, expanded: false)
        }
    }
    return repos.compactMap { g in
        let open = g.environments.filter { isOpen($0) || $0.agent == .running || $0.agent == .waiting }
        if hideEmpty && open.isEmpty { return nil }
        let more = g.environments.count - open.count
        let all = expanded.contains(g.repo.root)
        return SidebarGroup(repo: g.repo, environments: all ? g.environments : open, more: more, expanded: all)
    }
}
