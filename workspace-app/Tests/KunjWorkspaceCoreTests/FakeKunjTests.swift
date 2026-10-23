import Foundation
import Testing

/// The fixture CLI (Tests/Fixtures/fake-kunj) every KunjCLI test runs against: these pin its
/// naming rule and switches so later tasks' fixtures can rely on them.
@Suite struct FakeKunjTests {
    @Test func responseNameRule() {
        #expect(fakeKunjResponseName(["worktree", "list", "--json"]) == "worktree_list")
        #expect(fakeKunjResponseName(["ct", "file", "read", "feature/x", "src/a.ts", "--json"])
            == "ct_file_read_feature-x_src-a.ts")
        #expect(fakeKunjResponseName(["worktree", "list", "--no-pr", "--json"]) == "worktree_list_no-pr")
    }

    @Test func answersFromTheResponsesDirectory() throws {
        let dir = try tempDirectory()
        try #"{"repos":[]}"#.write(to: dir.appendingPathComponent("repos.json"), atomically: true, encoding: .utf8)
        try #"{"content":"x"}"#.write(
            to: dir.appendingPathComponent("ct_file_read_feature-x_src-a.ts.json"), atomically: true, encoding: .utf8)

        let repos = try runFakeKunj(["repos", "--json"], environment: ["FAKE_KUNJ_RESPONSES": dir.path])
        #expect(repos.exit == 0)
        #expect(repos.stdout == #"{"repos":[]}"#)

        let file = try runFakeKunj(["ct", "file", "read", "feature/x", "src/a.ts", "--json"],
                                   environment: ["FAKE_KUNJ_RESPONSES": dir.path])
        #expect(file.stdout == #"{"content":"x"}"#)
    }

    @Test func missingFixtureIsAnErrorDocument() throws {
        let dir = try tempDirectory()
        let r = try runFakeKunj(["nope", "--json"], environment: ["FAKE_KUNJ_RESPONSES": dir.path])
        #expect(r.exit == 1)
        #expect(r.stdout.trimmingCharacters(in: .newlines)
            == #"{"error":{"code":"fixture-missing","message":"nope"}}"#)
    }

    @Test func versionComesFromTheEnvironmentOrVersionTxt() throws {
        let dir = try tempDirectory()
        try "1.3.2\n".write(to: dir.appendingPathComponent("version.txt"), atomically: true, encoding: .utf8)
        #expect(try runFakeKunj(["-V"], environment: ["FAKE_KUNJ_RESPONSES": dir.path]).stdout == "1.3.2\n")
        let over = try runFakeKunj(["-V"], environment: ["FAKE_KUNJ_RESPONSES": dir.path, "FAKE_KUNJ_VERSION": "1.2.0"])
        #expect(over.stdout == "1.2.0\n")
    }

    @Test func stdoutAndExitOverrides() throws {
        let r = try runFakeKunj(["repos", "--json"], environment: ["FAKE_KUNJ_STDOUT": "not json", "FAKE_KUNJ_EXIT": "3"])
        #expect(r.stdout == "not json")
        #expect(r.exit == 3)
    }

    @Test func logRecordsCwdAndArguments() throws {
        let dir = try tempDirectory()
        let log = dir.appendingPathComponent("calls.log")
        _ = try runFakeKunj(["worktree", "list", "feature/x", "--json"],
                            environment: ["FAKE_KUNJ_LOG": log.path, "FAKE_KUNJ_STDOUT": "{}"], cwd: dir)
        let line = try String(contentsOf: log, encoding: .utf8)
        // cwd is resolved (/private/var/... for a temp dir), so compare the tail
        #expect(line.hasSuffix("\(dir.lastPathComponent)\tworktree list feature/x --json\n"))
    }
}
