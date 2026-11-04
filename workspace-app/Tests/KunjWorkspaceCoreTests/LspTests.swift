import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct LspTests {
    @Test func framesSplitAcrossReadsAndSeveralInOne() {
        let a = lspFrame(Data(#"{"id":1}"#.utf8)), b = lspFrame(Data(#"{"id":2,"é":"ü"}"#.utf8))
        var r = LspFrameReader()
        r.append(a.prefix(10))
        #expect(r.next() == nil)
        r.append(a.dropFirst(10) + b)
        #expect(r.next() == Data(#"{"id":1}"#.utf8))
        #expect(r.next() == Data(#"{"id":2,"é":"ü"}"#.utf8))
        #expect(r.next() == nil)
        // a garbage header is skipped
        r.append(Data("X-Nope: 1\r\n\r\n".utf8) + lspFrame(Data("{}".utf8)))
        #expect(r.next() == Data("{}".utf8))
    }

    static let config = LspListJson(
        servers: [], idleStopMinutes: .init(cached: 5, cold: 15), closedStopMinutes: 2, maxServers: 2, readyTimeoutMs: 1500)

    @Test func startsOnFirstTabStopsAfterClosingAndWhenIdle() {
        var p = LspPolicy(config: Self.config)
        let t0 = Date(timeIntervalSince1970: 0)
        let ts = LspKey(envId: "a", language: "typescript"), go = LspKey(envId: "a", language: "go")
        #expect(p.tabOpened(ts, cached: false, now: t0) == [])
        #expect(p.tabOpened(ts, cached: false, now: t0) == nil) // runs already
        #expect(p.tabOpened(go, cached: true, now: t0) == [])
        p.tabClosed(go, now: t0.addingTimeInterval(60))
        #expect(p.due(now: t0.addingTimeInterval(60 + 119)) == [])
        #expect(p.due(now: t0.addingTimeInterval(60 + 120)) == [go])
        p.stopped(go)
        #expect(p.running == [ts])
        // cold: 15 minutes idle with tabs open
        #expect(p.due(now: t0.addingTimeInterval(14 * 60)) == [])
        #expect(p.due(now: t0.addingTimeInterval(15 * 60)) == [ts])
        p.stopped(ts)
        // the next request restarts it
        #expect(p.used(ts, now: t0.addingTimeInterval(16 * 60)) == [])
        #expect(p.running == [ts])
    }

    @Test func theCapEvictsACachedServerFirstThenTheLeastRecentlyUsed() {
        var p = LspPolicy(config: Self.config) // max 2
        let t0 = Date(timeIntervalSince1970: 0)
        let tsA = LspKey(envId: "a", language: "typescript"), swiftA = LspKey(envId: "a", language: "swift")
        let tsB = LspKey(envId: "b", language: "typescript"), tsC = LspKey(envId: "c", language: "typescript")
        _ = p.tabOpened(tsA, cached: false, now: t0)
        _ = p.tabOpened(swiftA, cached: true, now: t0.addingTimeInterval(10))
        #expect(p.tabOpened(tsB, cached: false, now: t0.addingTimeInterval(20)) == [swiftA])
        p.stopped(swiftA)
        #expect(p.tabOpened(tsC, cached: false, now: t0.addingTimeInterval(30)) == [tsA])
    }

    @Test func locationsHoverAndMarkers() {
        let links: [[String: Any]] = [["targetUri": "file:///w/src/a.ts",
                                       "targetSelectionRange": ["start": ["line": 4, "character": 2], "end": ["line": 4, "character": 9]],
                                       "targetRange": ["start": ["line": 3, "character": 0], "end": ["line": 6, "character": 1]]]]
        #expect(lspLocations(links) == [LspLocation(path: "/w/src/a.ts", line: 5, column: 3, endColumn: 10)])
        #expect(lspLocations(["uri": "https://x/y", "range": ["start": ["line": 0, "character": 0], "end": ["line": 0, "character": 1]]]).isEmpty)
        #expect(lspRelativePath("/w/src/a.ts", root: "/w") == "src/a.ts")
        #expect(lspRelativePath("/elsewhere/a.ts", root: "/tmp/w") == nil)
        #expect(lspHoverMarkdown(["contents": ["kind": "markdown", "value": "**x**"]]) == "**x**")
        #expect(lspHoverMarkdown(["contents": [["language": "swift", "value": "let x: Int"], "doc"]]) == "```swift\nlet x: Int\n```\n\n---\n\ndoc")
        #expect(lspHoverMarkdown(nil) == nil)
        let m = lspMarkers([["range": ["start": ["line": 1, "character": 2], "end": ["line": 1, "character": 5]], "severity": 2, "message": "unused"]])
        #expect(m.count == 1 && m[0]["line"] as? Int == 2 && m[0]["column"] as? Int == 3 && m[0]["severity"] as? Int == 2)
        #expect(codePointColumn(utf16Column: 5, in: "😀ab c") == 4) // the emoji is 2 UTF-16 units, 1 scalar
        #expect(processTreeRSS("  10 1 100\n  11 10 50\n  12 11 25\n  13 1 999\n", root: 10) == 175)
    }

    /// The real sourcekit-lsp, when installed: initialize, open a file, go to a definition.
    @Test func sourcekitAnswersDefinition() async throws {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/sourcekit-lsp") else { return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kunj-lsp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("main.swift")
        let text = "func greet() -> String { \"hi\" }\nlet x = greet()\n"
        try text.write(to: file, atomically: true, encoding: .utf8)
        let c = LspConnection(key: LspKey(envId: "t", language: "swift"), root: dir.path,
                              spec: SpawnSpec(executable: "/usr/bin/sourcekit-lsp", arguments: [], cwd: dir.path,
                                              environment: ProcessInfo.processInfo.environment))
        try c.start()
        defer { c.stop() }
        #expect(await c.waitReady(timeout: 60))
        let uri = file.absoluteString
        c.notify("textDocument/didOpen", ["textDocument": ["uri": uri, "languageId": "swift", "version": 1, "text": text]])
        var found: [LspLocation] = []
        for _ in 0..<20 where found.isEmpty {
            let r = try await c.request("textDocument/definition", ["textDocument": ["uri": uri], "position": ["line": 1, "character": 9]], timeout: 30)
            found = lspLocations(r)
            if found.isEmpty { try await Task.sleep(nanoseconds: 500_000_000) }
        }
        #expect(found.first?.line == 1 && found.first?.column == 6)
    }
}
