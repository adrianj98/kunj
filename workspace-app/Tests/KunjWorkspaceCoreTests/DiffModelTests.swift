import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct DiffModelTests {
    @Test func parseNumstatWithRenameAndBinary() {
        let rows = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n0\t0\t{old => new}/x.ts\n2\t0\tsrc/{ => sub}/y.ts\n1\t1\ta.txt => b.txt\n")
        #expect(rows.count == 5)
        #expect(rows[0].path == "src/a.ts" && rows[0].oldPath == nil && rows[0].added == 3 && rows[0].deleted == 1)
        #expect(rows[1].path == "img.png" && rows[1].added == 0 && rows[1].deleted == 0)
        #expect(rows[2].path == "new/x.ts" && rows[2].oldPath == "old/x.ts")
        #expect(rows[3].path == "src/sub/y.ts" && rows[3].oldPath == "src/y.ts")
        #expect(rows[4].path == "b.txt" && rows[4].oldPath == "a.txt")
    }

    @Test func parseNumstatUnquotesCStylePaths() {
        let rows = parseNumstat("1\t0\t\"with\\ttab.txt\"\n1\t0\t\"quote\\\"d.txt\"\n")
        #expect(rows.map(\.path) == ["with\ttab.txt", "quote\"d.txt"])
    }

    @Test func parseNameStatus() {
        let map = KunjWorkspaceCore.parseNameStatus("A\tnew.ts\nR100\told.ts\tnew2.ts\nD\tgone.ts\nM\tsrc/m.ts\nT\tlink\n")
        #expect(map == ["new.ts": .added, "new2.ts": .renamed, "gone.ts": .deleted, "src/m.ts": .modified,
                        "link": .modified])
    }

    @Test func diffArgsPerScope() {
        let base = diffArgs(scope: .base, mergeBase: "abc123")
        #expect(base.list == [["diff", "--numstat", "-M", "abc123"], ["diff", "--name-status", "-M", "abc123"]])
        #expect(base.contentRefs.old == "abc123" && base.contentRefs.new == nil)

        let uncommitted = diffArgs(scope: .uncommitted, mergeBase: nil)
        #expect(uncommitted.list == [["diff", "--numstat", "-M", "HEAD"], ["diff", "--name-status", "-M", "HEAD"]])
        #expect(uncommitted.contentRefs.old == "HEAD" && uncommitted.contentRefs.new == nil)

        let last = diffArgs(scope: .last, mergeBase: nil)
        #expect(last.list == [["diff", "--numstat", "-M", "HEAD~1", "HEAD"],
                              ["diff", "--name-status", "-M", "HEAD~1", "HEAD"]])
        #expect(last.contentRefs.old == "HEAD~1" && last.contentRefs.new == "HEAD")
    }

    @Test func scopeLabels() {
        #expect(DiffScope.allCases == [.base, .uncommitted, .last])
        #expect(DiffScope.uncommitted.label == "Uncommitted")
        #expect(DiffScope.last.label == "Last commit")
        #expect(DiffScope.base.label(base: "origin/main") == "vs origin/main")
    }

    @Test func chooseBase() {
        #expect(KunjWorkspaceCore.chooseBase(prBase: "develop", originHead: "origin/main",
                                             branches: ["origin/develop", "origin/main"]) == "origin/develop")
        // A PR base that was never fetched is skipped (the app never fetches)
        #expect(KunjWorkspaceCore.chooseBase(prBase: "develop", originHead: "origin/main",
                                             branches: ["origin/main"]) == "origin/main")
        #expect(KunjWorkspaceCore.chooseBase(prBase: nil, originHead: "origin/main", branches: []) == "origin/main")
        #expect(KunjWorkspaceCore.chooseBase(prBase: nil, originHead: nil, branches: ["origin/main", "origin/master"])
                == "origin/main")
        #expect(KunjWorkspaceCore.chooseBase(prBase: nil, originHead: nil, branches: ["origin/master"]) == "origin/master")
    }

    @Test func summaryTotals() {
        let s = DiffSummary(files: [
            ChangedFile(path: "a", oldPath: nil, status: .modified, added: 3, deleted: 1),
            ChangedFile(path: "b", oldPath: nil, status: .added, added: 10, deleted: 0),
        ])
        #expect(s.added == 13 && s.deleted == 1)
    }

    @Test func gitArgvWorktreeAndContainer() {
        let cli = KunjCLI(command: "kunj", path: "/usr/bin:/bin")
        let wt = gitArgv(.worktree(path: "/w/x"), cli: cli, ["status"])
        #expect(wt.argv == ["/usr/bin/git", "-C", "/w/x", "status"])
        #expect(wt.cwd == "/w/x")
        #expect(wt.env["GIT_OPTIONAL_LOCKS"] == "0")

        let ct = gitArgv(.container(branch: "feature/x", repoRoot: "/r"), cli: cli, ["status"])
        #expect(ct.argv == ["/usr/bin/env", "kunj", "ct", "exec", "feature/x", "--", "git", "status"])
        #expect(ct.cwd == "/r")
        #expect(ct.env["GIT_OPTIONAL_LOCKS"] == "0")
        #expect(ct.env["PATH"] == "/usr/bin:/bin")
    }
}
