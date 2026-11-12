import Foundation
import SwiftTerm
import Testing

/// The link under the pointer, as the patched SwiftTerm (scripts/prepare-swiftterm.sh) finds it:
/// what ⌘ underlines and ⌘-click hands to `TabRegistry.openLink`.
@Suite struct TerminalLinkDetectionTests {
    /// The link at the first character of `word` in a terminal showing `text`.
    private func link(in text: String, at word: String) -> String? {
        let headless = HeadlessTerminal { _ in }
        let terminal = headless.terminal!
        terminal.feed(text: text)
        guard let range = text.range(of: word) else { return nil }
        let col = text.distance(from: text.startIndex, to: range.lowerBound)
        return terminal.link(at: .screen(Position(col: col, row: 0)), mode: .explicitAndImplicit)
    }

    @Test func aBareFileNameWithALineIsALink() {
        #expect(link(in: "see token.ts:33 for it", at: "token") == "token.ts:33")
        #expect(link(in: "at bob.ts:44-30, then", at: "bob") == "bob.ts:44-30")
        #expect(link(in: "(a.test.ts:12:5)", at: "a.test") == "a.test.ts:12:5")
        #expect(link(in: "● Update(Makefile.am:7)", at: "Makefile") == "Makefile.am:7")
    }

    @Test func pathsStillCarryTheirLine() {
        #expect(link(in: "see src/lib/token.ts:33 for it", at: "src") == "src/lib/token.ts:33")
        #expect(link(in: "see src/lib/bob.ts:44-30 for it", at: "src") == "src/lib/bob.ts:44-30")
    }

    @Test func plainWordsAreNotLinks() {
        #expect(link(in: "see token.ts for it", at: "token") == nil)
        #expect(link(in: "at 12:30 e.g. this", at: "12") == nil)
        #expect(link(in: "at 12:30 e.g. this", at: "e.g") == nil)
        #expect(link(in: "v1.2:3 and 10.0.0.1:80", at: "10") == nil)
    }
}
