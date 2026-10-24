import Foundation
import Testing
@testable import KunjWorkspaceCore

private final class AnsweringRunner: CommandRunner, @unchecked Sendable {
    let lock = NSLock()
    var calls: [[String]] = []
    let stdout: String
    init(_ stdout: String) { self.stdout = stdout }
    func run(_ argv: [String], cwd: String, env: [String: String], stdin: Data?) async throws -> (stdout: Data, exit: Int32) {
        lock.lock(); calls.append(argv); lock.unlock()
        return (Data(stdout.utf8), 0)
    }
}

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

@Suite struct FileTreeTests {
    @Test func treeHasFoldersFirstThenNamesIgnoringCase() {
        let tree = buildFileTree(["src/b.ts", "README.md", "src/a/x.ts", "a.txt", "src/Z.ts"])
        #expect(tree.map(\.name) == ["src", "a.txt", "README.md"])
        let src = tree[0]
        #expect(src.isDirectory && src.path == "src")
        #expect(src.children.map(\.name) == ["a", "b.ts", "Z.ts"])
        #expect(src.children[0].children.map(\.path) == ["src/a/x.ts"])
        #expect(!tree[1].isDirectory && tree[1].children.isEmpty)
    }

    /// Tracked and untracked files, never ignored ones (node_modules, build output)
    @Test func worktreeListsTrackedAndUntrackedNotIgnored() async throws {
        let dir = try tempDirectory()
        try git(["init", "-q", "-b", "main"], in: dir)
        for (name, text) in [("tracked.txt", "a"), (".gitignore", "ignored.txt\nnode_modules/\n"),
                             ("ignored.txt", "x"), ("node_modules/m/i.js", "x"), ("new dir/untracked é.txt", "u")] {
            let url = dir.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }
        try git(["add", "tracked.txt", ".gitignore"], in: dir)
        let listing = try await FileLister(cli: KunjCLI(command: "kunj", path: "/usr/bin:/bin"))
            .list(env: diffTestEnvironment(path: dir.path))
        #expect(listing.paths == [".gitignore", "new dir/untracked é.txt", "tracked.txt"])
        #expect(!listing.truncated)
    }

    @Test func containerListsThroughKunjCtExec() async throws {
        let runner = AnsweringRunner("b.txt\u{0}a.txt\u{0}b.txt\u{0}")
        let lister = FileLister(cli: KunjCLI(command: "kunj", path: "/usr/bin:/bin"), runner: runner)
        let listing = try await lister.list(env: diffTestEnvironment(kind: .container, branch: "feature/x", path: nil))
        #expect(listing.paths == ["a.txt", "b.txt"])
        let call = try #require(runner.calls.first)
        #expect(Array(call.prefix(6)) == ["/usr/bin/env", "kunj", "ct", "exec", "feature/x", "--"])
        #expect(call.contains("ls-files") && call.contains("--exclude-standard"))
    }

    @Test func longListingsAreCut() async throws {
        let runner = AnsweringRunner((0..<12).map { "f\($0)\u{0}" }.joined())
        let lister = FileLister(cli: KunjCLI(command: "kunj", path: "/usr/bin:/bin"), runner: runner, limit: 10)
        let listing = try await lister.list(env: diffTestEnvironment(kind: .container, path: nil))
        #expect(listing.paths.count == 10)
        #expect(listing.truncated)
    }

    @Test func missingWorktreeAndStoppedContainerAreRefused() async {
        let lister = FileLister(cli: KunjCLI(command: "kunj", path: "/usr/bin:/bin"))
        await #expect(throws: DiffError.self) {
            _ = try await lister.list(env: diffTestEnvironment(path: "/nonexistent", exists: false))
        }
        await #expect(throws: DiffError.self) {
            _ = try await lister.list(env: diffTestEnvironment(kind: .container, path: nil, state: .stopped))
        }
    }
}
