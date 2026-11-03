import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct DefinitionTests {
    @Test func onlyIdentifiersAreAsked() {
        #expect(isDefinitionWord("loadConfig"))
        #expect(isDefinitionWord("_private$"))
        #expect(isDefinitionWord("$store"))
        #expect(!isDefinitionWord(""))
        #expect(!isDefinitionWord("9lives"))
        #expect(!isDefinitionWord("a.b"))
        #expect(!isDefinitionWord("x|y"))
        #expect(!isDefinitionWord("(a"))
        #expect(!isDefinitionWord("é"))
        #expect(!isDefinitionWord(String(repeating: "a", count: 129)))
    }

    @Test func queryIsCaseSensitiveRegexInTheEnvironment() {
        let q = definitionQuery("Foo")
        #expect(q.regex && !q.ignoreCase && !q.word && q.scope == .environment)
    }

    /// The pattern as `git grep -E` reads it: the declarations match, uses do not.
    @Test func patternMatchesDeclarationsWithGitGrep() throws {
        let lines = [
            "export function loadConfig(path: string) {",       // 1 yes
            "  const cfg = loadConfig(p);",                      // 2 no
            "export const loadConfig = async (p) => {",          // 3 yes
            "  loadConfig: function () {",                       // 4 yes
            "  async loadConfig(path: string): Promise<C> {",    // 5 yes
            "  return loadConfig(x) {",                          // 6 no
            "func loadConfig(at url: URL) throws -> Config {",   // 7 yes
            "func (s *Store) loadConfig() error {",              // 8 yes
            "class loadConfigError {}",                          // 9 no (another name)
            "let x = obj.loadConfig = 3",                        // 10 no
            "    case loadConfig",                               // 11 yes
            "def loadConfig(self):",                             // 12 yes
            "  if (loadConfig(x)) {",                            // 13 no
            "  loadConfig(() => {",                              // 14 no (a call taking a closure)
            "  loadConfig(a) => {",                              // 15 no
        ]
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kunj-def-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try (lines.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("a.ts"), atomically: true, encoding: .utf8)
        func git(_ args: [String]) throws -> String {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = ["git", "-C", dir.path] + args
            let out = Pipe()
            p.standardOutput = out
            try p.run()
            p.waitUntilExit()
            return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        }
        _ = try git(["init", "-q"])
        _ = try git(["add", "a.ts"])
        let out = try git(["grep", "-n", "-E", "-e", definitionPattern("loadConfig"), "--", "a.ts"])
        let matched = out.split(separator: "\n").compactMap { Int($0.split(separator: ":")[1]) }
        #expect(matched == [1, 3, 4, 5, 7, 8, 11, 12])
    }

    func result(_ matches: [(String, Int, String)]) -> SearchJson {
        SearchJson(searched: SearchCounts(worktrees: 1, branches: 0, containers: 0),
                   sources: [SearchSource(kind: "worktree", branch: "main", path: "/r", container: nil, isCurrent: true,
                                          matches: matches.map { SearchMatch(path: $0.0, line: $0.1, column: 1, length: 0, text: $0.2) },
                                          truncated: false, error: nil),
                             SearchSource(kind: "branch", branch: "other", path: nil, container: nil, isCurrent: nil,
                                          matches: [SearchMatch(path: "z.ts", line: 1, column: 1, length: 0, text: "class Foo {")],
                                          truncated: false, error: nil)],
                   containers: nil)
    }

    @Test func rankedTypesFirstThenLanguageThenNotTests() {
        let r = result([
            ("src/__tests__/foo.test.ts", 3, "class Foo {}"),
            ("src/a.ts", 10, "  const Foo = 1"),
            ("src/foo.swift", 1, "struct Foo {"),
            ("src/foo.ts", 4, "export class Foo {"),
        ])
        let c = definitionCandidates(r, word: "Foo", fromPath: "src/b.ts", fromLine: 1)
        #expect(c.map(\.path) == ["src/foo.ts", "src/__tests__/foo.test.ts", "src/foo.swift", "src/a.ts"])
        #expect(c[0].column == 14 && c[0].length == 3 && c[0].tier == 0)
        #expect(c[3].tier == 1)
        #expect(definitionIsUnambiguous(c)) // the source beats the test that also declares it
        #expect(definitionIsUnambiguous(Array(c.dropFirst(2)))) // swift tier 0, then tier 1
    }

    @Test func theClickedLineAndBranchSourcesAreLeftOut() {
        let r = result([("src/foo.ts", 4, "export class Foo {"), ("src/bar.ts", 2, "class Foo {}")])
        let c = definitionCandidates(r, word: "Foo", fromPath: "src/foo.ts", fromLine: 4)
        #expect(c.map(\.path) == ["src/bar.ts"])
        #expect(definitionIsUnambiguous(c))
        #expect(!definitionIsUnambiguous([]))
    }

    @Test func sameLanguageBeatsAnotherAtTheSameTier() {
        let r = result([("a.swift", 1, "func run() {"), ("b.ts", 1, "function run() {")])
        let c = definitionCandidates(r, word: "run", fromPath: "x.tsx", fromLine: nil)
        #expect(c.map(\.path) == ["b.ts", "a.swift"])
        #expect(definitionIsUnambiguous(c))
    }

    @Test func twoSourcesOfOneRankAreOffered() {
        let r = result([("src/a.ts", 1, "export class Foo {"), ("src/b.ts", 1, "export class Foo {")])
        #expect(!definitionIsUnambiguous(definitionCandidates(r, word: "Foo", fromPath: "src/c.ts", fromLine: 1)))
    }

    @Test func buildOutputRanksAfterTheSource() {
        let r = result([(".build/bundle.js", 5868, "function getKunjDir() {"),
                        ("src/lib/config.ts", 102, "export function getKunjDir(): string {"),
                        ("dist/lib/config.d.ts", 3, "export declare function getKunjDir(): string;")])
        let c = definitionCandidates(r, word: "getKunjDir", fromPath: "src/commands/x.ts", fromLine: 1)
        #expect(c.first?.path == "src/lib/config.ts")
        #expect(definitionIsUnambiguous(c))
        #expect(isGeneratedPath("node_modules/x/index.js") && isGeneratedPath("a/jquery.min.js"))
        #expect(!isGeneratedPath("src/builder.ts") && !isGeneratedPath(".eslintrc.js"))
    }

    @Test func wordColumnCountsCharactersAndWholeWords() {
        #expect(wordColumn("Foo", in: "class FooBar extends Foo") == 22)
        #expect(wordColumn("Foo", in: "😀 class Foo") == 9)
        #expect(wordColumn("Foo", in: "class Fo…") == nil)
        // code points, as the page counts: a decomposed é is two
        #expect(wordColumn("Foo", in: "const cafe\u{301} = 1; export class Foo") == 31)
        #expect(declarationTier("Foo", in: "func (s *Store) Foo() {") == 0)
        #expect(declarationTier("Foo", in: "  Foo(a) {") == 2)
    }
}
