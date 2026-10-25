import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct TerminalLinkTests {
    let root = "/Users/me/repo/.git/kunj/worktrees/feat"

    @Test func relativePathResolvesAgainstTheRoot() {
        #expect(terminalLinkPaths("src/lib/serve/streams.ts", root: root) == ["src/lib/serve/streams.ts"])
        #expect(terminalLinkPaths("./README.md", root: root) == ["README.md"])
    }

    @Test func lineAndColumnSuffixesAreDropped() {
        #expect(terminalLinkPaths("src/a.ts:12", root: root) == ["src/a.ts"])
        #expect(terminalLinkPaths("src/a.ts:12:5", root: root) == ["src/a.ts"])
        #expect(terminalLinkPaths("README.md:3", root: root) == ["README.md"])
        #expect(terminalLinkPaths("src/a.ts#L4-L9", root: root) == ["src/a.ts"])
    }

    @Test func absoluteAndFileURLsInsideTheRoot() {
        #expect(terminalLinkPaths(root + "/src/a.ts", root: root) == ["src/a.ts"])
        #expect(terminalLinkPaths("file://" + root + "/src/a.ts", root: root) == ["src/a.ts"])
        #expect(terminalLinkPaths("/workspace/src/a.ts", root: "/workspace") == ["src/a.ts"])
    }

    @Test func outsideTheRootOrOtherSchemesGiveNothing() {
        #expect(terminalLinkPaths("/etc/hosts", root: root).isEmpty)
        #expect(terminalLinkPaths("../other/a.ts", root: root).isEmpty)
        #expect(terminalLinkPaths("src/../../a.ts", root: root).isEmpty)
        #expect(terminalLinkPaths("https://example.com/a.ts", root: root).isEmpty)
        #expect(terminalLinkPaths("mailto:me@example.com", root: root).isEmpty)
        #expect(terminalLinkPaths(root, root: root).isEmpty)
        #expect(terminalLinkPaths("/workspacex/a.ts", root: "/workspace").isEmpty)
    }

    @Test func theShellsDirectoryComesFirst() {
        #expect(terminalLinkPaths("a.ts", root: root, cwd: "file://host" + root + "/src")
                == ["src/a.ts", "a.ts"])
        // a directory outside the root is ignored
        #expect(terminalLinkPaths("a.ts", root: root, cwd: "/tmp") == ["a.ts"])
    }
}
