import Foundation
import Testing
@testable import KunjWorkspaceCore

/// Collects what the stream delivers, from whichever thread it calls on.
final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [KunjEvent] = []
    func add(_ e: KunjEvent) { lock.lock(); items.append(e); lock.unlock() }
    var events: [KunjEvent] { lock.lock(); defer { lock.unlock() }; return items }
}

/// Polls `condition` every 10 ms until it holds or `seconds` pass.
func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return condition()
}

@Suite struct EventStreamTests {
    @Test func parseEventLines() {
        #expect(parseEventLine(#"{"type":"hello","version":"1.3.0","repos":2,"at":"x"}"#)
            == .hello(version: "1.3.0", repos: 2))
        #expect(parseEventLine(#"{"type":"git","repo":{"name":"app","root":"/r/app"},"at":"x"}"#)
            == .git(repoRoot: "/r/app"))
        #expect(parseEventLine(#"{"type":"git","at":"x"}"#) == .git(repoRoot: nil))
        #expect(parseEventLine(#"{"type":"sessions","at":"x"}"#) == .registry(kind: "sessions", repoRoot: nil))
        #expect(parseEventLine(#"{"type":"repos","repo":{"name":"a","root":"/a"},"at":"x"}"#)
            == .registry(kind: "repos", repoRoot: "/a"))
        #expect(parseEventLine(#"{"type":"container","repo":null,"branch":null,"container":"kunj-a-b-1","action":"die","at":"x"}"#)
            == .container(repoRoot: nil, branch: nil, container: "kunj-a-b-1", action: "die"))
        #expect(parseEventLine(#"{"type":"container","repo":{"name":"a","root":"/a"},"branch":"feature/x","container":"c","action":"status","at":"x"}"#)
            == .container(repoRoot: "/a", branch: "feature/x", container: "c", action: "status"))
        #expect(parseEventLine(#"{"type":"agent","session":"kunj-a-main-1","running":true,"state":"waiting","repo":{"name":"a","root":"/a"},"at":"x"}"#)
            == .agent(session: "kunj-a-main-1", running: true, state: "waiting", repoRoot: "/a"))
        #expect(parseEventLine(#"{"type":"agent","session":"s","running":false,"at":"x"}"#)
            == .agent(session: "s", running: false, state: nil, repoRoot: nil))
        #expect(parseEventLine(#"{"type":"backend","status":"unavailable","message":"no docker","at":"x"}"#)
            == .backend(available: false, message: "no docker"))
        #expect(parseEventLine(#"{"type":"backend","status":"available","at":"x"}"#)
            == .backend(available: true, message: nil))
        #expect(parseEventLine(#"{"error":{"code":"bad-repo","message":"nope"}}"#)
            == .error(code: "bad-repo", message: "nope"))
        #expect(parseEventLine(#"{"error":"plain"}"#) == .error(code: nil, message: "plain"))
        #expect(parseEventLine("not json") == nil)
        #expect(parseEventLine(#"{"type":"container","at":"x"}"#) == nil)
        #expect(parseEventLine(#"{"type":"future-kind","at":"x"}"#) == nil)
        #expect(parseEventLine("") == nil)
    }

    @Test func fixtureParses() throws {
        let text = try String(contentsOf: responsesDir.appendingPathComponent("events.ndjson"), encoding: .utf8)
        let events = text.split(separator: "\n").compactMap { parseEventLine(String($0)) }
        #expect(events.count == 4)
        #expect(events.first == .hello(version: "1.3.0", repos: 2))
        #expect(events.last == .backend(available: false, message: "Cannot connect to the Docker daemon"))
    }

    @Test func streamDeliversAndRestarts() async {
        let box = EventBox()
        let stream = EventStream(cli: fakeKunjCLI(environment: ["FAKE_KUNJ_EVENTS_EXIT": "1"]),
                                 onEvent: { box.add($0) }, backoff: 0.05...0.1)
        stream.start()
        let ok = await waitUntil(3) { box.events.count >= 5 && stream.restarts >= 1 }
        await stream.stop()
        #expect(ok)
        #expect(Array(box.events.prefix(4)) == [
            .hello(version: "1.3.0", repos: 2),
            .git(repoRoot: "/Users/demo/projects/alertd-core.git"),
            .container(repoRoot: "/Users/demo/projects/alertd-core.git", branch: "feat/llm-insights",
                       container: "kunj-alertd-core-feat-llm-insights-1a2b3c", action: "status"),
            .backend(available: false, message: "Cannot connect to the Docker daemon"),
        ])
        #expect(box.events[4] == .hello(version: "1.3.0", repos: 2))
    }

    @Test func stopClosesStdinAndWaits() async throws {
        let box = EventBox()
        let stream = EventStream(cli: fakeKunjCLI(), onEvent: { box.add($0) }, backoff: 0.05...0.1)
        stream.start()
        #expect(await waitUntil(3) { box.events.count >= 4 })
        let pid = try #require(stream.pid)
        #expect(kill(pid, 0) == 0)
        let started = Date()
        await stream.stop()
        // Closing stdin ends it (fake-kunj, like kunj events, exits on EOF): no SIGTERM after 2 s.
        #expect(Date().timeIntervalSince(started) < 1.5)
        #expect(kill(pid, 0) == -1)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(stream.pid == nil)
        #expect(stream.restarts == 0)
    }

    @Test func stopTerminatesAChildThatIgnoresStdin() async throws {
        // A child that never reads stdin: stop() falls back to SIGTERM after its 2 s wait.
        let dir = try tempDirectory()
        let script = dir.appendingPathComponent("stubborn")
        try "#!/bin/sh\necho '{\"type\":\"hello\",\"version\":\"1.3.0\",\"repos\":0}'\nexec sleep 30\n"
            .write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let box = EventBox()
        let stream = EventStream(cli: KunjCLI(command: script.path, path: "/usr/bin:/bin"),
                                 onEvent: { box.add($0) }, backoff: 0.05...0.1)
        stream.start()
        #expect(await waitUntil(3) { !box.events.isEmpty })
        let pid = try #require(stream.pid)
        await stream.stop()
        #expect(kill(pid, 0) == -1)
    }

    @Test func restartReplacesTheChild() async throws {
        // kunj events resolves its repositories once, so the store restarts it when they change.
        let box = EventBox()
        let stream = EventStream(cli: fakeKunjCLI(), onEvent: { box.add($0) }, backoff: 0.05...0.1)
        stream.start()
        #expect(await waitUntil(3) { box.events.count >= 4 })
        let first = try #require(stream.pid)
        stream.restart()
        let ok = await waitUntil(3) { stream.restarts == 1 && stream.pid != nil && stream.pid != first }
        #expect(ok)
        #expect(kill(first, 0) == -1)
        #expect(await waitUntil(3) { box.events.filter { if case .hello = $0 { return true }; return false }.count == 2 })
        await stream.stop()
    }

    @Test func restartBeforeStartIsHarmless() async {
        let stream = EventStream(cli: fakeKunjCLI(), onEvent: { _ in })
        stream.restart()
        try? await Task.sleep(nanoseconds: 100_000_000)
        #expect(stream.pid == nil)
        #expect(stream.restarts == 0)
    }

    @Test func stopBeforeStartIsHarmless() async {
        let stream = EventStream(cli: fakeKunjCLI(), onEvent: { _ in })
        await stream.stop()
        #expect(stream.pid == nil)
    }
}
