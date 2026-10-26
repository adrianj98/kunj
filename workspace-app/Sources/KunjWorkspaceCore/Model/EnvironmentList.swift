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

    public init(repo: RepoRef, backend: BackendState, environments: [Environment]) {
        self.repo = repo
        self.backend = backend
        self.environments = environments
    }
}

private func byBranch(_ a: Environment, _ b: Environment) -> Bool {
    a.branch.localizedStandardCompare(b.branch) == .orderedAscending
}

private func parseDate(_ s: String) -> Date? {
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
    switch containers {
    case .failure(let error):
        backend = .unavailable(error.message)
    case .success(let list):
        boxes = list.containers.map { c in
            let running = c.state == "running"
            return Environment(
                id: environmentId(repo: repo.name, kind: .container, branch: c.branch), kind: .container,
                repo: repo, branch: c.branch, path: nil, containerName: c.name,
                state: running ? .running : .stopped,
                agent: running ? agentActivity(running: c.agent.running, state: c.agent.state) : .none,
                agentSession: nil, dirty: c.workspace.dirty, changedFiles: nil, ahead: c.workspace.ahead,
                behind: nil, upstream: nil, pullRequest: nil,
                ports: c.ports.map { PortInfo(container: $0.container, host: $0.host, kind: $0.kind, service: $0.service) },
                services: c.services, createdAt: parseDate(c.createdAt), exists: true, isMain: false,
                agentSessions: running ? c.agent.sessions : nil)
        }.sorted(by: byBranch)
    }
    return RepoEnvironments(repo: repo, backend: backend, environments: trees + boxes)
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
