import Foundation
@testable import KunjWorkspaceCore

/// Environments for the TerminalSpec and ActionSpec tests.
let testRepo = RepoRef(name: "app", root: "/r/app", bare: false)

func testWorktree(_ branch: String = "feature/x", path: String? = "/w/feat", exists: Bool = true,
                  isMain: Bool = false) -> Environment {
    Environment(
        id: environmentId(repo: testRepo.name, kind: .worktree, branch: branch), kind: .worktree, repo: testRepo,
        branch: branch, path: path, containerName: nil, state: exists ? .ok : .missing, agent: .none,
        agentSession: "kunj-app-feature-x-1a2b", dirty: false, changedFiles: 0, ahead: 0, behind: 0, upstream: nil,
        pullRequest: nil, ports: [], services: [], createdAt: nil, exists: exists, isMain: isMain)
}

func testContainer(_ branch: String = "feature/x", running: Bool = true) -> Environment {
    Environment(
        id: environmentId(repo: testRepo.name, kind: .container, branch: branch), kind: .container, repo: testRepo,
        branch: branch, path: nil, containerName: "kunj-app-feature-x-1a2b", state: running ? .running : .stopped,
        agent: .none, agentSession: nil, dirty: false, changedFiles: nil, ahead: 0, behind: nil, upstream: nil,
        pullRequest: nil, ports: [PortInfo(container: 3000, host: 3000, kind: "forward", service: nil)],
        services: [], createdAt: nil, exists: true, isMain: false)
}
