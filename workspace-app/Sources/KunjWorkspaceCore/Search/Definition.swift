import Foundation

// Go to declaration (⌘-click or F12 in an editor tab or the Changes diff). There are no language
// servers: the page sends the identifier under the pointer, `kunj search` looks for a line that
// declares it in the environment, and the candidates are ranked here. The page never names a file.

/// An identifier the page may ask for: letters, digits, `_` and `$`, not starting with a digit, at
/// most 128 characters. Anything else is ignored, so the word can go into a regex.
public func isDefinitionWord(_ word: String) -> Bool {
    guard (1...128).contains(word.count), let first = word.unicodeScalars.first else { return false }
    let start = CharacterSet.letters.union(CharacterSet(charactersIn: "_$"))
    let rest = start.union(CharacterSet(charactersIn: "0123456789"))
    guard start.contains(first), word.unicodeScalars.allSatisfy({ rest.contains($0) && $0.isASCII }) else { return false }
    return true
}

/// The keywords that introduce a declaration of a type or a function (tier 0) and of a value or
/// an enum case (tier 1), across Swift, TypeScript/JavaScript, Python, Go, Rust, Kotlin and friends.
let typeKeywords = ["class", "struct", "enum", "protocol", "extension", "typealias", "actor", "interface",
                    "type", "trait", "impl", "mod", "module", "namespace", "record", "object", "union",
                    "func", "function", "def", "fn", "macro"]
let valueKeywords = ["let", "var", "const", "val", "case"]

/// The extended regex (`git grep -E`, POSIX classes) for a line that declares `word`:
/// `<keyword> word`, a Go method `func (r T) word(`, `word = function`/`word = (…) =>`/`word: function`,
/// and a method `word(…) {` at the start of a line.
public func definitionPattern(_ word: String) -> String {
    let w = word.replacingOccurrences(of: "$", with: "\\$")
    let end = "([^[:alnum:]_$]|$)"
    let keywords = (typeKeywords + valueKeywords).joined(separator: "|")
    let modifiers = "(export|default|public|private|protected|internal|fileprivate|open|static|async|override|readonly|abstract|final|get|set|mutating)"
    return [
        "(^|[^[:alnum:]_$.])(\(keywords))[[:space:]]+\\*?\(w)\(end)",
        "func[[:space:]]*\\([^)]*\\)[[:space:]]*\(w)[[:space:]]*\\(",
        "(^|[^[:alnum:]_$.])\(w)[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\([^)]*\\)[^=;]*=>|[[:alnum:]_$]+[[:space:]]*=>)",
        "^[[:space:]]*(\(modifiers)[[:space:]]+)*\(w)[[:space:]]*(<[^>]*>)?\\([^;]*\\)[^;]*\\{[[:space:]]*$",
    ].joined(separator: "|")
}

/// The search for `word`'s declaration in `env` (case-sensitive, regex, this environment only).
public func definitionQuery(_ word: String) -> SearchQuery {
    SearchQuery(text: definitionPattern(word), ignoreCase: false, word: false, regex: true, scope: .environment)
}

/// A line that declares the word, with the word's spot on it (1-based column in characters).
public struct DefinitionCandidate: Equatable, Sendable {
    public var path: String
    public var line: Int
    public var column: Int
    public var length: Int
    public var text: String
    /// Lower is better: 0 a type or function keyword, 1 `let`/`var`/`const`/`case`, 2 the rest.
    public var tier: Int
    /// How it ranks, compared in order: the tier, then 0 for the language the click came from,
    /// then 0 for a source file (not generated or vendored), then 0 for not a test, then 0 for the
    /// file the click came from.
    public var rank: [Int]
}

/// The candidates for `word` in a search result, best first (by `rank`, then path and line). The
/// spot the click came from (`fromPath`:`fromLine`) is left out, and so are branch sources.
public func definitionCandidates(_ result: SearchJson, word: String, fromPath: String?, fromLine: Int?) -> [DefinitionCandidate] {
    let family = fromPath.map(languageFamily)
    var found: [DefinitionCandidate] = []
    for source in result.sources where source.kind != "branch" {
        for m in source.matches {
            if m.path == fromPath && m.line == fromLine { continue }
            guard let column = wordColumn(word, in: m.text) else { continue }
            let tier = declarationTier(word, in: m.text)
            let rank = [tier, family != nil && languageFamily(m.path) == family ? 0 : 1,
                        isGeneratedPath(m.path) ? 1 : 0, isTestPath(m.path) ? 1 : 0, m.path == fromPath ? 0 : 1]
            found.append(DefinitionCandidate(path: m.path, line: m.line, column: column, length: word.count,
                                             text: m.text.trimmingCharacters(in: .whitespaces), tier: tier, rank: rank))
        }
    }
    return found.sorted { a, b in
        if a.rank != b.rank { return a.rank.lexicographicallyPrecedes(b.rank) }
        if a.path != b.path { return a.path < b.path }
        return a.line < b.line
    }
}

/// Opens at once when the best candidate ranks above the next on tier, language, source or test
/// (being in the same file does not settle it); otherwise the candidates are offered.
public func definitionIsUnambiguous(_ candidates: [DefinitionCandidate]) -> Bool {
    guard let best = candidates.first else { return false }
    guard candidates.count > 1 else { return true }
    return best.rank.prefix(4).lexicographicallyPrecedes(candidates[1].rank.prefix(4))
}

/// The word's first whole-word occurrence after the declaring keyword (else anywhere), as a
/// 1-based column in characters; nil when the line does not hold it (cut short by kunj).
func wordColumn(_ word: String, in text: String) -> Int? {
    let chars = Array(text)
    let w = Array(word)
    guard chars.count >= w.count else { return nil }
    var i = 0
    while i + w.count <= chars.count {
        if Array(chars[i..<i + w.count]) == w,
           i == 0 || !isWordChar(chars[i - 1]),
           i + w.count == chars.count || !isWordChar(chars[i + w.count]) {
            return i + 1
        }
        i += 1
    }
    return nil
}

private func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "$" }

/// 0 when a type or function keyword (or a Go method) declares the word, 1 for a value keyword, else 2.
func declarationTier(_ word: String, in text: String) -> Int {
    let tokens = text.split(whereSeparator: { !isWordChar($0) && $0 != "*" }).map(String.init)
    for (i, t) in tokens.enumerated() where i + 1 < tokens.count {
        let next = tokens[i + 1].hasPrefix("*") ? String(tokens[i + 1].dropFirst()) : tokens[i + 1]
        guard next == word else { continue }
        if typeKeywords.contains(t) { return 0 }
        if valueKeywords.contains(t) { return 1 }
    }
    // a Go method: `func (r *T) word(`
    return text.trimmingCharacters(in: .whitespaces).hasPrefix("func (") ? 0 : 2
}

/// Files that read each other's declarations: TypeScript and JavaScript are one family, C and its
/// headers another; otherwise the extension.
func languageFamily(_ path: String) -> String {
    let ext = (path as NSString).pathExtension.lowercased()
    switch ext {
    case "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts": return "js"
    case "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm": return "c"
    default: return ext
    }
}

/// Build output, dependencies and minified files: a declaration there is a copy of a real one.
func isGeneratedPath(_ path: String) -> Bool {
    let parts = path.lowercased().split(separator: "/").dropLast()
    let dirs: Set<String> = ["dist", "build", "out", "node_modules", "vendor", "third_party", "generated", "target"]
    if parts.contains(where: { dirs.contains(String($0)) || $0.hasPrefix(".") }) { return true }
    let name = (path as NSString).lastPathComponent.lowercased()
    return name.contains(".min.") || name.hasSuffix(".map") || name.hasSuffix(".d.ts")
}

func isTestPath(_ path: String) -> Bool {
    let p = "/" + path.lowercased()
    return p.contains("/__tests__/") || p.contains("/tests/") || p.contains("/test/")
        || p.contains(".test.") || p.contains(".spec.") || p.contains("_test.")
}
