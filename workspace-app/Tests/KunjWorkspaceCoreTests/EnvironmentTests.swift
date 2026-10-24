import Foundation
import Testing
@testable import KunjWorkspaceCore

private func fixture<T: Decodable>(_ name: String, as: T.Type = T.self) throws -> T {
    let data = try Data(contentsOf: responsesDir.appendingPathComponent(name))
    return try JSONDecoder().decode(T.self, from: data)
}

private let alertd = RepoRef(name: "alertd-core", root: "/Users/demo/projects/alertd-core.git", bare: true)

private func worktree(
    branch: String, exists: Bool = true, dirty: Bool = false, changed: Int = 0, ahead: Int? = 0, behind: Int? = 0,
    upstream: String? = nil, agentRunning: Bool? = false, agentState: String? = nil, pr: PullRequestInfo? = nil
) -> Environment {
    Environment(
        id: Environment.environmentId(repo: alertd.name, kind: .worktree, branch: branch), kind: .worktree,
        repo: alertd, branch: branch, path: "/w/\(branch)", containerName: nil,
        state: exists ? .ok : .missing,
        agent: agentActivity(running: agentRunning, state: agentState), agentSession: "kunj-x",
        dirty: dirty, changedFiles: changed, ahead: ahead, behind: behind, upstream: upstream,
        pullRequest: pr, ports: [], services: [], createdAt: nil, exists: exists, isMain: false)
}

private func pr(_ number: Int, state: String, draft: Bool = false, checks: String? = nil) -> PullRequestInfo {
    PullRequestInfo(provider: "github", number: number, title: "t", state: state, url: "https://x/\(number)",
                    draft: draft, baseBranch: "main", headBranch: "b", reviewDecision: nil, checks: checks,
                    updatedAt: nil)
}

/// A responses dir for fake-kunj holding `files` (name → contents).
private func responses(_ files: [String: String]) throws -> URL {
    let dir = try tempDirectory()
    for (name, body) in files {
        try body.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }
    return dir
}

@Suite struct EnvironmentTests {
    @Test func decodeFixtures() throws {
        let repos: ReposJson = try fixture("repos.json")
        #expect(repos.repos.count == 4)
        #expect(repos.repos[0].bare == true)
        #expect(repos.repos[3].hidden == true)
        #expect(repos.repos[2].exists == false)

        let wt: WorktreeListJson = try fixture("worktree_list.json")
        #expect(wt.worktrees.count == 5)
        #expect(wt.worktrees[2].agent == AgentState(running: true, session: "kunj-alertd-core-fix-alert-dedupe-3c91d2", state: "running"))
        #expect(wt.worktrees[3].pullRequest?.number == 398)
        #expect(wt.worktrees[0].status == nil)
        #expect(wt.worktrees[2].sessions.first?.editor == "vscode")

        let ct: ContainerListJson = try fixture("ct_list.json")
        #expect(ct.backend.kind == "docker")
        let c = try #require(ct.containers.first)
        #expect(c.agent.state == "waiting")
        #expect(c.ports == [ContainerPortJson(container: 3000, host: 3000, kind: "forward", service: nil)])
        #expect(c.services.map(\.name) == ["postgres", "redis"])
        #expect(c.workspace.ahead == 3)
        #expect(c.blueprint?.stale == false)

        let err: ErrorJson = try fixture("ct_list_error.json")
        #expect(err.code == "error")
        #expect(err.message.hasPrefix("Docker is not available"))
    }

    @Test func errorJsonDecodesBothShapes() throws {
        let plain = try JSONDecoder().decode(ErrorJson.self, from: Data(#"{"error":"Not a git repository"}"#.utf8))
        #expect(plain.code == nil)
        #expect(plain.message == "Not a git repository")
        let obj = try JSONDecoder().decode(ErrorJson.self, from: Data(#"{"error":{"code":"not-found","message":"m"}}"#.utf8))
        #expect(obj.code == "not-found")
        #expect(obj.message == "m")
    }

    @Test func fileJsonShapes() throws {
        let r = try JSONDecoder().decode(FileReadJson.self, from: Data(#"{"path":"a.ts","content":"x"}"#.utf8))
        #expect(r.content == "x")
        let w = try JSONDecoder().decode(FileWriteJson.self, from: Data(#"{"success":true,"path":"a.ts"}"#.utf8))
        #expect(w.success && w.path == "a.ts")
        let s = try JSONDecoder().decode(SuccessJson.self, from: Data(#"{"success":true,"branch":"x"}"#.utf8))
        #expect(s.success)
    }

    @Test func mergeWorktreesAndContainers() throws {
        let wt: WorktreeListJson = try fixture("worktree_list.json")
        let ct: ContainerListJson = try fixture("ct_list.json")
        let r = mergeEnvironments(repo: alertd, worktrees: wt, containers: .success(ct))
        #expect(r.backend == .docker)
        // the bare entry and the detached worktree are skipped
        #expect(r.environments.count == 4)
        #expect(r.environments.map(\.branch) == ["chore/bun-upgrade", "fix/alert-dedupe", "main", "feat/llm-insights"])
        let c = try #require(r.environments.last)
        #expect(c.id == "alertd-core|container|feat/llm-insights")
        #expect(c.kind == .container)
        #expect(c.state == .running)
        #expect(c.agent == .waiting)
        #expect(c.ports == [PortInfo(container: 3000, host: 3000, kind: "forward", service: nil)])
        #expect(c.containerName == "kunj-alertd-core-feat-llm-insights-6d1f0a")
        #expect(c.path == nil)
        #expect(c.ahead == 3)
        #expect(c.dirty == true)
        #expect(c.services.count == 2)
        #expect(c.createdAt == ISO8601DateFormatter().date(from: "2026-10-23T21:12:40Z"))
        let fix = r.environments[1]
        #expect(fix.id == "alertd-core|worktree|fix/alert-dedupe")
        #expect(fix.state == .ok)
        #expect(fix.agent == .running)
        #expect(fix.agentSession == "kunj-alertd-core-fix-alert-dedupe-3c91d2")
        #expect(fix.path == "/Users/demo/projects/alertd-core.git/kunj/worktrees/fix-alert-dedupe")
        #expect(fix.changedFiles == 2)
        #expect(fix.upstream == "origin/fix/alert-dedupe")
    }

    @Test func worktreeAndContainerOnOneBranchAreTwoEnvironments() throws {
        let wt: WorktreeListJson = try fixture("worktree_list.json")
        var ct: ContainerListJson = try fixture("ct_list.json")
        ct.containers = ct.containers.map { var c = $0; c.branch = "main"; return c }
        let r = mergeEnvironments(repo: alertd, worktrees: wt, containers: .success(ct))
        let ids = r.environments.filter { $0.branch == "main" }.map(\.id)
        #expect(ids == ["alertd-core|worktree|main", "alertd-core|container|main"])
    }

    @Test func stoppedContainer() throws {
        var ct: ContainerListJson = try fixture("ct_list.json")
        ct.containers = ct.containers.map { var c = $0; c.state = "exited"; c.agent = AgentState(running: nil, session: nil, state: nil); return c }
        let r = mergeEnvironments(repo: alertd, worktrees: nil, containers: .success(ct))
        let c = try #require(r.environments.first)
        #expect(c.state == .stopped)
        #expect(c.statusVerb == "Stopped")
        #expect(c.dot == .idle)
    }

    @Test func runningContainerVerbs() throws {
        var ct: ContainerListJson = try fixture("ct_list.json")
        ct.containers = ct.containers.map { var c = $0; c.agent = AgentState(running: false, session: nil, state: "waiting"); return c }
        var c = try #require(mergeEnvironments(repo: alertd, worktrees: nil, containers: .success(ct)).environments.first)
        // ct list reports dirty without a count
        #expect(c.statusVerb == "Changed files")
        c.dirty = false
        #expect(c.statusVerb == "↑3 unpushed")
    }

    @Test func statusVerbOrder() {
        // waiting beats running beats PR beats dirty beats ahead
        #expect(worktree(branch: "a", dirty: true, changed: 3, agentRunning: true, agentState: "waiting",
                         pr: pr(1, state: "open")).statusVerb == "Waiting for input")
        #expect(worktree(branch: "a", dirty: true, changed: 3, agentRunning: true, agentState: "running",
                         pr: pr(1, state: "open")).statusVerb == "Running")
        #expect(worktree(branch: "a", dirty: true, changed: 3, agentRunning: true, agentState: nil).statusVerb == "Running")
        #expect(worktree(branch: "a", dirty: true, changed: 3, pr: pr(398, state: "merged")).statusVerb == "Merged #398")
        #expect(worktree(branch: "a", dirty: true, changed: 3, pr: pr(57, state: "open")).statusVerb == "PR #57 open")
        #expect(worktree(branch: "a", pr: pr(57, state: "open", draft: true)).statusVerb == "PR #57 draft")
        #expect(worktree(branch: "a", dirty: true, changed: 3, pr: pr(9, state: "closed")).statusVerb == "3 changed files")
        #expect(worktree(branch: "a", dirty: true, changed: 1).statusVerb == "1 changed file")
        #expect(worktree(branch: "a", ahead: 2).statusVerb == "↑2 unpushed")
        #expect(worktree(branch: "a").statusVerb == "Clean")
        #expect(worktree(branch: "a", ahead: nil, behind: nil).statusVerb == "Clean")
    }

    @Test func agentStateCountsOnlyWhileRunning() {
        // a crashed agent leaves its last state behind
        #expect(agentActivity(running: false, state: "waiting") == .none)
        #expect(agentActivity(running: nil, state: "waiting") == .unknown)
        #expect(agentActivity(running: true, state: "waiting") == .waiting)
        #expect(agentActivity(running: true, state: nil) == .running)
        #expect(worktree(branch: "a", agentRunning: false, agentState: "waiting").statusVerb == "Clean")
    }

    @Test func dotColours() {
        #expect(worktree(branch: "a", agentRunning: true, agentState: "waiting").dot == .amber)
        #expect(worktree(branch: "a", agentRunning: true, agentState: "running").dot == .green)
        #expect(worktree(branch: "a").dot == .idle)
        #expect(worktree(branch: "a", agentRunning: nil).dot == .idle)
    }

    @Test func missingWorktree() throws {
        var wt: WorktreeListJson = try fixture("worktree_list.json")
        wt.worktrees[1].exists = false
        let r = mergeEnvironments(repo: alertd, worktrees: wt, containers: .success(try fixture("ct_list.json")))
        let main = try #require(r.environments.first { $0.branch == "main" && $0.kind == .worktree })
        #expect(main.state == .missing)
        #expect(main.exists == false)
        #expect(main.statusVerb == "Missing")
        // missing beats a waiting agent
        #expect(worktree(branch: "a", exists: false, agentRunning: true, agentState: "waiting").statusVerb == "Missing")
    }

    @Test func containerListingFails() throws {
        let wt: WorktreeListJson = try fixture("worktree_list.json")
        let err = KunjCLIError(code: .commandFailed, message: "Docker is not available", kunjCode: "error")
        let r = mergeEnvironments(repo: alertd, worktrees: wt, containers: .failure(err))
        #expect(r.backend == .unavailable("Docker is not available"))
        #expect(r.environments.count == 3)
        #expect(r.environments.allSatisfy { $0.kind == .worktree })
    }

    @Test func slashId() {
        #expect(Environment.environmentId(repo: "app", kind: .worktree, branch: "feature/x") == "app|worktree|feature/x")
        #expect(environmentId(repo: "app", kind: .container, branch: "feature/x") == "app|container|feature/x")
    }

    @Test func metaLine() throws {
        let wt: WorktreeListJson = try fixture("worktree_list.json")
        let ct: ContainerListJson = try fixture("ct_list.json")
        let r = mergeEnvironments(repo: alertd, worktrees: wt, containers: .success(ct))
        let c = try #require(r.environments.last)
        #expect(c.metaLine == ["alertd-core / feat/llm-insights", "container", "↑3", ":3000"])
        let fix = r.environments[1]
        #expect(fix.metaLine == ["alertd-core / fix/alert-dedupe", "worktree", "↑1 from origin/fix/alert-dedupe"])
        let main = r.environments[2]
        #expect(main.metaLine == ["alertd-core / main", "worktree"])
        var e = worktree(branch: "feat/x", ahead: 3, behind: 1, upstream: "origin/main",
                         pr: pr(412, state: "open", checks: "success"))
        #expect(e.metaLine == ["alertd-core / feat/x", "worktree", "↑3 ↓1 from origin/main", "#412 open ✓"])
        e.pullRequest = pr(412, state: "open", checks: "failure")
        #expect(e.metaLine[3] == "#412 open ✗")
        e.pullRequest = pr(412, state: "open", draft: true, checks: "pending")
        #expect(e.metaLine[3] == "#412 draft …")
        e.pullRequest = pr(412, state: "merged")
        #expect(e.metaLine[3] == "#412 merged")
    }

    @Test func listEnvironmentsSkipsHiddenAndMissingRepos() async throws {
        let rootA = try tempDirectory(), rootB = try tempDirectory()
        let repos = """
            {"repos":[
             {"root":"\(rootA.path)","gitCommonDir":"\(rootA.path)","name":"alertd-core","bare":true,"lastSeen":"x","exists":true},
             {"root":"\(rootB.path)","gitCommonDir":"\(rootB.path)/.git","name":"kunj","bare":false,"lastSeen":"x","exists":true},
             {"root":"/nonexistent/old","gitCommonDir":"/nonexistent/old/.git","name":"old","bare":false,"lastSeen":"x","exists":false},
             {"root":"/nonexistent/hidden","gitCommonDir":"/nonexistent/hidden/.git","name":"hidden","bare":false,"hidden":true,"lastSeen":"x","exists":true}
            ]}
            """
        let wt = try String(contentsOf: responsesDir.appendingPathComponent("worktree_list.json"), encoding: .utf8)
        let ct = try String(contentsOf: responsesDir.appendingPathComponent("ct_list.json"), encoding: .utf8)
        let dir = try responses(["repos.json": repos, "worktree_list.json": wt, "ct_list.json": ct])
        let log = dir.appendingPathComponent("calls.log")
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path, "FAKE_KUNJ_LOG": log.path])
        let (list, error) = await listEnvironments(cli: cli)
        #expect(error == nil)
        #expect(list.map(\.repo.name) == ["alertd-core", "kunj"])
        #expect(list[0].repo == RepoRef(name: "alertd-core", root: rootA.path, bare: true))
        #expect(list[0].environments.count == 4)
        #expect(list[1].environments.first?.id == "kunj|worktree|chore/bun-upgrade")
        // every call runs in the repository's root and names nothing else
        let calls = try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(calls.count == 5)
        #expect(calls.filter { $0.hasSuffix("\tworktree list --json") }.count == 2)
        #expect(calls.filter { $0.hasSuffix("\tct list --json") }.count == 2)
        for call in calls where !call.hasSuffix("\trepos --json") {
            let cwd = String(call.split(separator: "\t")[0])
            #expect(cwd == realPath(rootA) || cwd == realPath(rootB))
        }
    }

    @Test func listEnvironmentsKeepsWorktreesWhenContainersFail() async throws {
        let root = try tempDirectory()
        let repos = #"{"repos":[{"root":"\#(root.path)","gitCommonDir":"\#(root.path)","name":"alertd-core","bare":true,"lastSeen":"x","exists":true}]}"#
        let wt = try String(contentsOf: responsesDir.appendingPathComponent("worktree_list.json"), encoding: .utf8)
        let err = try String(contentsOf: responsesDir.appendingPathComponent("ct_list_error.json"), encoding: .utf8)
        let dir = try responses(["repos.json": repos, "worktree_list.json": wt, "ct_list.json": err])
        let (list, error) = await listEnvironments(cli: fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path]))
        #expect(error == nil)
        let r = try #require(list.first)
        guard case .unavailable(let message) = r.backend else { Issue.record("backend \(r.backend)"); return }
        #expect(message.hasPrefix("Docker is not available"))
        #expect(r.environments.count == 3)
    }

    @Test func listEnvironmentsDropsARepoWhoseWorktreeListFails() async throws {
        let root = try tempDirectory()
        let repos = #"{"repos":[{"root":"\#(root.path)","gitCommonDir":"\#(root.path)","name":"alertd-core","bare":true,"lastSeen":"x","exists":true}]}"#
        // no worktree_list.json: fake-kunj prints its fixture-missing error document
        let dir = try responses(["repos.json": repos, "ct_list.json": #"{"repo":"a","backend":{"kind":"docker","context":"default"},"containers":[],"orphans":[]}"#])
        let (list, error) = await listEnvironments(cli: fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path]))
        #expect(list.isEmpty)
        #expect(error?.kunjCode == "fixture-missing")
    }

    @Test func listEnvironmentsReportsReposFailure() async throws {
        let dir = try responses([:])
        let (list, error) = await listEnvironments(cli: fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path]))
        #expect(list.isEmpty)
        #expect(error?.code == .commandFailed)
    }
}

private func realPath(_ url: URL) -> String {
    // fake-kunj logs `pwd -P`: /var is /private/var, which resolvingSymlinksInPath() strips again
    guard let p = realpath(url.path, nil) else { return url.path }
    defer { free(p) }
    return String(cString: p)
}
