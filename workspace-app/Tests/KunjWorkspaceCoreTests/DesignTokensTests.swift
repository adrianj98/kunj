import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct DesignTokensTests {
    @Test func tokensMatchDesignJSON() throws {
        let url = repoRoot.appendingPathComponent("docs/workspace-app/design/tokens.json")
        let json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let themes = try #require(json["themes"] as? [String: [String: String]])
        #expect(Set(themes.keys) == Set(DesignTokens.themes.map(\.name)))
        for t in DesignTokens.themes {
            let generated = Mirror(reflecting: t).children
                .filter { $0.label != "name" }
                .map { ($0.label!, $0.value as! String) }
                .sorted { $0.0 < $1.0 }
            let expected = try #require(themes[t.name]).sorted { $0.key < $1.key }
            #expect(generated.map(\.0) == expected.map(\.key), "keys of \(t.name)")
            #expect(generated.map(\.1) == expected.map(\.value), "values of \(t.name)")
        }
        #expect(DesignTokens.Layout.sidebarWidth == 272)
        #expect(DesignTokens.Layout.changesFileListWidth == 196)
        let layout = try #require(json["layout"] as? [String: Any])
        #expect(DesignTokens.Layout.headerHeight == layout["header-height"] as? Double)
        #expect(DesignTokens.Layout.tabbarHeight == layout["tabbar-height"] as? Double)
        #expect(DesignTokens.Layout.statusbarHeight == layout["statusbar-height"] as? Double)
    }

    @Test func warmIsTheDefaultTheme() {
        #expect(DesignTokens.warm.name == "warm")
        #expect(DesignTokens.themes.first == DesignTokens.warm)
    }

    @Test func parsesHex() {
        #expect(parseHex("#1a1816") == RGBA(r: 26 / 255, g: 24 / 255, b: 22 / 255, a: 1))
        #expect(parseHex("#fff") == RGBA(r: 1, g: 1, b: 1, a: 1))
        #expect(parseHex("#00000080") == RGBA(r: 0, g: 0, b: 0, a: 128 / 255))
        #expect(parseHex("nope") == nil)
        #expect(parseHex("#12345") == nil)
        #expect(parseHex("#gggggg") == nil)
    }
}
