import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct SessionsTests {
    /// A real `kunj sessions list --containers --json` (paths shortened) plus one container session.
    func fixture() async throws -> SessionsJson {
        try await fakeKunjCLI().run(sessionsListArguments(containers: true), cwd: "/")
    }

    @Test func decodesTheListing() async throws {
        let json = try await fixture()
        #expect(json.tmux == "ok")
        #expect(json.idleHours == 24)
        #expect(json.sessions.count == 4)
        let gone = json.sessions[0]
        #expect(gone.orphan == "worktree-gone")
        #expect(gone.worktree == nil)
        #expect(sessionPlace(gone) == "alertd-core · worktree removed")
        #expect(json.sessions[1].attached.first?.via == "Kunj Workspace")
        let inContainer = json.sessions[3]
        #expect(sessionPlace(inContainer) == "alertd-core · feature/x (container)")
        #expect(json.containers?.items.first?.count == 1)
    }

    @Test func listArguments() {
        #expect(sessionsListArguments(containers: false) == ["sessions", "list"])
        #expect(sessionsListArguments(containers: true) == ["sessions", "list", "--containers"])
    }

    @Test func killGroupsHostSessionsAndOneCallPerContainer() {
        let s = [
            TmuxSession(name: "kunj-a", kind: "agent"),
            TmuxSession(name: "agent", kind: "agent", container: "c1"),
            TmuxSession(name: "kunjsh-b-sh-1", kind: "shell"),
            TmuxSession(name: "sh-2", kind: "shell", container: "c1"),
            TmuxSession(name: "agent", kind: "agent", container: "c2"),
        ]
        #expect(sessionsKillArguments(s) == [
            ["sessions", "kill", "kunj-a", "kunjsh-b-sh-1"],
            ["sessions", "kill", "agent", "sh-2", "--container", "c1"],
            ["sessions", "kill", "agent", "--container", "c2"],
        ])
        #expect(sessionsKillArguments([]) == [])
        #expect(sessionsKillArguments(Array(s.prefix(2)), ifDetached: true) == [
            ["sessions", "kill", "kunj-a", "--if-detached"],
            ["sessions", "kill", "agent", "--container", "c1", "--if-detached"],
        ])
    }

    @Test func filtersAndStatusRespectOpenTabs() {
        let idle = TmuxSession(name: "kunjsh-x-sh-t1", kind: "shell", id: "t1", orphan: "idle")
        let attached = TmuxSession(name: "kunj-y", kind: "agent", attached: [SessionAttach(tty: "/dev/ttys1", pid: 1, via: nil)])
        #expect(SessionsFilter.orphans.includes(idle, tabbed: false))
        #expect(!SessionsFilter.orphans.includes(idle, tabbed: true))
        #expect(!SessionsFilter.detached.includes(attached, tabbed: false))
        #expect(sessionIsTabbed(idle, tabSessionIds: ["t1"]))
        #expect(!sessionIsTabbed(attached, tabSessionIds: ["t1"]))
        #expect(sessionStatusText(idle, tabbed: false) == "Orphan: idle")
        #expect(sessionStatusText(idle, tabbed: true) == "Idle (tab open)")
        #expect(sessionStatusText(attached, tabbed: false) == "Attached")
        #expect(sessionAttachedText(attached) == "/dev/ttys1")
        #expect(sessionAttachedText(idle) == "—")
    }

    @Test func formatsUsageAndAge() {
        #expect(formatCPU(nil) == "—")
        #expect(formatCPU(SessionUsage(cpu: 95.8, memoryBytes: 0)) == "96%")
        #expect(formatCPU(SessionUsage(cpu: 0.25, memoryBytes: 0)) == "0.2%" || formatCPU(SessionUsage(cpu: 0.25, memoryBytes: 0)) == "0.3%")
        #expect(formatMemory(SessionUsage(cpu: 0, memoryBytes: 1_073_741_824)) == "1.0 GB")
        #expect(formatMemory(SessionUsage(cpu: 0, memoryBytes: 81_788_928)) == "78 MB")
        #expect(formatMemory(SessionUsage(cpu: 0, memoryBytes: 7_340)) == "7 KB")
        let now = ISO8601DateFormatter().date(from: "2026-10-27T12:00:00Z")!
        #expect(formatAge("2026-10-27T11:59:30.000Z", now: now) == "now")
        #expect(formatAge("2026-10-27T11:15:00.000Z", now: now) == "45m")
        #expect(formatAge("2026-10-27T09:00:00Z", now: now) == "3h")
        #expect(formatAge("2026-10-24T12:00:00.000Z", now: now) == "3d")
        #expect(formatAge(nil, now: now) == "—")
        let summary = sessionsSummary([
            TmuxSession(name: "a", kind: "agent", usage: SessionUsage(cpu: 10, memoryBytes: 1_048_576), orphan: "idle"),
            TmuxSession(name: "b", kind: "shell", usage: SessionUsage(cpu: 2.5, memoryBytes: 1_048_576)),
        ])
        #expect(summary == "2 sessions · 1 orphaned · 12% CPU · 2 MB")
    }

    @Test func sumsUsagePerWorktree() {
        let wt = SessionWorktree(path: "/r/kunj/worktrees/main/", branch: "main")
        let byPath = sessionUsageByWorktree([
            TmuxSession(name: "a", kind: "agent", worktree: wt, usage: SessionUsage(cpu: 60, memoryBytes: 400 * 1_048_576)),
            TmuxSession(name: "s", kind: "shell", worktree: wt, usage: SessionUsage(cpu: 5, memoryBytes: 25 * 1_048_576)),
            TmuxSession(name: "c", kind: "agent", worktree: wt, container: "kunj-r-main-1",
                        usage: SessionUsage(cpu: 99, memoryBytes: 1)),
            TmuxSession(name: "gone", kind: "agent", usage: SessionUsage(cpu: 1, memoryBytes: 1)),
            TmuxSession(name: "nousage", kind: "shell", worktree: SessionWorktree(path: "/r/other", branch: nil)),
        ])
        #expect(byPath.count == 1)
        #expect(byPath["/r/kunj/worktrees/main"] == SessionUsage(cpu: 65, memoryBytes: 425 * 1_048_576))
        #expect(formatUsageShort(byPath["/r/kunj/worktrees/main"]!) == "65% 425M")
        #expect(formatUsageShort(SessionUsage(cpu: 0.1, memoryBytes: 19 * 1_048_576)) == "0.1% 19M")
        #expect(formatUsageShort(SessionUsage(cpu: 3, memoryBytes: 1_288_490_189)) == "3.0% 1.2G")
    }
}
