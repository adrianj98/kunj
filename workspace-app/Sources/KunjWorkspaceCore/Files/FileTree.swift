import Foundation

/// One entry of the Files column: a folder (with its children) or a file, `path` relative to the
/// environment's root. `ignored`: git ignores it (an ignored folder is listed without children).
public struct FileNode: Equatable, Sendable {
    public var name: String
    public var path: String
    public var isDirectory: Bool
    public var children: [FileNode]
    public var ignored: Bool

    public init(name: String, path: String, isDirectory: Bool, children: [FileNode] = [], ignored: Bool = false) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.children = children
        self.ignored = ignored
    }
}

/// The tree of relative file paths: folders first, then by name ignoring case, at every level.
/// `directories` are folders listed without their contents (ignored ones); paths in `ignored` are
/// marked.
public func buildFileTree(_ paths: [String], directories: [String] = [], ignored: Set<String> = []) -> [FileNode] {
    final class Dir {
        var dirs: [String: Dir] = [:]
        var files: [String] = []
    }
    let root = Dir()
    for path in directories {
        var dir = root
        for part in path.split(separator: "/").map(String.init) {
            if let next = dir.dirs[part] { dir = next } else { let next = Dir(); dir.dirs[part] = next; dir = next }
        }
    }
    for path in paths {
        let parts = path.split(separator: "/").map(String.init)
        guard let file = parts.last else { continue }
        var dir = root
        for part in parts.dropLast() {
            if let next = dir.dirs[part] { dir = next } else { let next = Dir(); dir.dirs[part] = next; dir = next }
        }
        dir.files.append(file)
    }
    func byName(_ a: String, _ b: String) -> Bool {
        let c = a.caseInsensitiveCompare(b)
        return c == .orderedSame ? a < b : c == .orderedAscending
    }
    func nodes(_ dir: Dir, prefix: String) -> [FileNode] {
        let folders = dir.dirs.keys.sorted(by: byName).map { name in
            FileNode(name: name, path: prefix + name, isDirectory: true,
                     children: nodes(dir.dirs[name]!, prefix: prefix + name + "/"), ignored: ignored.contains(prefix + name))
        }
        let files = dir.files.sorted(by: byName).map {
            FileNode(name: $0, path: prefix + $0, isDirectory: false, ignored: ignored.contains(prefix + $0))
        }
        return folders + files
    }
    return nodes(root, prefix: "")
}

/// The files of an environment: tracked, untracked and ignored ones (`.env`). Ignored folders
/// (`node_modules`, build output) are listed as one entry without their contents, the way
/// `git status --ignored=matching` reports them. One `git ls-files` and one `git status` in the
/// worktree, or through `kunj ct exec` in a running container (read-only, `GIT_OPTIONAL_LOCKS=0`).
public struct FileLister: Sendable {
    public struct Listing: Equatable, Sendable {
        /// Files, ignored ones included
        public var paths: [String]
        /// More than `limit` files: only the first `limit` (sorted) are listed
        public var truncated: Bool
        /// Ignored folders, without a trailing slash
        public var ignoredDirectories: [String]
        /// Ignored files and folders
        public var ignored: Set<String>

        public init(paths: [String], truncated: Bool, ignoredDirectories: [String] = [], ignored: Set<String> = []) {
            self.paths = paths
            self.truncated = truncated
            self.ignoredDirectories = ignoredDirectories
            self.ignored = ignored
        }
    }

    public let cli: KunjCLI
    let runner: CommandRunner
    let limit: Int

    public init(cli: KunjCLI, runner: CommandRunner = ProcessRunner(), limit: Int = 50_000) {
        self.cli = cli
        self.runner = runner
        self.limit = limit
    }

    public func list(env: Environment) async throws -> Listing {
        let target = try gitTarget(for: env)
        let spec = gitArgv(target, cli: cli, ["--no-optional-locks", "-c", "core.quotePath=false",
                                              "ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        let ignoredSpec = gitArgv(target, cli: cli, ["--no-optional-locks", "-c", "core.quotePath=false",
                                                     "status", "--porcelain=v1", "-z", "--ignored=matching"])
        async let ignoredResult = runner.run(ignoredSpec.argv, cwd: ignoredSpec.cwd, env: ignoredSpec.env, stdin: nil)
        let result = try await runner.run(spec.argv, cwd: spec.cwd, env: spec.env, stdin: nil)
        guard result.exit == 0 else { throw DiffError.commandFailed("git ls-files exited with code \(result.exit)") }
        // The ignored entries are extra: without them the listing is still the tracked and untracked files
        let ignored = (try? await ignoredResult).flatMap { $0.exit == 0 ? parseIgnored($0.stdout) : nil } ?? []
        var files = Set(result.stdout.split(separator: 0).map { String(decoding: $0, as: UTF8.self) })
        var directories: [String] = []
        for path in ignored {
            if path.hasSuffix("/") { directories.append(String(path.dropLast())) } else { files.insert(path) }
        }
        let all = files.sorted()
        let names = Set(ignored.map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 })
        return Listing(paths: Array(all.prefix(limit)), truncated: all.count > limit,
                       ignoredDirectories: directories.sorted(), ignored: names)
    }
}

/// The `!!` entries of `git status --porcelain=v1 -z --ignored`, folders with a trailing slash. A
/// rename or copy entry is followed by its source path, which is skipped.
func parseIgnored(_ data: Data) -> [String] {
    var out: [String] = []
    var skipNext = false
    for raw in data.split(separator: 0) {
        if skipNext { skipNext = false; continue }
        let entry = String(decoding: raw, as: UTF8.self)
        guard entry.count > 3 else { continue }
        let code = entry.prefix(2)
        if code.first == "R" || code.first == "C" { skipNext = true }
        if code == "!!" { out.append(String(entry.dropFirst(3))) }
    }
    return out
}
