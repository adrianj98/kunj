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

    /// A Latin-1 (or any non-UTF-8) file has no NUL byte, but FileAccess and `kunj ct file read`
    /// decode it lossily: its bytes come back as U+FFFD, and saving would write those instead.
    @Test func refusesTextThatWasNotUTF8() {
        let latin1 = Data([0x63, 0x61, 0x66, 0xE9, 0x0A]) // "café\n" in ISO-8859-1
        let decoded = String(decoding: latin1, as: UTF8.self)
        #expect(editorRefusal(decoded) == "This file is not UTF-8 text")
        #expect(editorRefusal("café\n") == nil)
    }
}
