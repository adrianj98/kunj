import Foundation

/// A link's `:line`, `:line:col`, `:line-line` (a range: its first line) or `#Lline[-Lline]` suffix.
private let suffixPattern = #":(\d+)(?::(\d+)|-\d+)?$|#L(\d+)(?:-L?\d+)?$"#

/// The path a terminal link names, without its line suffix: a `file://` URL's path, `~/` expanded.
/// nil for a URL of another scheme (mailto:, https://, …) and for nothing at all.
private func linkPath(_ link: String) -> String? {
    var text = link.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("file://") {
        guard let path = URL(string: text)?.path, !path.isEmpty else { return nil }
        text = path
    }
    if let range = text.range(of: suffixPattern, options: .regularExpression) {
        text.removeSubrange(range)
    }
    // after the suffix, or `README.md:12` would read as a scheme
    if text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil { return nil }
    if text.hasPrefix("~/") { text = NSHomeDirectory() + text.dropFirst() }
    return text.isEmpty || text.contains("\0") ? nil : text
}

/// Where in the file a link points: `token.ts:33` is line 33, `a.ts:12:5` line 12 column 5,
/// `bob.ts:44-60` and `a.ts#L44-L60` line 44. nil without a suffix. Both count from 1.
public func terminalLinkSpot(_ link: String) -> (line: Int, column: Int)? {
    let text = link.trimmingCharacters(in: .whitespaces)
    guard let regex = try? NSRegularExpression(pattern: suffixPattern),
          let m = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    func number(_ group: Int) -> Int? { Range(m.range(at: group), in: text).flatMap { Int(text[$0]) } }
    guard let line = number(1) ?? number(3), line > 0 else { return nil }
    return (line, max(1, number(2) ?? 1))
}

/// The files a ⌘-click on a terminal link may open in an editor tab, as paths relative to the
/// environment's root (`root`: the worktree, or `/workspace` in a container), most likely first:
/// a relative link against the shell's reported directory (`cwd`, OSC 7) and then the root, an
/// absolute or `file://` one as is. The line suffix (`terminalLinkSpot`) is dropped. Empty for a
/// URL of another scheme, a path outside the root and the root itself.
public func terminalLinkPaths(_ link: String, root: String, cwd: String? = nil) -> [String] {
    guard let text = linkPath(link) else { return [] }

    let root = standardized(root)
    var bases: [String] = []
    if text.hasPrefix("/") {
        bases = [""]
    } else {
        if let cwd, let dir = directory(of: cwd), relative(dir, to: root) != nil { bases.append(dir) }
        bases.append(root)
    }
    var paths: [String] = []
    for base in bases {
        let full = standardized(base.isEmpty ? text : base + "/" + text)
        if let rel = relative(full, to: root), !rel.isEmpty, !paths.contains(rel) { paths.append(rel) }
    }
    return paths
}

/// The relative path a link names (`token.ts` of `token.ts:33`, `lib/a.ts` of `./lib/a.ts:4`), to
/// look for among the environment's files when it is not at the shell's directory or the root.
/// nil for an absolute path, a URL, and a path with `..`.
public func terminalLinkName(_ link: String) -> String? {
    guard var text = linkPath(link), !text.hasPrefix("/") else { return nil }
    while text.hasPrefix("./") { text.removeFirst(2) }
    let parts = text.split(separator: "/", omittingEmptySubsequences: false)
    guard !text.isEmpty, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    return text
}

/// The files of `files` (paths relative to the root) a relative link may mean: the ones
/// `terminalLinkPaths` gives first, then every file whose path ends with the link's (`token.ts`
/// finds `src/lib/token.ts`), nearest the root first.
public func terminalLinkMatches(_ link: String, in files: [String], root: String, cwd: String? = nil) -> [String] {
    guard let name = terminalLinkName(link) else { return [] }
    let known = Set(files)
    var found = terminalLinkPaths(link, root: root, cwd: cwd).filter(known.contains)
    let suffix = "/" + name
    let rest = files.filter { ($0 == name || $0.hasSuffix(suffix)) && !found.contains($0) }
    func depth(_ path: String) -> Int { path.utf8.reduce(0) { $1 == UInt8(ascii: "/") ? $0 + 1 : $0 } }
    found += rest.sorted { (depth($0), $0) < (depth($1), $1) }
    return found
}

/// OSC 7 reports `file://host/path`; some shells send a bare path.
private func directory(of cwd: String) -> String? {
    if cwd.hasPrefix("file://") { return URL(string: cwd)?.path }
    return cwd.hasPrefix("/") ? cwd : nil
}

/// `..` and `.` resolved without touching the disk (a container's paths are not on it).
private func standardized(_ path: String) -> String {
    var parts: [Substring] = []
    for part in path.split(separator: "/") where part != "." {
        if part == ".." { _ = parts.popLast() } else { parts.append(part) }
    }
    return "/" + parts.joined(separator: "/")
}

private func relative(_ path: String, to root: String) -> String? {
    if path == root { return "" }
    let prefix = root == "/" ? "/" : root + "/"
    return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
}
