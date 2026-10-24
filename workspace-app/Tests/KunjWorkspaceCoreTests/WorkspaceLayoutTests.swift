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
