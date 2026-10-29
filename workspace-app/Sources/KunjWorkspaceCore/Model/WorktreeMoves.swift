import Foundation

/// A worktree whose branch changed between two listings: an agent ran `git checkout` in it. Its id
/// (`repo|worktree|branch`) changes with the branch, so its tabs, layout and selection move to `to`.
public struct WorktreeMove: Equatable, Sendable {
    public var from: Environment
    public var to: Environment
}

/// The worktrees listed at the same path under another branch. Only when the old id is gone and the
/// new one is new: a branch still listed elsewhere keeps its tabs, and one that was already listed
/// has its own.
public func worktreeMoves(from old: [RepoEnvironments], to new: [RepoEnvironments]) -> [WorktreeMove] {
    let oldIds = Set(old.flatMap { $0.environments.map(\.id) })
    let newIds = Set(new.flatMap { $0.environments.map(\.id) })
    var moves: [WorktreeMove] = []
    for repo in new {
        guard let before = old.first(where: { $0.repo.root == repo.repo.root }) else { continue }
        for env in repo.environments where env.kind == .worktree && !oldIds.contains(env.id) {
            guard let path = env.path,
                  let prior = before.environments.first(where: {
                      $0.kind == .worktree && $0.path == path && $0.id != env.id && !newIds.contains($0.id)
                  }) else { continue }
            moves.append(WorktreeMove(from: prior, to: env))
        }
    }
    return moves
}
