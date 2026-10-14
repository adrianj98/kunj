import CoreGraphics
import Testing
@testable import KunjBarCore

private let feature = WorktreeRef(path: "/r/wt/feature", name: "feature")
private let feature2 = WorktreeRef(path: "/r/wt/feature-2", name: "feature-2")

private func window(_ id: UInt32, _ kind: WindowKind, title: String, document: String? = nil) -> FoundWindow {
    FoundWindow(id: id, pid: 1, kind: kind, title: title, documentPath: document,
                frame: CGRect(x: 0, y: 0, width: 100, height: 100), minimized: false)
}

@Test func terminalMatchesByDocumentPathInsideTheWorktree() {
    let w = window(1, .terminal, title: "src", document: "/r/wt/feature/src")
    let m = matchWindows([w], worktrees: [feature, feature2])
    #expect(m["/r/wt/feature"] == [w])
    #expect(m["/r/wt/feature-2"] == nil)
}

@Test func documentPathDoesNotMatchAPrefixOfAnotherWorktree() {
    let w = window(1, .terminal, title: "feature-2", document: "/r/wt/feature-2")
    let m = matchWindows([w], worktrees: [feature, feature2])
    #expect(m["/r/wt/feature-2"] == [w])
    #expect(m["/r/wt/feature"] == nil)
}

@Test func editorTitleMatchesTheLongestWorktreeName() {
    let w = window(1, .editor, title: "main.ts — feature-2 — Visual Studio Code")
    let m = matchWindows([w], worktrees: [feature, feature2])
    #expect(m["/r/wt/feature-2"] == [w])
    #expect(m["/r/wt/feature"] == nil)
}

@Test func twoWorktreesWithTheSameNameShareNoWindow() {
    let a = WorktreeRef(path: "/p/kunj", name: "kunj")
    let b = WorktreeRef(path: "/p/kunj/.git/kunj/worktrees/kunj", name: "kunj")
    let w = window(1, .editor, title: "README.md — kunj — Visual Studio Code")
    let m = matchWindows([w], worktrees: [a, b])
    #expect(m["/p/kunj"] == [w])
    #expect(m[b.path] == nil)
}

@Test func aNameInsideAnotherWordDoesNotMatch() {
    let w = window(1, .editor, title: "feature-branch — Code")
    #expect(matchWindows([w], worktrees: [feature]).isEmpty)
}

@Test func terminalWithoutDocumentFallsBackToTheTitle() {
    let w = window(1, .terminal, title: "feature — -zsh — 80x24")
    #expect(matchWindows([w], worktrees: [feature])["/r/wt/feature"] == [w])
}

@Test func unmatchedWindowsAreAbsent() {
    let w = window(1, .editor, title: "notes.md — other — Visual Studio Code")
    #expect(matchWindows([w], worktrees: [feature, feature2]).isEmpty)
}

@Test func titleMatchesWholePathComponentsOnly() {
    #expect(titleMatches("feature", name: "feature"))
    #expect(titleMatches("a/feature/b", name: "feature"))
    #expect(titleMatches("[feature] x", name: "feature"))
    #expect(titleMatches("feature: x", name: "feature"))
    #expect(!titleMatches("feature2", name: "feature"))
    #expect(!titleMatches("myfeature", name: "feature"))
}
