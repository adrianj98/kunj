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
