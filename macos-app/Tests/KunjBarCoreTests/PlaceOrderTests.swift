import Testing
@testable import KunjBarCore

private func order(_ worktrees: [(String, String?)], _ containers: [String]) -> [String] {
    interleavePlaces(worktrees: worktrees, branchOf: { $0.1 }, containers: containers, containerBranch: { $0 }).map {
        switch $0 {
        case .worktree(let w): return "wt:\(w.0)"
        case .container(let c): return "ct:\(c)"
        }
    }
}

@Test func aContainerFollowsItsBranchsWorktree() {
    #expect(order([("main", "main"), ("feat", "feature/x")], ["feature/x"]) == ["wt:main", "wt:feat", "ct:feature/x"])
}

@Test func containersWithoutAWorktreeComeLastByName() {
    #expect(order([("main", "main")], ["zeta", "alpha"]) == ["wt:main", "ct:alpha", "ct:zeta"])
}

@Test func branchNamesMatchExactly() {
    #expect(order([("fx", "feature-x")], ["feature/x"]) == ["wt:fx", "ct:feature/x"])
    #expect(order([("fx", "feature/x")], ["feature-x", "feature/x"]) == ["wt:fx", "ct:feature/x", "ct:feature-x"])
}

@Test func aDetachedWorktreeAndDuplicateBranchesKeepEveryRow() {
    #expect(order([("det", nil)], ["a", "a"]) == ["wt:det", "ct:a", "ct:a"])
}

@Test func theWorktreesKeepTheirOrder() {
    #expect(order([("b", "b"), ("a", "a")], ["a", "b"]) == ["wt:b", "ct:b", "wt:a", "ct:a"])
}
