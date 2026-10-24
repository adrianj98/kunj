import Foundation

/// One entry of the Files column: a folder (with its children) or a file, `path` relative to the
/// environment's root.
public struct FileNode: Equatable, Sendable {
    public var name: String
    public var path: String
    public var isDirectory: Bool
    public var children: [FileNode]

    public init(name: String, path: String, isDirectory: Bool, children: [FileNode] = []) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.children = children
    }
}

/// The tree of relative file paths: folders first, then by name ignoring case, at every level.
public func buildFileTree(_ paths: [String]) -> [FileNode] {
    final class Dir {
        var dirs: [String: Dir] = [:]
        var files: [String] = []
    }
    let root = Dir()
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
            FileNode(name: name, path: prefix + name, isDirectory: true, children: nodes(dir.dirs[name]!, prefix: prefix + name + "/"))
        }
        let files = dir.files.sorted(by: byName).map { FileNode(name: $0, path: prefix + $0, isDirectory: false) }
        return folders + files
    }
    return nodes(root, prefix: "")
}

/// The files of an environment as git sees them: tracked plus untracked that are not ignored, so
/// `node_modules` and build output stay out. One `git ls-files` in the worktree, or through
/// `kunj ct exec` in a running container (read-only, `GIT_OPTIONAL_LOCKS=0`).
public struct FileLister: Sendable {
    public struct Listing: Equatable, Sendable {
        public var paths: [String]
        /// More than `limit` files: only the first `limit` (sorted) are listed
        public var truncated: Bool

        public init(paths: [String], truncated: Bool) {
            self.paths = paths
            self.truncated = truncated
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
        let result = try await runner.run(spec.argv, cwd: spec.cwd, env: spec.env, stdin: nil)
        guard result.exit == 0 else { throw DiffError.commandFailed("git ls-files exited with code \(result.exit)") }
        let all = Set(result.stdout.split(separator: 0).map { String(decoding: $0, as: UTF8.self) }).sorted()
        return Listing(paths: Array(all.prefix(limit)), truncated: all.count > limit)
    }
}
