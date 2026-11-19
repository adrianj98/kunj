import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct SavedAgentsTests {
    @Test func decodesTheSavedListing() throws {
        let json = #"{"branch":"feature/x","worktree":"/w/feat","items":[{"session":"kunj-app-x-a-1","id":"1","conversation":"c1","savedAt":"2026-11-19T10:00:00.000Z","title":"fix it"},{"session":"kunj-app-x","id":null,"conversation":"c0","savedAt":"2026-11-18T10:00:00.000Z","title":null}]}"#
        let saved = try JSONDecoder().decode(SavedAgentsJson.self, from: Data(json.utf8))
        #expect(saved.items.map(\.id) == ["1", nil])
        #expect(saved.items[1].title == nil)
    }

    @Test func argumentsOnlyForAWorktree() {
        #expect(savedAgentsArguments(testWorktree()) == ["agent", "saved", "feature/x"])
        #expect(forgetSavedAgentsArguments(testWorktree()) == ["agent", "forget", "feature/x", "--all"])
        #expect(savedAgentsArguments(testContainer()) == nil)
        #expect(forgetSavedAgentsArguments(testContainer()) == nil)
    }

    @Test func titleIsThePromptAndHowLongAgo() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let at = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3 * 3600))
        #expect(savedAgentTitle(SavedAgent(session: "s", id: "1", conversation: "c", savedAt: at, title: "fix it"), now: now) == "fix it  ·  3h")
        #expect(savedAgentTitle(SavedAgent(session: "s", id: nil, conversation: "c", savedAt: "bad", title: nil), now: now) == "New conversation")
    }

    @Test func onlyAWorktreeClaudeAgentResumes() {
        func spec(_ args: [String], agent: String? = nil) -> TerminalSpec {
            var s = TerminalSpec(executable: "/usr/bin/env", arguments: ["kunj"] + args, cwd: "/", environment: [:], title: "agent", closeOnExitZero: false)
            s.agent = agent
            return s
        }
        #expect(canResumeAgent(spec(["agent", "feature/x", "--session", "1"])))
        #expect(!canResumeAgent(spec(["agent", "feature/x", "--agent", "antigravity"], agent: "antigravity")))
        #expect(!canResumeAgent(spec(["ct", "agent", "feature/x"])))
    }
}
