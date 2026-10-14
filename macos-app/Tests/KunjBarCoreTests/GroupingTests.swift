import CoreGraphics
import Testing
@testable import KunjBarCore

private func window(_ id: UInt32, _ kind: WindowKind) -> FoundWindow {
    FoundWindow(id: id, pid: 1, kind: kind, title: "", documentPath: nil,
                frame: CGRect(x: 0, y: 0, width: 10, height: 10), minimized: false)
}

private let a = WorktreeRef(path: "/a", name: "a")
private let b = WorktreeRef(path: "/b", name: "b")
private let c = WorktreeRef(path: "/c", name: "c")

@Test func anEditorAndTerminalOfOneWorktreeShareADesktop() {
    let e = window(1, .editor), t = window(2, .terminal)
    let groups = groupWindows([(a, [t, e])])
    #expect(groups.map { $0.windows.map(\.id) } == [[1, 2]])
    #expect(groups.map(\.worktrees) == [[a]])
}

@Test func loneWindowsOfDifferentWorktreesArePairedUp() {
    let groups = groupWindows([(a, [window(1, .editor)]), (b, [window(2, .editor)]), (c, [window(3, .terminal)])])
    #expect(groups.map { $0.windows.map(\.id) } == [[1, 2], [3]])
    #expect(groups.map(\.worktrees) == [[a, b], [c]])
}

@Test func fullPairsComeFirstThenTheLooseOnes() {
    let groups = groupWindows([(a, [window(1, .editor)]), (b, [window(2, .editor), window(3, .terminal)]), (c, [window(4, .terminal)])])
    #expect(groups.map { $0.windows.map(\.id) } == [[2, 3], [1, 4]])
    #expect(groups.map(\.worktrees) == [[b], [a, c]])
}

@Test func threeWindowsOfOneWorktreeMakeAPairAndALooseOne() {
    let groups = groupWindows([(a, [window(1, .editor), window(2, .terminal), window(3, .terminal)]), (b, [window(4, .editor)])])
    #expect(groups.map { $0.windows.map(\.id) } == [[1, 2], [3, 4]])
}

@Test func editorsGoBeforeTerminalsWithinAWorktree() {
    let groups = groupWindows([(a, [window(1, .terminal), window(2, .terminal), window(3, .editor)])])
    #expect(groups.map { $0.windows.map(\.id) } == [[3, 1], [2]])
}
