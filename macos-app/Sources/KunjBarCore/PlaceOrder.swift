// Order of a repository's rows when worktrees and branch containers are listed together: a
// container is another place a branch lives, so it sits right after its branch's worktree;
// containers of branches without a worktree follow, by name. Branch names match exactly
// (`feature/x` and `feature-x` are different branches).

public enum Place<W, C> {
    case worktree(W)
    case container(C)
}

public func interleavePlaces<W, C>(
    worktrees: [W], branchOf: (W) -> String?,
    containers: [C], containerBranch: (C) -> String
) -> [Place<W, C>] {
    var byBranch: [String: [C]] = [:]
    var order: [String] = []
    for container in containers {
        let branch = containerBranch(container)
        if byBranch[branch] == nil { order.append(branch) }
        byBranch[branch, default: []].append(container)
    }
    var rows: [Place<W, C>] = []
    for worktree in worktrees {
        rows.append(.worktree(worktree))
        if let branch = branchOf(worktree), let matched = byBranch.removeValue(forKey: branch) {
            rows += matched.map { .container($0) }
        }
    }
    for branch in order.sorted() {
        if let rest = byBranch[branch] { rows += rest.map { .container($0) } }
    }
    return rows
}
