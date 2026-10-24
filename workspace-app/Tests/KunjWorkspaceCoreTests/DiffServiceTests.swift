import Foundation
import Testing
@testable import KunjWorkspaceCore

private let gitAvailable = FileManager.default.isExecutableFile(atPath: "/usr/bin/git")

private func sh(_ args: [String], in dir: URL) throws -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = args
    p.currentDirectoryURL = dir
    var env = ProcessInfo.processInfo.environment
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else {
        throw DiffError.commandFailed("git \(args.joined(separator: " ")) exited with \(p.terminationStatus)")
    }
    return String(decoding: data, as: UTF8.self)
}

private func write(_ text: String, _ name: String, in dir: URL) throws {
    let url = dir.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
}

/// A worktree on `feature` whose origin (a bare repo next to it) has `main` at the first commit:
/// the second commit modifies mod.txt (+1 −1), adds added.txt, deletes del.txt and renames
/// old.txt → renamed.txt; the working tree changes keep.txt (+1 −1) and has two untracked files.
private func makeRepository() throws -> URL {
    let root = try tempDirectory()
    let work = root.appendingPathComponent("work")
    let origin = root.appendingPathComponent("origin.git")
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    _ = try sh(["init", "--bare", "-q", "-b", "main", origin.path], in: root)
    _ = try sh(["init", "-q", "-b", "main"], in: work)
    _ = try sh(["config", "user.email", "t@example.com"], in: work)
    _ = try sh(["config", "user.name", "Test"], in: work)
    try write("a\nb\nc\n", "keep.txt", in: work)
    try write("one\ntwo\n", "mod.txt", in: work)
    try write("x\n", "del.txt", in: work)
    try write("l1\nl2\nl3\nl4\nl5\nl6\n", "old.txt", in: work)
    _ = try sh(["add", "-A"], in: work)
    _ = try sh(["commit", "-q", "-m", "first"], in: work)
    _ = try sh(["remote", "add", "origin", origin.path], in: work)
    _ = try sh(["push", "-q", "origin", "main"], in: work)
    _ = try sh(["checkout", "-q", "-b", "feature"], in: work)
    try write("one\nTWO\n", "mod.txt", in: work)
    try write("1\n2\n", "added.txt", in: work)
    try FileManager.default.removeItem(at: work.appendingPathComponent("del.txt"))
    _ = try sh(["mv", "old.txt", "renamed.txt"], in: work)
    _ = try sh(["add", "-A"], in: work)
    _ = try sh(["commit", "-q", "-m", "second"], in: work)
    try write("a\nB\nc\n", "keep.txt", in: work)
    try write("u1\nu2\nu3\n", "untracked.txt", in: work)
    try write("s\n", "dir/with space.txt", in: work)
    return work
}

func diffTestEnvironment(kind: EnvironmentKind = .worktree, branch: String = "feature", path: String?,
                         state: EnvState? = nil, exists: Bool = true, prBase: String? = nil) -> Environment
{
    let repo = RepoRef(name: "demo", root: path ?? "/r", bare: false)
    let pr = prBase.map {
        PullRequestInfo(provider: "github", number: 1, title: "t", state: "OPEN", url: "u", draft: false,
                        baseBranch: $0, headBranch: branch, reviewDecision: nil, checks: nil, updatedAt: nil)
    }
    return Environment(
        id: environmentId(repo: repo.name, kind: kind, branch: branch), kind: kind, repo: repo, branch: branch,
        path: kind == .worktree ? path : nil, containerName: kind == .container ? "kunj-demo-x" : nil,
        state: state ?? (kind == .worktree ? (exists ? .ok : .missing) : .running), agent: .none,
        agentSession: nil, dirty: true, changedFiles: nil, ahead: nil, behind: nil, upstream: nil,
        pullRequest: pr, ports: [], services: [], createdAt: nil, exists: exists, isMain: false)
}

/// Records every command and answers from `answer` (stdout, exit 0), or an empty stdout.
private final class RecordingRunner: CommandRunner, @unchecked Sendable {
    let lock = NSLock()
    var calls: [[String]] = []
    let answer: @Sendable ([String]) -> String

    init(answer: @escaping @Sendable ([String]) -> String) { self.answer = answer }

    func run(_ argv: [String], cwd: String, env: [String: String], stdin: Data?) async throws
        -> (stdout: Data, exit: Int32)
    {
        lock.lock(); calls.append(argv); lock.unlock()
        return (Data(answer(argv).utf8), 0)
    }
}

@Suite(.enabled(if: gitAvailable)) struct DiffServiceTests {
    let cli = KunjCLI(command: "kunj", path: "/usr/bin:/bin")

    @Test func summaryAndContentsInWorktree() async throws {
        let work = try makeRepository()
        let env = diffTestEnvironment(path: work.path, prBase: "develop")
        let service = DiffService(cli: cli)

        let (base, label) = try await service.summary(env: env, scope: .base)
        // develop was never fetched, so the base falls back to origin/main
        #expect(label == "vs origin/main")
        #expect(base.files.map(\.path) == ["added.txt", "del.txt", "dir/with space.txt", "keep.txt", "mod.txt",
                                           "renamed.txt", "untracked.txt"])
        let byPath = Dictionary(uniqueKeysWithValues: base.files.map { ($0.path, $0) })
        #expect(byPath["mod.txt"] == ChangedFile(path: "mod.txt", oldPath: nil, status: .modified, added: 1, deleted: 1))
        #expect(byPath["added.txt"] == ChangedFile(path: "added.txt", oldPath: nil, status: .added, added: 2, deleted: 0))
        #expect(byPath["del.txt"] == ChangedFile(path: "del.txt", oldPath: nil, status: .deleted, added: 0, deleted: 1))
        #expect(byPath["renamed.txt"] == ChangedFile(path: "renamed.txt", oldPath: "old.txt", status: .renamed,
                                                     added: 0, deleted: 0))
        #expect(byPath["untracked.txt"] == ChangedFile(path: "untracked.txt", oldPath: nil, status: .added,
                                                       added: 3, deleted: 0))
        #expect(byPath["dir/with space.txt"]?.added == 1)
        #expect(base.added == 1 + 2 + 1 + 1 + 3 && base.deleted == 1 + 1 + 1)

        let mod = try await service.contents(env: env, scope: .base, file: byPath["mod.txt"]!)
        #expect(mod.original == "one\ntwo\n" && mod.modified == "one\nTWO\n")
        let keep = try await service.contents(env: env, scope: .base, file: byPath["keep.txt"]!)
        #expect(keep.original == "a\nb\nc\n" && keep.modified == "a\nB\nc\n")
        let untracked = try await service.contents(env: env, scope: .base, file: byPath["untracked.txt"]!)
        #expect(untracked.original == "" && untracked.modified == "u1\nu2\nu3\n")
        let del = try await service.contents(env: env, scope: .base, file: byPath["del.txt"]!)
        #expect(del.original == "x\n" && del.modified == "")
        let renamed = try await service.contents(env: env, scope: .base, file: byPath["renamed.txt"]!)
        #expect(renamed.original == "l1\nl2\nl3\nl4\nl5\nl6\n" && renamed.modified == renamed.original)

        let (last, lastLabel) = try await service.summary(env: env, scope: .last)
        #expect(lastLabel == "Last commit")
        #expect(last.files.map(\.path) == ["added.txt", "del.txt", "mod.txt", "renamed.txt"])
        let lastKeep = try await service.contents(env: env, scope: .last, file: last.files[2])
        #expect(lastKeep.original == "one\ntwo\n" && lastKeep.modified == "one\nTWO\n")

        let (uncommitted, _) = try await service.summary(env: env, scope: .uncommitted)
        #expect(uncommitted.files.map(\.path) == ["dir/with space.txt", "keep.txt", "untracked.txt"])
    }

    /// git keeps a symlink as its target text, so the working side must be that text too, never the
    /// file it points at (a link to /dev/zero or a fifo would block the column)
    @Test func symlinkWorkingSideIsItsTarget() async throws {
        let work = try makeRepository()
        try FileManager.default.createSymbolicLink(atPath: work.appendingPathComponent("link").path,
                                                   withDestinationPath: "keep.txt")
        try FileManager.default.createSymbolicLink(atPath: work.appendingPathComponent("zero").path,
                                                   withDestinationPath: "/dev/zero")
        let env = diffTestEnvironment(path: work.path)
        let service = DiffService(cli: cli)
        let (summary, _) = try await service.summary(env: env, scope: .uncommitted)
        let byPath = Dictionary(uniqueKeysWithValues: summary.files.map { ($0.path, $0) })
        let link = try await service.contents(env: env, scope: .uncommitted, file: #require(byPath["link"]))
        #expect(link.original == "" && link.modified == "keep.txt")
        let zero = try await service.contents(env: env, scope: .uncommitted, file: #require(byPath["zero"]))
        #expect(zero.modified == "/dev/zero")
    }

    @Test func prBaseAndOriginHeadWin() async throws {
        let work = try makeRepository()
        _ = try sh(["push", "-q", "origin", "main:develop"], in: work)
        let service = DiffService(cli: cli)
        let (_, label) = try await service.summary(env: diffTestEnvironment(path: work.path, prBase: "develop"),
                                                   scope: .base)
        #expect(label == "vs origin/develop")
        _ = try sh(["remote", "set-head", "origin", "develop"], in: work)
        let (_, headLabel) = try await service.summary(env: diffTestEnvironment(path: work.path), scope: .base)
        #expect(headLabel == "vs origin/develop")
    }

    @Test func noBaseIsAnError() async throws {
        let work = try makeRepository()
        _ = try sh(["remote", "remove", "origin"], in: work)
        await #expect(throws: DiffError.self) {
            _ = try await DiffService(cli: cli).summary(env: diffTestEnvironment(path: work.path), scope: .base)
        }
    }

    @Test func missingWorktreeAndStoppedContainerAreRefused() async throws {
        let service = DiffService(cli: cli)
        await #expect(throws: DiffError.self) {
            _ = try await service.summary(env: diffTestEnvironment(path: "/nonexistent", exists: false), scope: .base)
        }
        await #expect(throws: DiffError.self) {
            _ = try await service.summary(env: diffTestEnvironment(kind: .container, path: nil, state: .stopped),
                                          scope: .uncommitted)
        }
    }

    @Test func containerRunsThroughKunjCtExecWithOneLineCount() async throws {
        let runner = RecordingRunner { argv in
            guard let dash = argv.firstIndex(of: "--") else { return "" }
            let cmd = Array(argv[(dash + 1)...])
            if cmd.contains("--numstat") { return "1\t1\tsrc/a.ts\n" }
            if cmd.contains("--name-status") { return "M\tsrc/a.ts\n" }
            if cmd.contains("ls-files") { return "new.txt\u{0}dir/b c.txt\u{0}" }
            if cmd.first == "find" { return "       3 ./new.txt\n       2 ./dir/b c.txt\n       5 total\n" }
            return ""
        }
        let env = diffTestEnvironment(kind: .container, branch: "feature/x", path: nil)
        let service = DiffService(cli: cli, runner: runner)
        let (summary, _) = try await service.summary(env: env, scope: .uncommitted)
        #expect(summary.files.map(\.path) == ["dir/b c.txt", "new.txt", "src/a.ts"])
        #expect(summary.files.map(\.added) == [2, 3, 1])
        for call in runner.calls {
            #expect(Array(call.prefix(7)) == ["/usr/bin/env", "kunj", "ct", "exec", "feature/x", "--", call[6]])
        }
        // one exec counts every untracked file's lines, never one per file
        #expect(runner.calls.filter { $0.contains("wc") }.count == 1)
        #expect(runner.calls.allSatisfy { !$0.contains("/usr/bin/git") })
    }
}
