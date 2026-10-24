import Foundation
import KunjWorkspaceCore

/// The mockup's environments (docs/workspace-app/design/mockups/warm.png) for `--demo`: alertd-core
/// with four rows and kunj with two, the first selected. Titles are branch names (spec Decisions),
/// so the rows read `feat/llm-insights` where the mockup has a task title. The container carries an
/// upstream and a PR so the header matches the mockup, although `ct list` reports neither today.
enum DemoData {
    static let version = "kunj 1.4.2"
    static let now = Date()

    static let alertd = RepoRef(name: "alertd-core", root: "/Users/demo/src/alertd-core", bare: false)
    static let kunj = RepoRef(name: "kunj", root: "/Users/demo/src/kunj", bare: false)

    private static func env(
        _ repo: RepoRef, _ branch: String, kind: EnvironmentKind = .worktree, state: EnvState? = nil,
        agent: AgentActivity = .none, ahead: Int? = nil, upstream: String? = nil, dirty: Bool = false,
        changed: Int? = nil, pr: PullRequestInfo? = nil, ports: [PortInfo] = [], services: [ServiceState] = [],
        created: Date? = nil, isMain: Bool = false
    ) -> Environment {
        let dir = branch.replacingOccurrences(of: "/", with: "-")
        return Environment(
            id: environmentId(repo: repo.name, kind: kind, branch: branch), kind: kind, repo: repo, branch: branch,
            path: kind == .worktree ? (isMain ? repo.root : "\(repo.root)/.git/kunj/worktrees/\(dir)") : nil,
            containerName: kind == .container ? "\(repo.name)-\(dir)" : nil,
            state: state ?? (kind == .worktree ? .ok : .running), agent: agent,
            agentSession: kind == .worktree && agent != .none ? "kunj-\(repo.name)-\(dir)" : nil,
            dirty: dirty, changedFiles: changed, ahead: ahead, behind: nil, upstream: upstream, pullRequest: pr,
            ports: ports, services: services, createdAt: created, exists: true, isMain: isMain)
    }

    private static func pr(_ n: Int, _ state: String, checks: String? = nil, repo: String, head: String) -> PullRequestInfo {
        PullRequestInfo(provider: "github", number: n, title: "", state: state,
                        url: "https://github.com/example/\(repo)/pull/\(n)", draft: false, baseBranch: "main",
                        headBranch: head, reviewDecision: nil, checks: checks, updatedAt: nil)
    }

    static let repos: [RepoEnvironments] = [
        RepoEnvironments(repo: alertd, backend: .docker, environments: [
            env(alertd, "feat/llm-insights", kind: .container, agent: .waiting, ahead: 3, upstream: "main",
                pr: pr(412, "open", checks: "success", repo: "alertd-core", head: "feat/llm-insights"),
                ports: [PortInfo(container: 3000, host: 3000, kind: "forward", service: nil)],
                services: [ServiceState(name: "postgres", state: "running", port: 5432),
                           ServiceState(name: "redis", state: "running", port: 6379)],
                created: now - (2 * 3600 + 14 * 60)),
            env(alertd, "fix/alert-dedupe", agent: .running, dirty: true, changed: 4),
            env(alertd, "chore/bun-upgrade", pr: pr(398, "merged", repo: "alertd-core", head: "chore/bun-upgrade")),
            env(alertd, "main", isMain: true),
        ]),
        RepoEnvironments(repo: kunj, backend: .docker, environments: [
            env(kunj, "workspace-app", agent: .running, dirty: true, changed: 7),
            env(kunj, "ct-file-cmd", pr: pr(57, "open", checks: "pending", repo: "kunj", head: "ct-file-cmd")),
        ]),
    ]

    static var selectedId: String { repos[0].environments[0].id }

    /// The mockup's relative times: 2m, now, 3d, 1h, now, 40m.
    static func lastActivity(_ id: String) -> Date? {
        let ago: [String: TimeInterval] = [
            "feat/llm-insights": 120, "fix/alert-dedupe": 10, "chore/bun-upgrade": 3 * 86400,
            "main": 3600, "workspace-app": 5, "ct-file-cmd": 40 * 60,
        ]
        guard let branch = id.split(separator: "|", maxSplits: 2).last, let s = ago[String(branch)] else { return nil }
        return now - s
    }
}
