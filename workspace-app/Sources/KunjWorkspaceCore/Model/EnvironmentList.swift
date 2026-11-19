import Foundation

/// The container backend of a repository: Docker answered, or `ct list` failed (Docker stopped),
/// in which case the repository's worktrees still show.
public enum BackendState: Equatable, Sendable {
    case docker
    case unavailable(String)
}

public struct RepoEnvironments: Equatable, Sendable {
    public var repo: RepoRef
    public var backend: BackendState
    public var environments: [Environment]
    /// Where a new container can run: this Mac and each registered remote, as the last `ct list`
    /// reported them. Empty when the listing failed or kunj lists one backend only.
    public var backends: [ContainerListJson.BackendInfo]
    /// The repository's default backend when it is a remote (`container.remote`); nil for this Mac
    public var defaultRemote: String?

    public init(repo: RepoRef, backend: BackendState, environments: [Environment],
                backends: [ContainerListJson.BackendInfo] = [], defaultRemote: String? = nil) {
        self.repo = repo
        self.backend = backend
        self.environments = environments
        self.backends = backends
        self.defaultRemote = defaultRemote
    }
}

/// One entry of the New session sheet's "Run on" popup.
public struct RunOnChoice: Equatable, Sendable {
    /// "This Mac" or the remote's name, with "(not answering)" when it did not answer the listing
    public var title: String
    /// What `--remote` gets: `local` or the remote's name
    public var remote: String
    public var available: Bool
}

/// The "Run on" popup for a repository: this Mac first, then its remotes, and the index to
/// preselect (the default backend when it answers, else the first that does). Empty when no remote
/// is registered, so the sheet shows no popup and `kunj ct start` picks the backend as before.
public func runOnChoices(_ group: RepoEnvironments) -> (choices: [RunOnChoice], selected: Int) {
    guard group.backends.contains(where: { $0.remote != nil }) else { return ([], 0) }
    let choices = group.backends.map { b in
        let name = b.remote ?? "This Mac"
        return RunOnChoice(title: b.available ? name : "\(name) (not answering)",
                           remote: b.remote ?? localRemote, available: b.available)
    }
    let wanted = group.defaultRemote ?? localRemote
    let selected = choices.firstIndex { $0.remote == wanted && $0.available }
        ?? choices.firstIndex { $0.available } ?? 0
    return (choices, selected)
}

private func byBranch(_ a: Environment, _ b: Environment) -> Bool {
    a.branch.localizedStandardCompare(b.branch) == .orderedAscending
}

func parseDate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

/// Builds a repository's environments from its `worktree list` and `ct list` results: worktrees by
/// branch (bare and detached entries skipped), then containers by branch.
public func mergeEnvironments(
    repo: RepoRef, worktrees: WorktreeListJson?, containers: Result<ContainerListJson, KunjCLIError>
) -> RepoEnvironments {
    let trees: [Environment] = (worktrees?.worktrees ?? []).compactMap { w in
        guard !w.bare, !w.detached, let branch = w.branch else { return nil }
        let agent = w.agent
        return Environment(
            id: environmentId(repo: repo.name, kind: .worktree, branch: branch), kind: .worktree, repo: repo,
            branch: branch, path: w.path, containerName: nil, state: w.exists ? .ok : .missing,
            agent: agent.map { agentActivity(running: $0.running, state: $0.state) } ?? .unknown,
            agentSession: agent?.session, dirty: w.status?.dirty, changedFiles: w.status?.changedFiles ?? w.changedFiles,
            ahead: w.status?.ahead, behind: w.status?.behind, upstream: w.status?.upstream,
            pullRequest: w.pullRequest, ports: [], services: [], createdAt: nil, exists: w.exists, isMain: w.isMain,
            agentSessions: agent?.sessions)
    }.sorted(by: byBranch)

    var backend = BackendState.docker
    var boxes: [Environment] = []
    var backends: [ContainerListJson.BackendInfo] = []
    var defaultRemote: String?
    switch containers {
    case .failure(let error):
        backend = .unavailable(error.message)
    case .success(let list):
        backends = list.backends ?? []
        defaultRemote = list.backend.remote
        // No backend answered for containers: none can be made, as when Docker is stopped
        if !backends.isEmpty, !backends.contains(where: \.available) {
            backend = .unavailable(backends.compactMap(\.message).first ?? "No container backend answered")
        }
        var seen = Set<String>()
        boxes = list.containers.compactMap { c -> Environment? in
            // One row per branch: the same branch on a second backend would share this row's id,
            // its tabs and its saved layout, so only the first listed is shown
            guard seen.insert(c.branch).inserted else { return nil }
            let running = c.state == "running"
            var env = Environment(
                id: environmentId(repo: repo.name, kind: .container, branch: c.branch), kind: .container,
                repo: repo, branch: c.branch, path: nil, containerName: c.name,
                state: running ? .running : .stopped,
                agent: running ? agentActivity(running: c.agent.running, state: c.agent.state) : .none,
                agentSession: nil, dirty: c.workspace.dirty, changedFiles: nil, ahead: c.workspace.ahead,
                behind: nil, upstream: nil, pullRequest: nil,
                ports: c.ports.map { PortInfo(container: $0.container, host: $0.host, kind: $0.kind, service: $0.service) },
                services: c.services, createdAt: parseDate(c.createdAt), exists: true, isMain: false,
                agentSessions: running ? c.agent.sessions : nil)
            env.remote = c.remote
            env.machine = c.machine
            return env
        }
        // A machine with no container row (asleep, or not answering) is still where its branch lives:
        // shown as a stopped container, so Start wakes it. Never listed twice for one branch.
        for m in list.machines ?? [] {
            guard seen.insert(m.branch).inserted else { continue }
            var env = Environment(
                id: environmentId(repo: repo.name, kind: .container, branch: m.branch), kind: .container,
                // Awake but its containers were not listed (slow to answer, or none yet): it can still
                // be used, so it is not shown as stopped, which would disable Shell and Agent
                repo: repo, branch: m.branch, path: nil, containerName: nil, state: m.state == "running" ? .running : .stopped, agent: .none,
                agentSession: nil, dirty: nil, changedFiles: nil, ahead: nil, behind: nil, upstream: nil,
                pullRequest: nil, ports: [], services: [], createdAt: nil, exists: true, isMain: false)
            env.remote = m.remote
            env.machine = MachineInfo(name: m.name, state: m.state, size: m.size)
            boxes.append(env)
        }
        boxes.sort(by: byBranch)
    }
    return RepoEnvironments(repo: repo, backend: backend, environments: trees + boxes,
                            backends: backends, defaultRemote: defaultRemote)
}

func asCLIError(_ error: Error) -> KunjCLIError {
    error as? KunjCLIError ?? KunjCLIError(code: .commandFailed, message: "\(error)")
}

/// One repository's `kunj worktree list --json`, run in its root (the store's scoped refresh after a
/// `git` or `agent` event).
public func listWorktrees(cli: KunjCLI, repo: RepoRef) async throws -> WorktreeListJson {
    do {
        return try await cli.run(["worktree", "list"], cwd: repo.root)
    } catch {
        throw asCLIError(error)
    }
}

/// One repository's `kunj ct list --json`, run in its root; a failure (Docker stopped) is a value,
/// because it marks the backend unavailable rather than dropping the repository.
public func listContainers(cli: KunjCLI, repo: RepoRef) async -> Result<ContainerListJson, KunjCLIError> {
    do {
        return .success(try await cli.run(["ct", "list"], cwd: repo.root))
    } catch {
        return .failure(asCLIError(error))
    }
}

/// The full listing: `kunj repos`, then per repository (hidden and missing ones skipped)
/// `worktree list` and `ct list` in parallel, each run in the repository's root. A failing
/// `ct list` marks the backend unavailable; a failing `worktree list` drops the repository.
/// The error is `repos`' failure, else the first dropped repository's.
public func listEnvironments(cli: KunjCLI) async -> ([RepoEnvironments], KunjCLIError?) {
    let known: ReposJson
    do {
        known = try await cli.run(["repos"], cwd: NSHomeDirectory())
    } catch {
        return ([], asCLIError(error))
    }
    let repos = known.repos
        .filter { $0.exists && $0.hidden != true }
        .map { RepoRef(name: $0.name, root: $0.root, bare: $0.bare, dirName: $0.kunjDirName) }

    let results = await withTaskGroup(of: (Int, Result<RepoEnvironments, KunjCLIError>).self) { group in
        for (i, repo) in repos.enumerated() {
            group.addTask {
                async let trees = listWorktrees(cli: cli, repo: repo)
                async let boxes = listContainers(cli: cli, repo: repo)
                let containers = await boxes
                do {
                    let worktrees = try await trees
                    return (i, .success(mergeEnvironments(repo: repo, worktrees: worktrees, containers: containers)))
                } catch {
                    let e = asCLIError(error)
                    NSLog("kunj worktree list failed in %@: %@", repo.root, e.message)
                    return (i, .failure(e))
                }
            }
        }
        var out: [(Int, Result<RepoEnvironments, KunjCLIError>)] = []
        for await r in group { out.append(r) }
        return out.sorted { $0.0 < $1.0 }.map(\.1)
    }

    var list: [RepoEnvironments] = []
    var firstError: KunjCLIError?
    for r in results {
        switch r {
        case .success(let env): list.append(env)
        case .failure(let e): if firstError == nil { firstError = e }
        }
    }
    return (list, firstError)
}
