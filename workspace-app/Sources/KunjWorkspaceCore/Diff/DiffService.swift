import Foundation

public enum DiffError: Error, Equatable, CustomStringConvertible {
    /// The worktree is gone or the container is not running
    case unavailable(String)
    /// No base branch exists locally (the app never fetches)
    case noBase(String)
    case commandFailed(String)

    public var description: String {
        switch self {
        case .unavailable(let m), .noBase(let m), .commandFailed(let m): return m
        }
    }
}

/// Lists an environment's changed files for a scope and reads both sides of one. Everything is
/// read-only git: `/usr/bin/git -C <worktree>` with `GIT_OPTIONAL_LOCKS=0`, or `kunj ct exec
/// <branch> -- git …` in a container; every call also passes `--no-optional-locks` (a container
/// does not see the host's env) and `core.quotePath=false` (UTF-8 paths as is).
public final class DiffService: @unchecked Sendable {
    public let cli: KunjCLI
    public let runner: CommandRunner
    public let files: FileAccess

    /// At most this many untracked files get line counts (one `find … -exec wc -l` with every
    /// path in argv); the rest are listed with 0.
    public static let maxCountedUntracked = 500

    private let lock = NSLock()
    /// The base scope's merge base per environment id, from the last `summary`, so `contents`
    /// does not resolve it again.
    private var mergeBases: [String: String] = [:]

    public init(cli: KunjCLI, runner: CommandRunner = ProcessRunner()) {
        self.cli = cli
        self.runner = runner
        files = FileAccess(cli: cli)
    }

    /// The scope's files sorted by path, untracked files included as added (except for `last`),
    /// and the popup's title for the scope (`vs origin/main`, `Uncommitted`, `Last commit`).
    public func summary(env: Environment, scope: DiffScope) async throws -> (DiffSummary, baseLabel: String) {
        let target = try target(for: env)
        var baseRef: String?
        var mergeBase: String?
        if scope == .base {
            let resolved = try await resolveBase(target, prBase: env.pullRequest?.baseBranch)
            baseRef = resolved.base
            mergeBase = resolved.mergeBase
            lock.lock(); mergeBases[env.id] = resolved.mergeBase; lock.unlock()
        }
        let args = diffArgs(scope: scope, mergeBase: mergeBase)
        async let numstat = git(target, args.list[0])
        async let nameStatus = git(target, args.list[1])
        async let untracked: [String] = scope == .last ? [] : untrackedFiles(target)

        let statuses = parseNameStatus(try await nameStatus)
        var changed = parseNumstat(try await numstat).map { row in
            ChangedFile(path: row.path, oldPath: row.oldPath,
                        status: statuses[row.path] ?? (row.oldPath != nil ? .renamed : .modified),
                        added: row.added, deleted: row.deleted)
        }
        let newFiles = try await untracked
        if !newFiles.isEmpty {
            let counts = try await lineCounts(target, Array(newFiles.prefix(Self.maxCountedUntracked)))
            changed += newFiles.map {
                ChangedFile(path: $0, oldPath: nil, status: .added, added: counts[$0] ?? 0, deleted: 0)
            }
        }
        changed.sort { $0.path < $1.path }
        return (DiffSummary(files: changed), scope.label(base: baseRef))
    }

    /// Both sides of `file` in `scope`: `git show <ref>:<path>` for a commit side, the working file
    /// (through `FileAccess`) for the working tree, empty for a side that does not exist.
    public func contents(env: Environment, scope: DiffScope, file: ChangedFile) async throws
        -> (original: String, modified: String)
    {
        let target = try target(for: env)
        var mergeBase: String?
        if scope == .base {
            lock.lock(); mergeBase = mergeBases[env.id]; lock.unlock()
            if mergeBase == nil {
                mergeBase = try await resolveBase(target, prBase: env.pullRequest?.baseBranch).mergeBase
            }
        }
        let refs = diffArgs(scope: scope, mergeBase: mergeBase).contentRefs
        async let original = originalSide(target, refs.old, file)
        async let modified = modifiedSide(env, target, refs.new, file)
        return try await (original, modified)
    }

    private func originalSide(_ target: GitContext.Target, _ ref: String?, _ file: ChangedFile) async throws -> String {
        guard file.status != .added, let ref else { return "" }
        return try await show(target, ref, file.oldPath ?? file.path)
    }

    private func modifiedSide(_ env: Environment, _ target: GitContext.Target, _ ref: String?,
                              _ file: ChangedFile) async throws -> String
    {
        if file.status == .deleted { return "" }
        if let ref { return try await show(target, ref, file.path) }
        return try await workingFile(env, file.path)
    }

    // MARK: - steps

    private func target(for env: Environment) throws -> GitContext.Target {
        switch env.kind {
        case .worktree:
            guard env.exists, let path = env.path, FileManager.default.fileExists(atPath: path) else {
                throw DiffError.unavailable("The worktree of \(env.branch) is missing")
            }
            return .worktree(path: path)
        case .container:
            guard env.state == .running else {
                throw DiffError.unavailable("The container of \(env.branch) is not running")
            }
            return .container(branch: env.branch, repoRoot: env.repo.root)
        }
    }

    /// One `for-each-ref` for origin's branches and HEAD, then `merge-base <base> HEAD`.
    private func resolveBase(_ target: GitContext.Target, prBase: String?) async throws
        -> (base: String, mergeBase: String)
    {
        let listing = try await git(target, ["for-each-ref", "--format=%(refname)\t%(symref)", "refs/remotes/origin/"])
        var branches: [String] = []
        var originHead: String?
        for line in listing.split(separator: "\n") {
            let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let name = fields.first.map(remoteShortName) else { continue }
            if name == "origin/HEAD" {
                if fields.count > 1, !fields[1].isEmpty { originHead = remoteShortName(fields[1]) }
            } else {
                branches.append(name)
            }
        }
        let base = chooseBase(prBase: prBase, originHead: originHead, branches: branches)
        guard branches.contains(base) else {
            throw DiffError.noBase("No base branch: \(base) does not exist here (fetch origin)")
        }
        let mergeBase: String
        do {
            mergeBase = try await git(target, ["merge-base", base, "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw DiffError.noBase("\(base) and HEAD have no common commit")
        }
        guard !mergeBase.isEmpty else { throw DiffError.noBase("\(base) and HEAD have no common commit") }
        return (base, mergeBase)
    }

    private func untrackedFiles(_ target: GitContext.Target) async throws -> [String] {
        try await git(target, ["ls-files", "--others", "--exclude-standard", "-z"])
            .split(separator: "\0").map(String.init)
    }

    /// Line counts of regular files (symlinks, directories and devices are skipped by `-type f`)
    /// in one exec: `find ./a ./b -maxdepth 0 -type f -exec wc -l {} +`. find may run wc more than
    /// once, each with its own `total` line; a total has no `./`, so it never matches a path.
    private func lineCounts(_ target: GitContext.Target, _ paths: [String]) async throws -> [String: Int] {
        let find: String
        if case .worktree = target { find = "/usr/bin/find" } else { find = "find" }
        let argv = [find] + paths.map { "./" + $0 } + ["-maxdepth", "0", "-type", "f", "-exec", "wc", "-l", "{}", "+"]
        let spec = execArgv(target, cli: cli, argv)
        // A file that vanished makes find exit 1; the others are still counted
        let output = try await runner.run(spec.argv, cwd: spec.cwd, env: spec.env, stdin: nil).stdout
        var counts: [String: Int] = [:]
        for line in String(decoding: output, as: UTF8.self).split(separator: "\n") {
            let trimmed = line.drop { $0 == " " || $0 == "\t" }
            guard let space = trimmed.firstIndex(of: " "), let count = Int(trimmed[..<space]) else { continue }
            let path = trimmed[trimmed.index(after: space)...]
            guard path.hasPrefix("./") else { continue }
            counts[String(path.dropFirst(2))] = count
        }
        return counts
    }

    private func show(_ target: GitContext.Target, _ ref: String, _ path: String) async throws -> String {
        let spec = gitArgv(target, cli: cli, gitOptions + ["show", "\(ref):\(path)"])
        let result = try await runner.run(spec.argv, cwd: spec.cwd, env: spec.env, stdin: nil)
        // A path missing on that side reads as empty
        return result.exit == 0 ? String(decoding: result.stdout, as: UTF8.self) : ""
    }

    /// The working side. git stores a symlink as its target text, so a worktree's link reads as that
    /// text (never the file it points at, which may be /dev/zero or outside the worktree).
    private func workingFile(_ env: Environment, _ path: String) async throws -> String {
        if env.kind == .worktree, let root = env.path {
            let full = URL(fileURLWithPath: root).appendingPathComponent(path).path
            let type = (try? FileManager.default.attributesOfItem(atPath: full))?[.type] as? FileAttributeType
            if type == .typeSymbolicLink {
                return (try? FileManager.default.destinationOfSymbolicLink(atPath: full)) ?? ""
            }
        }
        do {
            return try await files.read(env: env, path: path)
        } catch FileAccessError.notFound {
            return ""
        }
    }

    private let gitOptions = ["--no-optional-locks", "-c", "core.quotePath=false"]

    private func git(_ target: GitContext.Target, _ args: [String]) async throws -> String {
        let spec = gitArgv(target, cli: cli, gitOptions + args)
        let result = try await runner.run(spec.argv, cwd: spec.cwd, env: spec.env, stdin: nil)
        guard result.exit == 0 else {
            throw DiffError.commandFailed("git \(args.joined(separator: " ")) exited with code \(result.exit)")
        }
        return String(decoding: result.stdout, as: UTF8.self)
    }
}

/// `refs/remotes/origin/main` → `origin/main`
private func remoteShortName(_ ref: String) -> String {
    ref.hasPrefix("refs/remotes/") ? String(ref.dropFirst("refs/remotes/".count)) : ref
}
