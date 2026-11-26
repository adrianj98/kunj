import Foundation
import Testing
@testable import KunjWorkspaceCore

private func git(_ args: [String], in dir: URL) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = args
    p.currentDirectoryURL = dir
    var env = ProcessInfo.processInfo.environment
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    p.environment = env
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    p.waitUntilExit()
}

private func write(_ text: String, _ name: String, in dir: URL) throws {
    let url = dir.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
}

@Suite struct WorktreeChangesTests {
    let cli = KunjCLI(command: "kunj", path: "/usr/bin:/bin")

    @Test func foldersWithChangesAreEveryAncestorOfAnExistingChange() {
        let folders = foldersWithChanges(["src/a/x.ts": .modified, "src/b.ts": .added, "README.md": .modified,
                                          "gone/old.ts": .deleted])
        #expect(folders == ["src", "src/a"])
    }

    @Test func eventsInGitOrIgnoredFoldersDoNotMatter() {
        let ignored = ["node_modules", "packages/app/dist"]
        #expect(worktreeEventMatters("src/a.ts", ignoredDirectories: ignored))
        #expect(worktreeEventMatters(".gitignore", ignoredDirectories: ignored))
        #expect(worktreeEventMatters("node_modules_notes.md", ignoredDirectories: ignored))
        #expect(!worktreeEventMatters(".git", ignoredDirectories: ignored))
        #expect(!worktreeEventMatters(".git/kunj/worktrees/x/a.ts", ignoredDirectories: ignored))
        #expect(!worktreeEventMatters("node_modules", ignoredDirectories: ignored))
        #expect(!worktreeEventMatters("node_modules/x/index.js", ignoredDirectories: ignored))
        #expect(!worktreeEventMatters("packages/app/dist/main.js", ignoredDirectories: ignored))
    }

    /// Committed on the branch, modified and untracked files are all changes against origin/main
    @Test func changedPathsAreTheBranchAgainstItsBase() async throws {
        let root = try tempDirectory()
        let work = root.appendingPathComponent("work"), origin = root.appendingPathComponent("origin.git")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try git(["init", "--bare", "-q", "-b", "main", origin.path], in: root)
        try git(["init", "-q", "-b", "main"], in: work)
        try git(["config", "user.email", "t@example.com"], in: work)
        try git(["config", "user.name", "Test"], in: work)
        try write("a\n", "keep.txt", in: work)
        try write("a\n", "src/edit.ts", in: work)
        try write("node_modules/\n", ".gitignore", in: work)
        try git(["add", "-A"], in: work)
        try git(["commit", "-q", "-m", "first"], in: work)
        try git(["remote", "add", "origin", origin.path], in: work)
        try git(["push", "-q", "origin", "main"], in: work)
        try git(["checkout", "-q", "-b", "feature"], in: work)
        try write("x\n", "src/committed.ts", in: work)
        try git(["add", "-A"], in: work)
        try git(["commit", "-q", "-m", "second"], in: work)
        try write("b\n", "src/edit.ts", in: work)
        try write("n\n", "notes/new.md", in: work)
        try write("{}\n", "node_modules/x/package.json", in: work)

        let env = diffTestEnvironment(path: work.path)
        let changes = try await DiffService(cli: cli).changedPaths(env: env)
        #expect(changes == ["src/committed.ts": .added, "src/edit.ts": .modified, "notes/new.md": .added])

        let ignored = try await FileLister(cli: cli).ignoredDirectories(env: env)
        #expect(ignored == ["node_modules"])

        // without origin: the uncommitted changes only
        try git(["remote", "remove", "origin"], in: work)
        let local = try await DiffService(cli: cli).changedPaths(env: env)
        #expect(local == ["src/edit.ts": .modified, "notes/new.md": .added])
    }
}
