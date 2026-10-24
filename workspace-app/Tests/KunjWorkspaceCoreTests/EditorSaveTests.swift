import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct EditorSaveTests {
    @Test func unchangedOnDiskWrites() {
        let opened = digest("a\n")
        #expect(saveDecision(onDisk: "a\n", openedDigest: opened, content: "b\n") == .write)
    }

    @Test func changedOnDiskIsAConflict() {
        let opened = digest("a\n")
        #expect(saveDecision(onDisk: "c\n", openedDigest: opened, content: "b\n") == .conflict(deleted: false))
    }

    @Test func deletedOnDiskIsAConflict() {
        #expect(saveDecision(onDisk: nil, openedDigest: digest("a\n"), content: "b\n") == .conflict(deleted: true))
    }

    /// Someone else already wrote exactly what is being saved: nothing to write, nothing to ask.
    @Test func diskAlreadyHoldsTheContent() {
        #expect(saveDecision(onDisk: "b\n", openedDigest: digest("a\n"), content: "b\n") == .alreadySaved)
    }

    @Test func titleIsTheFileName() {
        #expect(editorTabTitle("src/routes/usage-rollup.ts") == "usage-rollup.ts")
        #expect(editorTabTitle("README.md") == "README.md")
    }

    @Test func refusesBinaryAndHugeFiles() {
        #expect(editorRefusal("let a = 1\n") == nil)
        #expect(editorRefusal("PNG\u{0}\u{1}") == "This looks like a binary file")
        #expect(editorRefusal(String(repeating: "x", count: maxEditableBytes + 1)) == "This file is too large to edit here (over 5 MB)")
    }
}
