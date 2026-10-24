import Foundation
import Testing
@testable import KunjWorkspaceCore

private func decode<T: Decodable>(_ name: String) -> T {
    let data = try! Data(contentsOf: responsesDir.appendingPathComponent(name))
    return try! JSONDecoder().decode(T.self, from: data)
}

private let repoA = RepoRef(name: "alertd-core", root: "/r/alertd-core", bare: false)
private let repoB = RepoRef(name: "kunj", root: "/r/kunj", bare: false)

/// Counts the store's calls and answers from the fixtures (3 worktrees + 1 container per repo).
private final class FakeKunj: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    var containersFail = false
    var worktreesFail = false
    var extraRepos: [RepoRef] = []

    func bump(_ key: String) { lock.lock(); counts[key, default: 0] += 1; lock.unlock() }
    func count(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; return counts[key] ?? 0 }

    func worktrees(_ repo: RepoRef) throws -> WorktreeListJson {
        bump("wt:\(repo.root)")
        if worktreesFail { throw KunjCLIError(code: .commandFailed, message: "worktree list failed") }
        return decode("worktree_list.json")
    }

    func containers(_ repo: RepoRef) -> Result<ContainerListJson, KunjCLIError> {
        bump("ct:\(repo.root)")
        if containersFail { return .failure(KunjCLIError(code: .commandFailed, message: "Docker is not running")) }
        return .success(decode("ct_list.json"))
    }

    func list() -> ([RepoEnvironments], KunjCLIError?) {
        bump("all")
        lock.lock(); let extra = extraRepos; lock.unlock()
        return (([repoA, repoB] + extra).map { repo in
            mergeEnvironments(repo: repo, worktrees: try? worktrees(repo), containers: containers(repo))
        }, nil)
    }
}

@MainActor
private func makeStore(_ fake: FakeKunj, coalesceMs: Int = 30) -> EnvironmentStore {
    EnvironmentStore(
        cli: fakeKunjCLI(), coalesceMs: coalesceMs,
        lister: { _ in fake.list() },
        worktrees: { _, repo in try fake.worktrees(repo) },
        containers: { _, repo in fake.containers(repo) })
}

private func sleepMs(_ ms: UInt64) async { try? await Task.sleep(nanoseconds: ms * 1_000_000) }

@MainActor
@Suite struct EnvironmentStoreTests {
    @Test func refreshAllFillsReposAndNotifies() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        var changes = 0
        store.onChange = { changes += 1 }
        await store.refreshAll()
        #expect(store.repos.map(\.repo) == [repoA, repoB])
        #expect(store.repos[0].environments.count == 4)
        #expect(store.lastError == nil)
        #expect(changes == 1)
        let id = environmentId(repo: "alertd-core", kind: .container, branch: "feat/llm-insights")
        #expect(store.environment(id: id)?.state == .running)
        #expect(store.environment(id: "nope|worktree|x") == nil)
    }

    @Test func storeCoalescesGitEvents() async {
        let fake = FakeKunj()
        // A wide window: MainActor tests share the main thread with the rest of the parallel run.
        let store = makeStore(fake, coalesceMs: 250)
        await store.refreshAll()
        store.handle(.git(repoRoot: repoA.root))
        await sleepMs(5)
        store.handle(.git(repoRoot: repoA.root))
        await sleepMs(5)
        store.handle(.git(repoRoot: repoA.root))
        await sleepMs(600)
        // One scoped refresh: that repo's worktree list only, no ct list, no full listing.
        #expect(fake.count("wt:\(repoA.root)") == 2)
        #expect(fake.count("ct:\(repoA.root)") == 1)
        #expect(fake.count("wt:\(repoB.root)") == 1)
        #expect(fake.count("all") == 1)
    }

    @Test func containerEventRefreshesOnlyThatRepoContainers() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        fake.containersFail = true
        store.handle(.container(repoRoot: repoB.root, branch: "feat/llm-insights", container: "c", action: "status"))
        await sleepMs(150)
        #expect(fake.count("ct:\(repoB.root)") == 2)
        #expect(fake.count("wt:\(repoB.root)") == 1)
        #expect(fake.count("all") == 1)
        // The worktree half is kept and re-merged with the failed container half.
        #expect(store.repos[1].backend == .unavailable("Docker is not running"))
        #expect(store.repos[1].environments.map(\.kind) == [.worktree, .worktree, .worktree])
        #expect(store.repos[0].environments.count == 4)
    }

    @Test func gitEventKeepsContainers() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        store.handle(.git(repoRoot: repoA.root))
        await sleepMs(150)
        #expect(store.repos[0].environments.map(\.kind) == [.worktree, .worktree, .worktree, .container])
        #expect(store.repos[0].backend == .docker)
    }

    @Test func backendEventRefreshesAll() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        store.handle(.backend(available: false, message: "down"))
        store.handle(.registry(kind: "sessions", repoRoot: repoA.root))
        await sleepMs(150)
        #expect(fake.count("all") == 2)
    }

    @Test func fullRefreshSwallowsPendingScopedOnes() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        store.handle(.git(repoRoot: repoA.root))
        store.handle(.registry(kind: "repos", repoRoot: nil))
        store.handle(.container(repoRoot: repoB.root, branch: nil, container: "c", action: "die"))
        await sleepMs(150)
        #expect(fake.count("all") == 2)
        #expect(fake.count("wt:\(repoA.root)") == 2) // from the second full listing only
        #expect(fake.count("ct:\(repoB.root)") == 2)
    }

    @Test func eventsWithoutAKnownRepoRefreshAll() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        store.handle(.git(repoRoot: "/somewhere/else"))
        await sleepMs(150)
        #expect(fake.count("all") == 2)
        store.handle(.agent(session: "s", running: false, state: nil, repoRoot: nil))
        await sleepMs(150)
        #expect(fake.count("all") == 3)
        store.handle(.container(repoRoot: nil, branch: nil, container: "c", action: "die"))
        await sleepMs(150)
        #expect(fake.count("all") == 4)
    }

    @Test func agentEventWithRepoRefreshesItsWorktrees() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        store.handle(.agent(session: "kunj-x", running: true, state: "waiting", repoRoot: repoA.root))
        await sleepMs(150)
        #expect(fake.count("wt:\(repoA.root)") == 2)
        #expect(fake.count("all") == 1)
    }

    @Test func helloAfterARestartRefreshesAll() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        store.handle(.hello(version: "1.3.0", repos: 2))
        await sleepMs(150)
        #expect(fake.count("all") == 1) // the first hello follows the initial refresh
        store.handle(.hello(version: "1.3.0", repos: 2))
        await sleepMs(150)
        #expect(fake.count("all") == 2)
    }

    @Test func storeKeepsWorktreesWhenContainersFail() async {
        let fake = FakeKunj()
        fake.containersFail = true
        let store = makeStore(fake)
        await store.refreshAll()
        #expect(store.repos[0].backend == .unavailable("Docker is not running"))
        #expect(!store.repos[0].environments.isEmpty)
    }

    @Test func failedScopedWorktreeRefreshKeepsLastResultAndReportsIt() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        fake.worktreesFail = true
        await store.refreshRepo(root: repoA.root)
        #expect(store.repos[0].environments.count == 4)
        #expect(store.lastError?.message == "worktree list failed")
        fake.worktreesFail = false
        await store.refreshRepo(root: repoA.root)
        #expect(store.lastError == nil)
    }

    @Test func refreshRepoRunsBothHalves() async {
        let fake = FakeKunj()
        let store = makeStore(fake)
        await store.refreshAll()
        await store.refreshRepo(root: repoB.root)
        #expect(fake.count("wt:\(repoB.root)") == 2)
        #expect(fake.count("ct:\(repoB.root)") == 2)
        #expect(fake.count("all") == 1)
    }

    @Test func streamEventsReachTheStore() async {
        let fake = FakeKunj()
        let store = EnvironmentStore(
            cli: fakeKunjCLI(), coalesceMs: 20, lister: { _ in fake.list() },
            worktrees: { _, repo in try fake.worktrees(repo) }, containers: { _, repo in fake.containers(repo) })
        await store.refreshAll()
        let stream = store.makeEventStream(backoff: 0.05...0.1)
        store.start(events: stream)
        // events.ndjson ends with a backend event, which refreshes everything.
        let ok = await waitUntil(3) { fake.count("all") >= 2 }
        await stream.stop()
        #expect(ok)
    }

    @Test func aChangedRepositorySetRestartsTheStream() async {
        // kunj events watches the repositories it found at start: a repo added (or hidden) later
        // is only watched after a restart.
        let fake = FakeKunj()
        let store = makeStore(fake, coalesceMs: 20)
        await store.refreshAll()
        let stream = store.makeEventStream(backoff: 0.05...0.1)
        store.start(events: stream)
        // events.ndjson's backend event runs a full refresh; the same repositories: no restart.
        #expect(await waitUntil(3) { fake.count("all") >= 2 })
        await sleepMs(100)
        #expect(stream.restarts == 0)
        fake.extraRepos = [RepoRef(name: "new", root: "/r/new", bare: false)]
        store.handle(.registry(kind: "repos", repoRoot: nil))
        let ok = await waitUntil(3) { stream.restarts == 1 }
        await stream.stop()
        #expect(ok)
        #expect(store.repos.map(\.repo.root) == [repoA.root, repoB.root, "/r/new"])
    }

    @Test func aFailedListingDoesNotRestartTheStream() async {
        let fake = FakeKunj()
        var fail = false
        let store = EnvironmentStore(
            cli: fakeKunjCLI(), coalesceMs: 20,
            lister: { _ in fail ? ([], KunjCLIError(code: .commandFailed, message: "repos failed")) : fake.list() },
            worktrees: { _, repo in try fake.worktrees(repo) }, containers: { _, repo in fake.containers(repo) })
        await store.refreshAll()
        let stream = store.makeEventStream(backoff: 0.05...0.1)
        store.start(events: stream)
        #expect(await waitUntil(3) { stream.pid != nil })
        fail = true
        await store.refreshAll()
        await sleepMs(200)
        await stream.stop()
        #expect(stream.restarts == 0)
    }
}
