import Foundation
import Testing
@testable import KunjWorkspaceCore

private func sampleLayout() -> WorkspaceLayout {
    var layout = WorkspaceLayout()
    layout.branches[layoutKey(kind: .worktree, branch: "feature/x")] = BranchLayout(
        tabs: [SavedTab(kind: .agent, title: "agent", path: nil),
               SavedTab(kind: .editor, title: "a.ts", path: "src/a.ts")],
        active: 1, lastActivity: Date(timeIntervalSince1970: 1_790_000_000))
    layout.branches[layoutKey(kind: .container, branch: "feature/x")] = BranchLayout(
        tabs: [SavedTab(kind: .shell, title: "shell", path: nil)], active: 0, lastActivity: nil)
    return layout
}

@Suite struct WorkspaceLayoutTests {
    @Test func layoutPathAndKey() {
        #expect(layoutPath(repoName: "kunj", home: "/h") == "/h/.kunj/kunj/workspace.json")
        #expect(layoutKey(kind: .worktree, branch: "feature/x") == "worktree:feature/x")
        #expect(layoutKey(kind: .container, branch: "feature/x") == "container:feature/x")
    }

    @Test func loadMissingIsEmpty() throws {
        let dir = try tempDirectory()
        #expect(loadLayout(path: dir.appendingPathComponent("nope/workspace.json").path) == WorkspaceLayout())
    }

    @Test func roundTripSlashKey() throws {
        let path = try tempDirectory().appendingPathComponent("deep/dir/workspace.json").path
        let layout = sampleLayout()
        try saveLayout(layout, path: path)
        let loaded = loadLayout(path: path)
        #expect(loaded == layout)
        let wt = try #require(loaded.branches["worktree:feature/x"])
        #expect(wt.tabs.count == 2)
        #expect(wt.active == 1)
        #expect(loaded.branches["container:feature/x"] != wt)
    }

    @Test func fileIsTheSpecShape() throws {
        let path = try tempDirectory().appendingPathComponent("workspace.json").path
        try saveLayout(sampleLayout(), path: path)
        let object = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
        #expect(Set(object.keys) == ["worktree:feature/x", "container:feature/x"])
        let wt = try #require(object["worktree:feature/x"] as? [String: Any])
        #expect(wt["active"] as? Int == 1)
        #expect(wt["lastActivity"] as? String == "2026-09-21T14:13:20Z")
        let tabs = try #require(wt["tabs"] as? [[String: Any]])
        #expect(tabs[0]["kind"] as? String == "agent")
        #expect(tabs[1]["path"] as? String == "src/a.ts")
    }

    @Test func corruptIsEmpty() throws {
        let path = try tempDirectory().appendingPathComponent("workspace.json")
        try "{ nope".write(to: path, atomically: true, encoding: .utf8)
        #expect(loadLayout(path: path.path) == WorkspaceLayout())
        try "[1, 2]".write(to: path, atomically: true, encoding: .utf8)
        #expect(loadLayout(path: path.path) == WorkspaceLayout())
    }

    @Test func badEntriesAndUnknownTabKindsAreSkipped() throws {
        let path = try tempDirectory().appendingPathComponent("workspace.json")
        try """
        { "worktree:main": { "tabs": [{ "kind": "shell", "title": "zsh" }, { "kind": "preview", "title": "p" }], "active": 0 },
          "worktree:bad": 42 }
        """.write(to: path, atomically: true, encoding: .utf8)
        let loaded = loadLayout(path: path.path)
        #expect(loaded.branches.count == 1)
        #expect(loaded.branches["worktree:main"]?.tabs == [SavedTab(kind: .shell, title: "zsh", path: nil)])
    }

    @Test func saveIsAtomic() throws {
        let dir = try tempDirectory()
        let path = dir.appendingPathComponent("workspace.json").path
        try saveLayout(sampleLayout(), path: path)
        try saveLayout(WorkspaceLayout(), path: path)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names == ["workspace.json"])
        #expect(loadLayout(path: path) == WorkspaceLayout())
    }

    @Test func layoutStoreDebouncesAndFlushes() async throws {
        let home = try tempDirectory().path
        let store = LayoutStore(home: home, debounceMs: 50)
        let path = layoutPath(repoName: "app", home: home)
        store.update(repo: "app", key: layoutKey(kind: .worktree, branch: "feature/x")) {
            $0.tabs = [SavedTab(kind: .shell, title: "zsh", path: nil)]
            $0.active = 0
        }
        #expect(store.layout(repo: "app").branches["worktree:feature/x"]?.active == 0)
        #expect(!FileManager.default.fileExists(atPath: path))
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(loadLayout(path: path).branches["worktree:feature/x"]?.tabs.count == 1)

        store.update(repo: "app", key: "worktree:feature/x") { $0.active = nil }
        store.flush()
        #expect(loadLayout(path: path).branches["worktree:feature/x"]?.active == nil)
        #expect(loadLayout(path: path).branches["worktree:feature/x"]?.tabs.count == 1)
    }

    @Test func layoutStoreReadsExistingFile() throws {
        let home = try tempDirectory().path
        try saveLayout(sampleLayout(), path: layoutPath(repoName: "app", home: home))
        let store = LayoutStore(home: home)
        #expect(store.layout(repo: "app") == sampleLayout())
        #expect(store.layout(repo: "other") == WorkspaceLayout())
    }
}

private func shell(_ title: String = "zsh") -> SavedTab { SavedTab(kind: .shell, title: title, path: nil) }
private let agentTab = SavedTab(kind: .agent, title: "agent", path: nil)
private let actionTab = SavedTab(kind: .action, title: "ct start", path: nil)
private let editorTab = SavedTab(kind: .editor, title: "a.ts", path: "src/a.ts")

private func repos(_ envs: [Environment]) -> [RepoEnvironments] {
    [RepoEnvironments(repo: RepoRef(name: "demo", root: "/r", bare: false), backend: .docker, environments: envs)]
}

/// Saving and restoring the tabs of one environment, and the activity tracker.
@Suite struct LayoutRestoreTests {
    @Test func actionTabsAreNotSaved() {
        let saved = tabsToSave([shell(), actionTab, agentTab], active: 2)
        #expect(saved.tabs == [shell(), agentTab])
        #expect(saved.active == 1)
    }

    @Test func anActiveActionTabSavesNoActiveIndex() {
        #expect(tabsToSave([shell(), actionTab], active: 1).active == nil)
        #expect(tabsToSave([], active: nil).tabs.isEmpty)
    }

    @Test func restoreWaitsForAUsableEnvironment() {
        let entry = BranchLayout(tabs: [shell()], active: 0)
        #expect(restorePlan(entry, env: diffTestEnvironment(path: "/w", exists: false)) == nil)
        #expect(restorePlan(entry, env: diffTestEnvironment(kind: .container, path: nil, state: .stopped)) == nil)
        #expect(restorePlan(entry, env: diffTestEnvironment(path: "/w"))?.tabs == [shell()])
    }

    @Test func agentTabsReattachOnlyToARunningAgent() {
        let entry = BranchLayout(tabs: [shell(), agentTab], active: 1)
        var env = diffTestEnvironment(path: "/w")
        env.agent = .none
        #expect(restorePlan(entry, env: env)?.tabs == [shell()])
        #expect(restorePlan(entry, env: env)?.active == nil)
        env.agent = .unknown
        #expect(restorePlan(entry, env: env)?.tabs == [shell()])
        for state in [AgentActivity.running, .waiting] {
            env.agent = state
            #expect(restorePlan(entry, env: env)?.tabs == [shell(), agentTab])
            #expect(restorePlan(entry, env: env)?.active == 1)
        }
    }

    @Test func restoreKeepsOneAgentAndTheKindsAsked() {
        var env = diffTestEnvironment(path: "/w")
        env.agent = .waiting
        let entry = BranchLayout(tabs: [editorTab, agentTab, shell("a"), agentTab, shell("b")], active: 4)
        let plan = restorePlan(entry, env: env)
        #expect(plan?.tabs == [agentTab, shell("a"), shell("b")])
        #expect(plan?.active == 2)
        let withEditors = restorePlan(entry, env: env, kinds: [.shell, .agent, .editor])
        #expect(withEditors?.tabs == [editorTab, agentTab, shell("a"), shell("b")])
        #expect(withEditors?.active == 3)
        #expect(restorePlan(BranchLayout(tabs: [shell()], active: 7), env: env)?.active == nil)
    }

    @Test func trackerPrimesThenReportsChangedAndNewEnvironments() {
        var tracker = ActivityTracker()
        let a = diffTestEnvironment(branch: "a", path: "/a")
        let b = diffTestEnvironment(branch: "b", path: "/b")
        #expect(tracker.changed(repos([a, b])).isEmpty)
        #expect(tracker.changed(repos([a, b])).isEmpty)
        var a2 = a
        a2.ahead = 1
        let c = diffTestEnvironment(branch: "c", path: "/c")
        #expect(tracker.changed(repos([a2, b, c])) == [a.id, c.id])
        // gone and back changed counts as a change
        #expect(tracker.changed(repos([a2, c])).isEmpty)
        var b2 = b
        b2.ahead = 2
        #expect(tracker.changed(repos([a2, b2, c])) == [b.id])
    }

    /// A failed `ct list` (Docker restarting) or `worktree list` drops environments from one
    /// listing; their return unchanged is not activity, or every container would read "now".
    @Test func environmentsBackUnchangedAfterAFailedListingAreNotActivity() {
        var tracker = ActivityTracker()
        let a = diffTestEnvironment(branch: "a", path: "/a")
        let box = diffTestEnvironment(kind: .container, branch: "a", path: nil)
        #expect(tracker.changed(repos([a, box])).isEmpty)
        #expect(tracker.changed(repos([a])).isEmpty)
        #expect(tracker.changed(repos([])).isEmpty)
        #expect(tracker.changed(repos([a, box])).isEmpty)
    }

    /// `worktree list` reports no pull request when `gh` fails (offline): losing or regaining the
    /// lookup is not activity, a pull request's own change is.
    @Test func aPullRequestLookupComingAndGoingIsNotActivity() {
        var tracker = ActivityTracker()
        let withPR = diffTestEnvironment(branch: "a", path: "/a", prBase: "main")
        var withoutPR = withPR
        withoutPR.pullRequest = nil
        #expect(tracker.changed(repos([withPR])).isEmpty)
        #expect(tracker.changed(repos([withoutPR])).isEmpty)
        #expect(tracker.changed(repos([withPR])).isEmpty)
        var merged = withPR
        merged.pullRequest?.state = "MERGED"
        #expect(tracker.changed(repos([merged])) == [withPR.id])
    }
}
