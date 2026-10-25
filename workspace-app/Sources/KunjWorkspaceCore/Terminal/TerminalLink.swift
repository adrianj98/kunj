import Foundation

/// The files a ⌘-click on a terminal link may open in an editor tab, as paths relative to the
/// environment's root (`root`: the worktree, or `/workspace` in a container), most likely first:
/// a relative link against the shell's reported directory (`cwd`, OSC 7) and then the root, an
/// absolute or `file://` one as is. A `:line[:col]` or `#L…` suffix is dropped. Empty for a URL of
/// another scheme, a path outside the root and the root itself.
public func terminalLinkPaths(_ link: String, root: String, cwd: String? = nil) -> [String] {
    var text = link.trimmingCharacters(in: .whitespaces)
    if text.hasPrefix("file://") {
        guard let path = URL(string: text)?.path, !path.isEmpty else { return [] }
        text = path
    }
    if let range = text.range(of: #"(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$"#, options: .regularExpression) {
        text.removeSubrange(range)
    }
    // mailto:, https://, … (after the suffix, or `README.md:12` would read as a scheme)
    if text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil { return [] }
    if text.hasPrefix("~/") { text = NSHomeDirectory() + text.dropFirst() }
    guard !text.isEmpty, !text.contains("\0") else { return [] }

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
