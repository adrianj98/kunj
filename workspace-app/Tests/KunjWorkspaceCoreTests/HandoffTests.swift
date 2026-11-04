import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct HandoffTests {
    @Test func anOpenInAppAgentEventIsOpenAgent() {
        #expect(parseEventLine(#"{"type":"agent","session":"kunj-app-x-abc123-a-handoff","running":true,"id":"handoff","worktree":"/w/x","open":"app","at":"t"}"#)
            == .openAgent(session: "kunj-app-x-abc123-a-handoff", id: "handoff", worktree: "/w/x"))
        #expect(parseEventLine(#"{"type":"agent","session":"kunj-app-x-abc123","running":true,"id":null,"worktree":"/w/x","open":"app","at":"t"}"#)
            == .openAgent(session: "kunj-app-x-abc123", id: nil, worktree: "/w/x"))
        // without open, or ending, it is the plain agent event
        #expect(parseEventLine(#"{"type":"agent","session":"s","running":true,"id":null,"worktree":"/w/x","at":"t"}"#)
            == .agent(session: "s", running: true, state: nil, repoRoot: nil))
        #expect(parseEventLine(#"{"type":"agent","session":"s","running":false,"open":"app","worktree":"/w/x","at":"t"}"#)
            == .agent(session: "s", running: false, state: nil, repoRoot: nil))
    }

    @Test func aPendingOpenWaitsForItsWorktreeThenExpires() {
        let t0 = Date(timeIntervalSince1970: 1000)
        let open = PendingAgentOpen(session: "s", id: "handoff", worktree: "/w/new", until: t0.addingTimeInterval(30))
        let before = [RepoEnvironments(repo: testRepo, backend: .docker, environments: [testWorktree(path: "/w/feat")])]
        var r = resolvePendingOpens([open], in: before, now: t0)
        #expect(r.ready.isEmpty && r.waiting == [open])
        let after = [RepoEnvironments(repo: testRepo, backend: .docker,
                                      environments: [testWorktree(path: "/w/feat"), testWorktree("handoff-x", path: "/w/new/")])]
        r = resolvePendingOpens([open], in: after, now: t0.addingTimeInterval(5))
        #expect(r.ready.map { $0.0.branch } == ["handoff-x"] && r.waiting.isEmpty)
        r = resolvePendingOpens([open], in: before, now: t0.addingTimeInterval(31))
        #expect(r.ready.isEmpty && r.waiting.isEmpty)
    }

    @Test func pathsCompareWithSymlinksResolved() {
        let open = PendingAgentOpen(session: "s", id: nil, worktree: "/tmp", until: .distantFuture)
        let repos = [RepoEnvironments(repo: testRepo, backend: .docker, environments: [testWorktree(path: "/private/tmp")])]
        #expect(resolvePendingOpens([open], in: repos, now: Date()).ready.count == 1)
    }
}
