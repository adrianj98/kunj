import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct WorktreeMovesTests {
    private func repos(_ envs: [Environment]) -> [RepoEnvironments] {
        [RepoEnvironments(repo: testRepo, backend: .docker, environments: envs)]
    }

    @Test func aWorktreeThatCheckedOutAnotherBranchMoves() {
        let before = repos([testWorktree("feat-a", path: "/w/a"), testWorktree("main", path: "/r/app", isMain: true)])
        let after = repos([testWorktree("feat-b", path: "/w/a"), testWorktree("main", path: "/r/app", isMain: true)])
        let moves = worktreeMoves(from: before, to: after)
        #expect(moves.map { [$0.from.branch, $0.to.branch] } == [["feat-a", "feat-b"]])
    }

    @Test func nothingMovesWhenTheOldIdIsStillListedOrTheNewOneWasAlready() {
        // feat-a got a second worktree elsewhere while /w/a moved: feat-a still exists, nothing to take over
        let before = repos([testWorktree("feat-a", path: "/w/a")])
        let after = repos([testWorktree("feat-b", path: "/w/a"), testWorktree("feat-a", path: "/w/other")])
        #expect(worktreeMoves(from: before, to: after).isEmpty)
        // the new branch was already listed (another worktree): its tabs are its own
        let before2 = repos([testWorktree("feat-a", path: "/w/a"), testWorktree("feat-b", path: "/w/b")])
        let after2 = repos([testWorktree("feat-b", path: "/w/a")])
        #expect(worktreeMoves(from: before2, to: after2).isEmpty)
    }

    @Test func containersAndRemovedWorktreesDoNotMove() {
        let before = repos([testContainer("feat-a"), testWorktree("feat-a", path: "/w/a")])
        let after = repos([testContainer("feat-b")])
        #expect(worktreeMoves(from: before, to: after).isEmpty)
    }
}

@MainActor @Suite struct WorktreeMovesStoreTests {
    @Test func theStoreReportsAMoveBeforeTheChange() async {
        let a = [RepoEnvironments(repo: testRepo, backend: .docker, environments: [testWorktree("feat-a", path: "/w/a")])]
        let b = [RepoEnvironments(repo: testRepo, backend: .docker, environments: [testWorktree("feat-b", path: "/w/a")])]
        nonisolated(unsafe) var listing = a
        let store = EnvironmentStore(cli: fakeKunjCLI(), lister: { _ in (listing, nil) })
        var calls: [String] = []
        store.onWorktreesMoved = { moves in calls += moves.map { "moved \($0.from.branch)>\($0.to.branch)" } }
        store.onChange = { calls.append("change \(store.repos[0].environments[0].branch)") }
        await store.refreshAll()
        listing = b
        await store.refreshAll()
        #expect(calls == ["change feat-a", "moved feat-a>feat-b", "change feat-b"])
    }
}
