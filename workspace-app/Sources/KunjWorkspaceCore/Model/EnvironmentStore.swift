import Foundation

/// The views' only source of environments. A full refresh is `lister` (`listEnvironments`); events
/// from `kunj events` refresh only what changed, coalesced per key for `coalesceMs` (the first
/// event starts the timer): `git` and `agent` re-run that repository's `worktree list`, `container`
/// its `ct list` (which execs into every container), and `sessions`/`forwards`/`repos`/`backend`,
/// a `hello` after a stream restart, or an event for a repository the store does not know, run
/// everything. A scoped result replaces only its half of the repository's environments (worktrees
/// or containers), so it is re-merged with the other half. Refreshes run one at a time, in order.
/// `kunj events` watches the repositories it found at start, so a clean full listing whose roots
/// differ from those restarts the stream (its `hello` then refreshes everything again).
@MainActor
public final class EnvironmentStore {
    public typealias Lister = (KunjCLI) async -> ([RepoEnvironments], KunjCLIError?)
    public typealias WorktreeLister = (KunjCLI, RepoRef) async throws -> WorktreeListJson
    public typealias ContainerLister = (KunjCLI, RepoRef) async -> Result<ContainerListJson, KunjCLIError>

    public let cli: KunjCLI
    public private(set) var repos: [RepoEnvironments] = []
    public private(set) var lastError: KunjCLIError?
    /// Called on the main actor after a refresh that changed `repos` or `lastError`.
    public var onChange: (() -> Void)?

    private let coalesceMs: Int
    private let lister: Lister
    private let worktrees: WorktreeLister
    private let containers: ContainerLister
    private var timers: [Key: Task<Void, Never>] = [:]
    private var tail: Task<Void, Never>?
    private var seenHello = false
    /// The repository whose scoped refresh set `lastError` (nil when a full refresh set it).
    private var errorRoot: String?
    private var events: EventStream?
    /// The repository roots the running `kunj events` was started with (as far as the store knows).
    private var watchedRoots: Set<String>?
    /// The roots of the last full listing that did not fail.
    private var cleanRoots: Set<String>?

    private enum Key: Hashable {
        case all
        case worktrees(String)
        case containers(String)
    }

    public init(cli: KunjCLI, coalesceMs: Int = 300,
                lister: @escaping Lister = { await listEnvironments(cli: $0) },
                worktrees: @escaping WorktreeLister = { try await listWorktrees(cli: $0, repo: $1) },
                containers: @escaping ContainerLister = { await listContainers(cli: $0, repo: $1) }) {
        self.cli = cli
        self.coalesceMs = coalesceMs
        self.lister = lister
        self.worktrees = worktrees
        self.containers = containers
    }

    public func environment(id: String) -> Environment? {
        for repo in repos {
            if let env = repo.environments.first(where: { $0.id == id }) { return env }
        }
        return nil
    }

    // MARK: refreshes

    public func refreshAll() async {
        await serial { await self.runAll() }
    }

    /// Both halves of one repository; a full refresh when the store does not know `root`.
    public func refreshRepo(root: String) async {
        await serial {
            guard self.index(of: root) != nil else { await self.runAll(); return }
            await self.runWorktrees(root: root)
            await self.runContainers(root: root)
        }
    }

    private func serial(_ work: @escaping @MainActor () async -> Void) async {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            await work()
        }
        tail = task
        await task.value
    }

    private func index(of root: String) -> Int? {
        repos.firstIndex { $0.repo.root == root }
    }

    private func publish(_ repos: [RepoEnvironments], _ error: KunjCLIError?) {
        let changed = repos != self.repos || error != lastError
        self.repos = repos
        lastError = error
        if changed { onChange?() }
    }

    private func runAll() async {
        let (list, error) = await lister(cli)
        errorRoot = nil
        publish(list, error)
        restartEventsIfReposChanged(list, error)
    }

    /// `kunj events` watches the repositories it found when it started, so a repository added,
    /// un-hidden or hidden since then needs a new child. Only a clean listing is compared: a failed
    /// one drops repositories that are still registered.
    private func restartEventsIfReposChanged(_ list: [RepoEnvironments], _ error: KunjCLIError?) {
        guard error == nil else { return }
        let roots = Set(list.map(\.repo.root))
        cleanRoots = roots
        guard let events else { return }
        guard let watched = watchedRoots else { watchedRoots = roots; return }
        guard roots != watched else { return }
        watchedRoots = roots
        events.restart()
    }

    private func runWorktrees(root: String) async {
        guard let i = index(of: root) else { return }
        let repo = repos[i].repo
        let fresh: [Environment]
        do {
            let list = try await worktrees(cli, repo)
            // Only the worktree half is used; the container argument is a placeholder.
            fresh = mergeEnvironments(repo: repo, worktrees: list,
                                      containers: .failure(KunjCLIError(code: .commandFailed, message: ""))).environments
        } catch {
            let e = asCLIError(error)
            NSLog("kunj worktree list failed in %@: %@", root, e.message)
            errorRoot = root
            publish(repos, e)
            return
        }
        guard let j = index(of: root) else { return }
        var next = repos
        next[j].environments = fresh + next[j].environments.filter { $0.kind == .container }
        publish(next, clearedError(for: root))
    }

    private func runContainers(root: String) async {
        guard let i = index(of: root) else { return }
        let repo = repos[i].repo
        let result = await containers(cli, repo)
        let merged = mergeEnvironments(repo: repo, worktrees: nil, containers: result)
        guard let j = index(of: root) else { return }
        var next = repos
        next[j].backend = merged.backend
        next[j].environments = next[j].environments.filter { $0.kind == .worktree } + merged.environments
        publish(next, lastError)
    }

    private func clearedError(for root: String) -> KunjCLIError? {
        guard errorRoot == root else { return lastError }
        errorRoot = nil
        return nil
    }

    // MARK: events

    public func handle(_ event: KunjEvent) {
        switch event {
        case .hello:
            if seenHello { schedule(.all) }
            seenHello = true
        case .git(let root), .agent(_, _, _, let root):
            scoped(root) { .worktrees($0) }
        case .container(let root, _, _, _):
            scoped(root) { .containers($0) }
        case .registry, .backend:
            schedule(.all)
        case .error(let code, let message):
            NSLog("kunj events: %@ (%@)", message, code ?? "no code")
        }
    }

    /// A stream whose events reach `handle` on the main actor.
    public func makeEventStream(backoff: ClosedRange<TimeInterval> = 1...30) -> EventStream {
        EventStream(cli: cli, onEvent: { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }, backoff: backoff)
    }

    /// Starts `events`, whose `onEvent` must call `handle` (see `makeEventStream`). The caller
    /// stops it (`await events.stop()`) before the app terminates.
    public func start(events: EventStream) {
        self.events = events
        watchedRoots = cleanRoots
        events.start()
    }

    private func scoped(_ root: String?, _ key: (String) -> Key) {
        guard let root, index(of: root) != nil else { schedule(.all); return }
        schedule(key(root))
    }

    private func schedule(_ key: Key) {
        if timers[.all] != nil { return }
        if key == .all {
            for (k, timer) in timers where k != .all { timer.cancel() }
            timers = timers.filter { $0.key == .all }
        }
        guard timers[key] == nil else { return }
        let delay = UInt64(max(0, coalesceMs)) * 1_000_000
        timers[key] = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self, !Task.isCancelled else { return }
            self.timers[key] = nil
            await self.serial {
                switch key {
                case .all: await self.runAll()
                case .worktrees(let root): await self.runWorktrees(root: root)
                case .containers(let root): await self.runContainers(root: root)
                }
            }
        }
    }
}
