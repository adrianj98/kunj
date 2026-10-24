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
