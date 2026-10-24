import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct EnvironmentFilterTests {
    func env(_ repo: String, _ branch: String, _ kind: EnvironmentKind = .worktree,
             agent: AgentActivity = .none) -> Environment {
        let r = RepoRef(name: repo, root: "/r/\(repo)", bare: false)
        return Environment(
            id: environmentId(repo: repo, kind: kind, branch: branch), kind: kind, repo: r, branch: branch,
            path: "/w/\(branch)", containerName: nil, state: kind == .worktree ? .ok : .running, agent: agent,
            agentSession: nil, dirty: nil, changedFiles: nil, ahead: nil, behind: nil, upstream: nil,
            pullRequest: nil, ports: [], services: [], createdAt: nil, exists: true, isMain: false)
    }

    var repos: [RepoEnvironments] {
        [
            RepoEnvironments(repo: RepoRef(name: "alertd-core", root: "/r/a", bare: false), backend: .docker,
                             environments: [env("alertd-core", "feat/llm-insights", .container, agent: .waiting),
                                            env("alertd-core", "main", agent: .running)]),
            RepoEnvironments(repo: RepoRef(name: "kunj", root: "/r/k", bare: false), backend: .docker,
                             environments: [env("kunj", "workspace-app", agent: .unknown)]),
        ]
    }

    /// Only open sessions are listed (tabs in the app, saved tabs, a running agent); the rest are
    /// behind a "N more" row per repository, which lists them all when expanded; a search finds all
    @Test func sidebarListsOpenSessions() {
        let idle = env("kunj", "old-branch")
        var rs = repos
        rs[1].environments.append(idle)
        let open: Set<String> = [rs[1].environments[0].id]
        let groups = sidebarGroups(rs, query: "", isOpen: { open.contains($0.id) }, expanded: [])
        // alertd-core: both have running/waiting agents; kunj: workspace-app open, old-branch not
        #expect(groups.map { $0.environments.map(\.branch) } == [["feat/llm-insights", "main"], ["workspace-app"]])
        #expect(groups.map(\.more) == [0, 1])
        #expect(groups.map(\.expanded) == [false, false])

        let expanded = sidebarGroups(rs, query: "", isOpen: { open.contains($0.id) }, expanded: ["/r/k"])
        #expect(expanded[1].environments.map(\.branch) == ["workspace-app", "old-branch"])
        #expect(expanded[1].more == 1 && expanded[1].expanded)

        // nothing open in a repository: its header and the "more" row stay, to open one
        let none = sidebarGroups(rs, query: "", isOpen: { _ in false }, expanded: [])
        #expect(none[1].environments.isEmpty && none[1].more == 2)

        let searched = sidebarGroups(rs, query: "old", isOpen: { _ in false }, expanded: [])
        #expect(searched.map { $0.environments.map(\.branch) } == [["old-branch"]])
        #expect(searched[0].more == 0)
    }

    @Test func emptyQueryKeepsEverything() {
        #expect(filterEnvironments(repos, query: "  ") == repos)
    }

    @Test func queryMatchesBranchCaseInsensitively() {
        let out = filterEnvironments(repos, query: "LLM")
        #expect(out.map(\.repo.name) == ["alertd-core"])
        #expect(out[0].environments.map(\.branch) == ["feat/llm-insights"])
    }

    @Test func queryMatchingTheRepoKeepsAllItsRows() {
        let out = filterEnvironments(repos, query: "kunj")
        #expect(out.map(\.repo.name) == ["kunj"])
        #expect(out[0].environments.count == 1)
    }

    @Test func queryMatchesTheKind() {
        let out = filterEnvironments(repos, query: "container")
        #expect(out.flatMap(\.environments).map(\.branch) == ["feat/llm-insights"])
    }

    @Test func agentCountIncludesWaiting() {
        #expect(agentsRunning(repos) == 2)
    }

    @Test func nthEnvironmentIsInSidebarOrder() {
        #expect(environmentIds(repos) == ["alertd-core|container|feat/llm-insights", "alertd-core|worktree|main",
                                          "kunj|worktree|workspace-app"])
    }
}
