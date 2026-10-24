import Foundation

/// What the Changes column compares the working tree with.
public enum DiffScope: String, CaseIterable, Sendable {
    /// The merge base with the base branch (`origin/<base>`), working tree included
    case base
    /// `HEAD` against the working tree
    case uncommitted
    /// `HEAD~1` against `HEAD`
    case last

    /// The popup's title. The base scope's real title names the branch (`label(base:)`), which only
    /// the service knows, so this one is generic.
    public var label: String {
        switch self {
        case .base: return "vs base"
        case .uncommitted: return "Uncommitted"
        case .last: return "Last commit"
        }
    }

    /// `vs origin/main` for the base scope once the service has chosen the base; `label` otherwise.
    public func label(base: String?) -> String {
        if self == .base, let base { return "vs \(base)" }
        return label
    }
}

public enum FileStatus: String, Sendable {
    case added = "A", modified = "M", deleted = "D", renamed = "R"
}

/// One row of the Changes column. Counts are 0 for a binary file.
public struct ChangedFile: Equatable, Sendable {
    public var path: String
    /// The path before a rename
    public var oldPath: String?
    public var status: FileStatus
    public var added: Int
    public var deleted: Int

    public init(path: String, oldPath: String?, status: FileStatus, added: Int, deleted: Int) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.added = added
        self.deleted = deleted
    }
}

public struct DiffSummary: Equatable, Sendable {
    public var files: [ChangedFile]
    public var added: Int
    public var deleted: Int

    public init(files: [ChangedFile]) {
        self.files = files
        added = files.reduce(0) { $0 + $1.added }
        deleted = files.reduce(0) { $0 + $1.deleted }
    }
}

/// Parses `git diff --numstat -M`: `added<TAB>deleted<TAB>path`, `-` for a binary file's counts
/// (read as 0), renames as `old => new` or `pre/{old => new}/post`, paths C-quoted when git quotes them.
public func parseNumstat(_ s: String) -> [(path: String, oldPath: String?, added: Int, deleted: Int)] {
    var rows: [(path: String, oldPath: String?, added: Int, deleted: Int)] = []
    for line in s.split(separator: "\n", omittingEmptySubsequences: true) {
        let fields = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
        guard fields.count == 3 else { continue }
        let added = Int(fields[0]) ?? 0
        let deleted = Int(fields[1]) ?? 0
        let (path, oldPath) = parseRename(String(fields[2]))
        rows.append((path, oldPath, added, deleted))
    }
    return rows
}

/// Parses `git diff --name-status -M` into a status per (new) path: `R100<TAB>old<TAB>new` is keyed
/// by `new`; a copy counts as added, a type change or an unmerged path as modified.
public func parseNameStatus(_ s: String) -> [String: FileStatus] {
    var map: [String: FileStatus] = [:]
    for line in s.split(separator: "\n", omittingEmptySubsequences: true) {
        let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard fields.count >= 2, let letter = fields[0].first else { continue }
        let path = unquoteGitPath(fields[fields.count - 1])
        switch letter {
        case "A", "C": map[path] = .added
        case "D": map[path] = .deleted
        case "R": map[path] = .renamed
        default: map[path] = .modified
        }
    }
    return map
}

/// The git arguments that list a scope's files (numstat, then name-status) and the refs its two
/// sides are read from: `old` for `git show <old>:<path>`, `new` nil for the working tree.
/// `mergeBase` is only used by the base scope (HEAD when nil).
public func diffArgs(scope: DiffScope, mergeBase: String?)
    -> (list: [[String]], contentRefs: (old: String?, new: String?))
{
    let refs: [String]
    let old: String
    let new: String?
    switch scope {
    case .base:
        old = mergeBase ?? "HEAD"; new = nil; refs = [old]
    case .uncommitted:
        old = "HEAD"; new = nil; refs = [old]
    case .last:
        old = "HEAD~1"; new = "HEAD"; refs = ["HEAD~1", "HEAD"]
    }
    return ([["diff", "--numstat", "-M"] + refs, ["diff", "--name-status", "-M"] + refs], (old, new))
}

/// The base branch to diff against: the PR's base when it was fetched, else origin's HEAD, else
/// `origin/main` when it exists, else `origin/master`. `branches` are the remote-tracking refs
/// that exist locally (`origin/x`); the app never fetches, so a PR base may be missing.
public func chooseBase(prBase: String?, originHead: String?, branches: [String]) -> String {
    if let prBase, !prBase.isEmpty, branches.contains("origin/\(prBase)") { return "origin/\(prBase)" }
    if let originHead, !originHead.isEmpty { return originHead }
    if branches.contains("origin/main") { return "origin/main" }
    return "origin/master"
}

// MARK: - path forms

/// `a => b`, `pre/{a => b}/post` (either side may be empty) → (new, old); a plain path → (path, nil).
func parseRename(_ field: String) -> (path: String, oldPath: String?) {
    if let open = field.firstIndex(of: "{"), let close = field[open...].firstIndex(of: "}"),
       let arrow = field[open..<close].range(of: " => ")
    {
        let prefix = field[..<open]
        let suffix = field[field.index(after: close)...]
        let oldMid = field[field.index(after: open)..<arrow.lowerBound]
        let newMid = field[arrow.upperBound..<close]
        let old = normalizeJoined(String(prefix) + oldMid + suffix)
        let new = normalizeJoined(String(prefix) + newMid + suffix)
        return (unquoteGitPath(new), unquoteGitPath(old))
    }
    if let arrow = field.range(of: " => ") {
        return (unquoteGitPath(String(field[arrow.upperBound...])), unquoteGitPath(String(field[..<arrow.lowerBound])))
    }
    return (unquoteGitPath(field), nil)
}

/// An empty side of `{ => b}` leaves `//` or a leading `/`.
private func normalizeJoined(_ s: String) -> String {
    var path = s
    while path.contains("//") { path = path.replacingOccurrences(of: "//", with: "/") }
    if path.hasPrefix("/") { path.removeFirst() }
    return path
}

/// Undoes git's C-style quoting (`"a\tb"`, octal `\303\251` for UTF-8 bytes); other text is returned as is.
func unquoteGitPath(_ s: String) -> String {
    guard s.count >= 2, s.hasPrefix("\""), s.hasSuffix("\"") else { return s }
    let body = Array(s.utf8.dropFirst().dropLast())
    var bytes: [UInt8] = []
    var i = 0
    while i < body.count {
        let c = body[i]
        guard c == UInt8(ascii: "\\"), i + 1 < body.count else { bytes.append(c); i += 1; continue }
        let e = body[i + 1]
        switch e {
        case UInt8(ascii: "n"): bytes.append(0x0A)
        case UInt8(ascii: "t"): bytes.append(0x09)
        case UInt8(ascii: "r"): bytes.append(0x0D)
        case UInt8(ascii: "a"): bytes.append(0x07)
        case UInt8(ascii: "b"): bytes.append(0x08)
        case UInt8(ascii: "f"): bytes.append(0x0C)
        case UInt8(ascii: "v"): bytes.append(0x0B)
        case UInt8(ascii: "0")...UInt8(ascii: "7"):
            var value = 0
            var j = i + 1
            while j < body.count, j < i + 4, (UInt8(ascii: "0")...UInt8(ascii: "7")).contains(body[j]) {
                value = value * 8 + Int(body[j] - UInt8(ascii: "0"))
                j += 1
            }
            bytes.append(UInt8(truncatingIfNeeded: value))
            i = j
            continue
        default: bytes.append(e)
        }
        i += 2
    }
    return String(decoding: bytes, as: UTF8.self)
}
