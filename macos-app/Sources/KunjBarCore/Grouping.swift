// Which windows share a desktop: two per desktop. A worktree's editor and terminal go
// together; worktrees left with a single window are paired up with each other.

public struct WindowGroup: Equatable, Sendable {
    public let windows: [FoundWindow]
    // The worktrees the windows belong to, in order, without repeats
    public let worktrees: [WorktreeRef]
}

// `matched` lists each worktree's windows in panel order. Each worktree's windows, editors
// first, are cut into pairs; a worktree's odd window out is paired with the next
// worktree's, and a last one stands alone. Full pairs come first, then the loose pairs.
public func groupWindows(_ matched: [(WorktreeRef, [FoundWindow])]) -> [WindowGroup] {
    var pairs: [WindowGroup] = []
    var loose: [(WorktreeRef, FoundWindow)] = []
    for (worktree, windows) in matched {
        let ordered = windows.filter { $0.kind == .editor } + windows.filter { $0.kind == .terminal }
        var i = 0
        while i + 1 < ordered.count {
            pairs.append(WindowGroup(windows: [ordered[i], ordered[i + 1]], worktrees: [worktree]))
            i += 2
        }
        if i < ordered.count { loose.append((worktree, ordered[i])) }
    }
    var i = 0
    while i < loose.count {
        let slice = loose[i..<min(i + 2, loose.count)]
        var worktrees: [WorktreeRef] = []
        for (worktree, _) in slice where !worktrees.contains(worktree) { worktrees.append(worktree) }
        pairs.append(WindowGroup(windows: slice.map(\.1), worktrees: worktrees))
        i += 2
    }
    return pairs
}

// The worktrees that have windows, in panel order, followed by one entry per editor
// window that matched no listed worktree, so every editor window takes part. Terminals
// outside every worktree are left alone.
public func worktreeEntries(matched: [String: [FoundWindow]], worktrees: [WorktreeRef], windows: [FoundWindow]) -> [(WorktreeRef, [FoundWindow])] {
    var entries: [(WorktreeRef, [FoundWindow])] = worktrees.compactMap { worktree in
        matched[worktree.path].map { (worktree, $0) }
    }
    let matchedIDs = Set(matched.values.flatMap { $0 }.map(\.id))
    for window in windows where window.kind == .editor && !matchedIDs.contains(window.id) {
        entries.append((WorktreeRef(path: "window:\(window.id)", name: window.title), [window]))
    }
    return entries
}
