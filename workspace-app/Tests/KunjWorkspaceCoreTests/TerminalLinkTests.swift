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

    @Test func theSuffixSaysWhereInTheFile() {
        #expect(terminalLinkSpot("token.ts:33")! == (33, 1))
        #expect(terminalLinkSpot("src/a.ts:12:5")! == (12, 5))
        #expect(terminalLinkSpot("bob.ts:44-60")! == (44, 1))
        #expect(terminalLinkSpot("bob.ts:44-30")! == (44, 1))
        #expect(terminalLinkSpot("src/a.ts#L4-L9")! == (4, 1))
        #expect(terminalLinkSpot("src/a.ts") == nil)
        #expect(terminalLinkSpot("a.ts:0") == nil)
        // a range is dropped from the path like the other suffixes
        #expect(terminalLinkPaths("bob.ts:44-30", root: root) == ["bob.ts"])
    }

    @Test func aBareNameIsLookedForAmongTheFiles() {
        let files = ["README.md", "src/lib/secrets/token.ts", "src/token.ts", "src/lib/mytoken.ts", "test/lib/a.ts", "src/lib/a.ts"]
        #expect(terminalLinkName("token.ts:33") == "token.ts")
        #expect(terminalLinkName("./lib/a.ts:4") == "lib/a.ts")
        #expect(terminalLinkName("/etc/hosts") == nil)
        #expect(terminalLinkName("../a.ts") == nil)
        #expect(terminalLinkName("https://example.com/a.ts") == nil)
        #expect(terminalLinkMatches("token.ts:33", in: files, root: root) == ["src/token.ts", "src/lib/secrets/token.ts"])
        #expect(terminalLinkMatches("lib/a.ts:4-9", in: files, root: root) == ["src/lib/a.ts", "test/lib/a.ts"])
        #expect(terminalLinkMatches("README.md:1", in: files, root: root) == ["README.md"])
        #expect(terminalLinkMatches("nope.ts:1", in: files, root: root).isEmpty)
        // the shell's directory first
        #expect(terminalLinkMatches("a.ts", in: files, root: root, cwd: root + "/test/lib")
                == ["test/lib/a.ts", "src/lib/a.ts"])
    }
}
