import Foundation
import Testing
@testable import KunjWorkspaceCore

struct RepoChangeTests {
    @Test func aHostChangeConcernsTheRepositorysWorktreesOnly() {
        let change = RepoChange(root: testRepo.root)
        #expect(change.concerns(testWorktree()))
        #expect(change.concerns(testWorktree("main", path: "/w/main", isMain: true)))
        #expect(!change.concerns(testContainer()))
        #expect(!RepoChange(root: "/r/other").concerns(testWorktree()))
    }

    @Test func aContainerChangeConcernsThatContainerOnly() {
        let change = RepoChange(root: testRepo.root, container: "kunj-app-feature-x-1a2b", branch: "feature/x")
        #expect(change.concerns(testContainer()))
        var other = testContainer("feature/y")
        other.containerName = "kunj-app-feature-y-3c4d"
        #expect(!change.concerns(other))
        // a machine with no container row yet: by branch
        var machine = testContainer()
        machine.containerName = nil
        #expect(change.concerns(machine))
        #expect(!RepoChange(root: testRepo.root, container: "c", branch: "feature/y").concerns(machine))
        #expect(!change.concerns(testWorktree()))
        #expect(!RepoChange(root: "/r/other", container: "kunj-app-feature-x-1a2b", branch: "feature/x").concerns(testContainer()))
    }

    @Test func aSaveInAnEnvironmentConcernsIt() {
        #expect(RepoChange(env: testContainer()).concerns(testContainer()))
        #expect(!RepoChange(env: testContainer()).concerns(testWorktree()))
        #expect(RepoChange(env: testWorktree()) == RepoChange(root: testRepo.root))
    }
}

@MainActor
struct SerialReloaderTests {
    /// A run that waits until released, counting how many started and how many overlap.
    final class Gate {
        var started = 0
        var running = 0
        var most = 0
        var waiting: [CheckedContinuation<Void, Never>] = []
        func run() async {
            started += 1
            running += 1
            most = max(most, running)
            await withCheckedContinuation { waiting.append($0) }
            running -= 1
        }
        func release() { let w = waiting; waiting = []; w.forEach { $0.resume() } }
    }

    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    @Test func requestsWhileRunningMakeOneMoreRun() async {
        let gate = Gate()
        let reloader = SerialReloader { await gate.run() }
        reloader.request()
        await settle()
        reloader.request()
        reloader.request()
        reloader.request()
        await settle()
        #expect(gate.started == 1)
        gate.release()
        await settle()
        #expect(gate.started == 2)
        gate.release()
        await settle()
        #expect(gate.started == 2)
        #expect(gate.most == 1)
        #expect(!reloader.isRunning)
    }

    @Test func aHiddenRequestRunsOnceWhenShown() async {
        let gate = Gate()
        let reloader = SerialReloader { await gate.run() }
        reloader.isVisible = false
        reloader.request()
        reloader.request()
        await settle()
        #expect(gate.started == 0)
        reloader.isVisible = true
        await settle()
        #expect(gate.started == 1)
        gate.release()
        await settle()
        #expect(gate.started == 1)
        // shown again with nothing missed: no run
        reloader.isVisible = false
        reloader.isVisible = true
        await settle()
        #expect(gate.started == 1)
    }

    @Test func aRequestQueuedBeforeHidingWaitsForShowing() async {
        let gate = Gate()
        let reloader = SerialReloader { await gate.run() }
        reloader.request()
        await settle()
        reloader.request()
        reloader.isVisible = false
        gate.release()
        await settle()
        #expect(gate.started == 1)
        reloader.isVisible = true
        await settle()
        #expect(gate.started == 2)
        gate.release()
        await settle()
    }

    @Test func cancelPendingDropsTheQueuedRun() async {
        let gate = Gate()
        let reloader = SerialReloader { await gate.run() }
        reloader.request()
        await settle()
        reloader.request()
        reloader.cancelPending()
        gate.release()
        await settle()
        #expect(gate.started == 1)
    }
}
