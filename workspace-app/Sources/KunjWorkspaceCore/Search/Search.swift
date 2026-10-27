import Foundation

// The Search panel's model: `kunj search --json` (SearchJson in src/lib/json-types.ts, since kunj
// 1.4), the arguments for a query, and the result tree the panel shows.

// ---- kunj search --json

public struct SearchJson: Decodable, Equatable, Sendable {
    public var searched: SearchCounts
    public var sources: [SearchSource]
    public var containers: SearchContainers?
}

public struct SearchCounts: Decodable, Equatable, Sendable {
    public var worktrees: Int
    public var branches: Int
    public var containers: Int
}

/// A worktree, branch or container that matched (or failed).
public struct SearchSource: Decodable, Equatable, Sendable {
    /// `worktree`, `branch` or `container`
    public var kind: String
    public var branch: String?
    public var path: String?
    public var container: String?
    public var isCurrent: Bool?
    public var matches: [SearchMatch]
    public var truncated: Bool
    public var error: String?
}

public struct SearchMatch: Decodable, Equatable, Sendable {
    /// Relative to the worktree or to /workspace
    public var path: String
    public var line: Int
    /// 1-based, in characters
    public var column: Int
    /// 0 when kunj could not tell
    public var length: Int
    public var text: String
}

public struct SearchContainers: Decodable, Equatable, Sendable {
    public var available: Bool
    public var message: String?
    public var stopped: [String]
}

// ---- the query

/// Where the panel searches. `environment` (the default) is the selected worktree or container.
public enum SearchScope: String, CaseIterable, Sendable {
    case environment, worktrees, everywhere

    public func title(for kind: EnvironmentKind?) -> String {
        switch self {
        case .environment: return kind == .container ? "This container" : "This worktree"
        case .worktrees: return "All worktrees"
        case .everywhere: return "Worktrees & containers"
        }
    }
}

public struct SearchQuery: Equatable, Sendable {
    public var text: String
    public var ignoreCase: Bool
    public var word: Bool
    /// The text is an extended regex; otherwise a fixed string
    public var regex: Bool
    public var scope: SearchScope

    public init(text: String, ignoreCase: Bool = true, word: Bool = false, regex: Bool = false,
                scope: SearchScope = .environment) {
        self.text = text
        self.ignoreCase = ignoreCase
        self.word = word
        self.regex = regex
        self.scope = scope
    }
}

/// `kunj search` arguments for a query from `env` (without `--json`, which `KunjCLI.run` adds). The
/// text and the branch go in `--opt=value` form, so one that starts with `-` is never read as an option.
public func searchArguments(_ q: SearchQuery, env: Environment) -> [String] {
    var args = ["search", "--regexp=\(q.text)"]
    if !q.regex { args.append("-F") }
    if q.ignoreCase { args.append("-i") }
    if q.word { args.append("-w") }
    switch q.scope {
    case .environment:
        args += ["--in", env.kind == .container ? "containers" : "worktrees", "--branch=\(env.branch)"]
    case .worktrees:
        args += ["--in", "worktrees"]
    case .everywhere:
        args += ["--in", "worktrees,containers"]
    }
    return args
}

// ---- the result tree

/// Where a match is: the environment (by kind and branch, in the searched repository) and the spot.
public struct SearchTarget: Equatable, Hashable, Sendable {
    public var kind: EnvironmentKind
    public var branch: String
    public var path: String
    public var line: Int
    public var column: Int
    public var length: Int
}

/// One row of the result tree: a source (when several environments are searched), a file, or a match.
public struct SearchNode: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// `detail`: `worktree`, `container`, or the error
        case source(branch: String, kind: EnvironmentKind, detail: String, failed: Bool)
        case file(path: String, count: Int, truncated: Bool)
        case match(SearchMatch)
    }
    public var kind: Kind
    /// Stable across reloads (outline items keep their open state by it)
    public var key: String
    public var target: SearchTarget?
    public var children: [SearchNode]
}

/// The tree for a result: files with their matches; with `grouped`, under one node per source.
/// Branch sources (committed trees, which the app cannot open) are left out.
public func searchTree(_ result: SearchJson, grouped: Bool) -> [SearchNode] {
    var nodes: [SearchNode] = []
    for source in result.sources {
        let kind: EnvironmentKind
        switch source.kind {
        case "worktree": kind = .worktree
        case "container": kind = .container
        default: continue
        }
        let branch = source.branch ?? "(detached)"
        let prefix = "\(kind.rawValue)|\(branch)"
        var files: [SearchNode] = []
        var order: [String] = []
        var byPath: [String: [SearchMatch]] = [:]
        for m in source.matches {
            if byPath[m.path] == nil { order.append(m.path) }
            byPath[m.path, default: []].append(m)
        }
        for (i, path) in order.enumerated() {
            let matches = byPath[path]!
            // only the last file can have lost matches to the cap
            let truncated = source.truncated && i == order.count - 1
            let children = matches.map { m in
                SearchNode(kind: .match(m), key: "\(prefix)|\(path)|\(m.line):\(m.column)",
                           target: SearchTarget(kind: kind, branch: branch, path: path, line: m.line,
                                                column: m.column, length: m.length),
                           children: [])
            }
            files.append(SearchNode(kind: .file(path: path, count: matches.count, truncated: truncated),
                                    key: "\(prefix)|\(path)", target: children.first?.target, children: children))
        }
        if grouped {
            // not `isCurrent`: kunj runs in the repository root, so that is always the main worktree
            let detail = source.error ?? kind.rawValue
            nodes.append(SearchNode(kind: .source(branch: branch, kind: kind, detail: detail, failed: source.error != nil),
                                    key: prefix, target: nil, children: files))
        } else if let error = source.error {
            nodes.append(SearchNode(kind: .source(branch: branch, kind: kind, detail: error, failed: true),
                                    key: prefix, target: nil, children: files))
        } else {
            nodes += files
        }
    }
    return nodes
}

/// The panel's summary line: `12 matches in 3 files`, plus what was not searched.
public func searchSummary(_ result: SearchJson) -> String {
    let sources = result.sources.filter { $0.kind != "branch" }
    let matches = sources.reduce(0) { $0 + $1.matches.count }
    let files = sources.reduce(0) { $0 + Set($1.matches.map(\.path)).count }
    var parts: [String] = []
    if matches == 0 {
        parts.append("No matches")
    } else {
        let more = sources.contains(where: \.truncated) ? "+" : ""
        parts.append("\(matches)\(more) \(matches == 1 ? "match" : "matches") in \(files) \(files == 1 ? "file" : "files")")
    }
    if let c = result.containers {
        if !c.available {
            parts.append("containers not searched: \(c.message ?? "Docker could not be asked")")
        } else if !c.stopped.isEmpty {
            parts.append("not running: \(c.stopped.joined(separator: ", "))")
        }
    }
    return parts.joined(separator: " · ")
}

/// The message for a failed search: an older kunj without the command gets the install hint.
public func searchFailureMessage(_ error: Error) -> String {
    let message = (error as? KunjCLIError)?.message ?? "\(error)"
    if message.contains("unknown command") && message.contains("search") {
        return "Search needs a newer kunj: npm install -g kunj"
    }
    return message
}
