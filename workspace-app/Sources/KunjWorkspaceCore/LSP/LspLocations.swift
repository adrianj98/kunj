import Foundation

/// A place a server pointed at: a file (absolute) and a 1-based line and UTF-16 column.
public struct LspLocation: Equatable, Sendable {
    public var path: String
    public var line: Int
    public var column: Int
    public var endColumn: Int
}

/// `Location`, `Location[]` or `LocationLink[]` (definition, references) as file locations; only
/// `file:` URIs.
public func lspLocations(_ result: Any?) -> [LspLocation] {
    let items: [[String: Any]]
    if let one = result as? [String: Any] { items = [one] } else { items = result as? [[String: Any]] ?? [] }
    return items.compactMap { item in
        let uri = (item["targetUri"] ?? item["uri"]) as? String
        let range = (item["targetSelectionRange"] ?? item["targetRange"] ?? item["range"]) as? [String: Any]
        guard let uri, let url = URL(string: uri), url.isFileURL,
              let start = range?["start"] as? [String: Any], let end = range?["end"] as? [String: Any],
              let line = start["line"] as? Int, let ch = start["character"] as? Int else { return nil }
        let endLine = end["line"] as? Int ?? line
        let endCh = end["character"] as? Int ?? ch
        return LspLocation(path: url.standardizedFileURL.path, line: line + 1, column: ch + 1,
                           endColumn: endLine == line ? endCh + 1 : ch + 1)
    }
}

/// `path` relative to `root` when it lies inside it (symlinks resolved on both), else nil.
public func lspRelativePath(_ path: String, root: String) -> String? {
    func norm(_ p: String) -> String { URL(fileURLWithPath: p).standardizedFileURL.resolvingSymlinksInPath().path }
    let r = norm(root), p = norm(path)
    guard p.hasPrefix(r + "/") else { return nil }
    return String(p.dropFirst(r.count + 1))
}

/// A hover's contents as markdown (`MarkupContent`, `MarkedString` or an array of them).
public func lspHoverMarkdown(_ result: Any?) -> String? {
    guard let hover = result as? [String: Any], let contents = hover["contents"] else { return nil }
    func text(_ c: Any) -> String? {
        if let s = c as? String { return s }
        if let d = c as? [String: Any] {
            if let kind = d["kind"] as? String, let value = d["value"] as? String {
                return kind == "markdown" ? value : value.isEmpty ? nil : "```\n\(value)\n```"
            }
            if let lang = d["language"] as? String, let value = d["value"] as? String { return "```\(lang)\n\(value)\n```" }
        }
        return nil
    }
    let parts: [String] = (contents as? [Any])?.compactMap(text) ?? [text(contents)].compactMap { $0 }
    let joined = parts.filter { !$0.isEmpty }.joined(separator: "\n\n---\n\n")
    return joined.isEmpty ? nil : joined
}

/// Diagnostics as the page's markers: { line, column, endLine, endColumn (1-based), severity 1–4, message }.
public func lspMarkers(_ diagnostics: Any?) -> [[String: Any]] {
    (diagnostics as? [[String: Any]] ?? []).compactMap { d in
        guard let range = d["range"] as? [String: Any], let s = range["start"] as? [String: Any],
              let e = range["end"] as? [String: Any], let sl = s["line"] as? Int, let sc = s["character"] as? Int,
              let el = e["line"] as? Int, let ec = e["character"] as? Int, let message = d["message"] as? String else { return nil }
        return ["line": sl + 1, "column": sc + 1, "endLine": el + 1, "endColumn": ec + 1,
                "severity": d["severity"] as? Int ?? 1, "message": message, "source": d["source"] as? String ?? ""]
    }
}

/// A 1-based UTF-16 column (LSP, Monaco) as a 1-based column in Unicode scalars (kunj's search, the
/// page's `revealLine`), on `line`.
public func codePointColumn(utf16Column: Int, in line: String) -> Int {
    var units = 0
    var scalars = 0
    for s in line.unicodeScalars {
        if units >= utf16Column - 1 { break }
        units += s.utf16.count
        scalars += 1
    }
    return scalars + 1
}

/// Sums the resident memory (KB) of `pid` and every process below it, from `ps -axo pid=,ppid=,rss=` output.
public func processTreeRSS(_ psOutput: String, root: Int32) -> Int {
    var children: [Int32: [Int32]] = [:]
    var rss: [Int32: Int] = [:]
    for line in psOutput.split(separator: "\n") {
        let f = line.split(separator: " ", omittingEmptySubsequences: true)
        guard f.count >= 3, let pid = Int32(f[0]), let ppid = Int32(f[1]), let kb = Int(f[2]) else { continue }
        children[ppid, default: []].append(pid)
        rss[pid] = kb
    }
    var total = 0
    var stack = [root]
    var seen = Set<Int32>()
    while let p = stack.popLast() {
        guard seen.insert(p).inserted else { continue }
        total += rss[p] ?? 0
        stack += children[p] ?? []
    }
    return total
}
