import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct SearchTests {
    func env(_ branch: String, _ kind: EnvironmentKind = .worktree) -> Environment {
        let r = RepoRef(name: "app", root: "/r/app", bare: false)
        return Environment(
            id: environmentId(repo: "app", kind: kind, branch: branch), kind: kind, repo: r, branch: branch,
            path: kind == .worktree ? "/r/app" : nil, containerName: nil, state: kind == .worktree ? .ok : .running,
            agent: .none, agentSession: nil, dirty: nil, changedFiles: nil, ahead: nil, behind: nil, upstream: nil,
            pullRequest: nil, ports: [], services: [], createdAt: nil, exists: true, isMain: false)
    }

    /// The fixture is a real `kunj search --json` output (paths shortened) plus two container sources.
    func fixture() async throws -> SearchJson {
        try await fakeKunjCLI().run(["search", "--regexp=needle", "-F", "-i", "--in", "worktrees,containers"], cwd: "/")
    }

    @Test func defaultSearchesTheSelectedEnvironmentOnly() {
        #expect(searchArguments(SearchQuery(text: "needle"), env: env("feature/x"))
            == ["search", "--regexp=needle", "-F", "-i", "--in", "worktrees", "--branch=feature/x"])
        #expect(searchArguments(SearchQuery(text: "needle"), env: env("feature/x", .container))
            == ["search", "--regexp=needle", "-F", "-i", "--in", "containers", "--branch=feature/x"])
    }

    /// A query or branch that starts with `-` is an option value, never an option
    @Test func optionsAndScopes() {
        let q = SearchQuery(text: "-v", ignoreCase: false, word: true, regex: true, scope: .everywhere)
        #expect(searchArguments(q, env: env("main")) == ["search", "--regexp=-v", "-w", "--in", "worktrees,containers"])
        var all = SearchQuery(text: "x")
        all.scope = .worktrees
        #expect(searchArguments(all, env: env("-b")) == ["search", "--regexp=x", "-F", "-i", "--in", "worktrees"])
        #expect(searchArguments(SearchQuery(text: "x"), env: env("-b")).last == "--branch=-b")
    }

    @Test func scopeTitles() {
        #expect(SearchScope.environment.title(for: .container) == "This container")
        #expect(SearchScope.environment.title(for: .worktree) == "This worktree")
        #expect(SearchScope.everywhere.title(for: nil) == "Worktrees & containers")
    }

    @Test func decodesKunjOutput() async throws {
        let r = try await fixture()
        #expect(r.searched == SearchCounts(worktrees: 2, branches: 0, containers: 1))
        #expect(r.sources.map(\.kind) == ["worktree", "worktree", "container", "container"])
        #expect(r.sources[0].matches[1] == SearchMatch(path: "src/a.ts", line: 1, column: 5, length: 6, text: "let needle = 1"))
        #expect(r.containers == SearchContainers(available: true, message: nil, stopped: ["old"]))
    }

    /// One environment: its files at the top; matches carry where to open them
    @Test func treeForOneEnvironment() async throws {
        var r = try await fixture()
        r.sources = [r.sources[0]]
        let tree = searchTree(r, grouped: false)
        #expect(tree.map(\.key) == ["worktree|main|README.md", "worktree|main|src/a.ts"])
        #expect(tree[1].kind == .file(path: "src/a.ts", count: 2, truncated: false))
        #expect(tree[1].children[1].target == SearchTarget(kind: .worktree, branch: "main", path: "src/a.ts",
                                                           line: 2, column: 4, length: 6))
        #expect(tree[1].target == tree[1].children[0].target)
    }

    /// Several: one node per source; a failed source shows its error; the cap marks the last file
    @Test func treeGroupedBySource() async throws {
        let tree = searchTree(try await fixture(), grouped: true)
        #expect(tree.map(\.key) == ["worktree|main", "worktree|feature/x", "container|feature/x", "container|broken"])
        #expect(tree[0].kind == .source(branch: "main", kind: .worktree, detail: "worktree", failed: false))
        #expect(tree[2].children[0].kind == .file(path: "src/b.ts", count: 1, truncated: true))
        #expect(tree[2].children[0].children[0].target?.kind == .container)
        #expect(tree[3].kind == .source(branch: "broken", kind: .container,
                                        detail: "git grep failed in the container (exit 128)", failed: true))
        #expect(tree[3].children.isEmpty)
    }

    @Test func ungroupedStillShowsAFailure() async throws {
        var r = try await fixture()
        r.sources = [r.sources[3]]
        #expect(searchTree(r, grouped: false).map(\.key) == ["container|broken"])
    }

    @Test func branchSourcesAreLeftOut() {
        let r = SearchJson(searched: SearchCounts(worktrees: 0, branches: 1, containers: 0),
                           sources: [SearchSource(kind: "branch", branch: "idle", path: nil, container: nil, isCurrent: nil,
                                                  matches: [SearchMatch(path: "a", line: 1, column: 1, length: 1, text: "x")],
                                                  truncated: false, error: nil)],
                           containers: nil)
        #expect(searchTree(r, grouped: true).isEmpty)
        #expect(searchSummary(r) == "No matches")
    }

    @Test func summary() async throws {
        #expect(searchSummary(try await fixture()) == "8+ matches in 6 files · not running: old")
        var down = try await fixture()
        down.sources = []
        down.containers = SearchContainers(available: false, message: "Docker is not running", stopped: [])
        #expect(searchSummary(down) == "No matches · containers not searched: Docker is not running")
    }

    @Test func olderKunjGetsTheInstallHint() {
        let e = KunjCLIError(code: .commandFailed, message: "error: unknown command 'search'")
        #expect(searchFailureMessage(e) == "Search needs a newer kunj: npm install -g kunj")
        #expect(searchFailureMessage(KunjCLIError(code: .commandFailed, message: "Not a git repository")) == "Not a git repository")
    }
}
