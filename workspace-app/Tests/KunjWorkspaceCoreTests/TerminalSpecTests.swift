import Foundation
import Testing
@testable import KunjWorkspaceCore

private let cli = KunjCLI(command: "kunj", path: "/login/bin:/usr/bin:/bin")
private let baseEnv = ["HOME": "/Users/demo", "LANG": "de_DE.UTF-8", "USER": "demo"]

private func spec(_ env: Environment, _ kind: TabKind, action: [String] = [], cwd: String? = nil,
                  cli: KunjCLI = cli, terminalEnv: [String: String] = baseEnv) throws -> TerminalSpec {
    try terminalSpec(cli: cli, env: env, kind: kind, action: action, shell: "/bin/zsh", terminalEnv: terminalEnv,
                     cwd: cwd)
}

@Suite struct TerminalSpecTests {
    @Test func worktreeShell() throws {
        let s = try spec(testWorktree(), .shell)
        #expect(s.executable == "/bin/zsh")
        #expect(s.arguments == ["-l"])
        #expect(s.cwd == "/w/feat")
        #expect(s.environment["TERM"] == "xterm-256color")
        #expect(s.environment["COLORTERM"] == "truecolor")
        #expect(s.environment["PATH"] == "/login/bin:/usr/bin:/bin")
        #expect(s.title == "zsh")
        #expect(!s.closeOnExitZero)
    }

    @Test func worktreeAgent() throws {
        let s = try spec(testWorktree(), .agent)
        #expect(s.executable == "/usr/bin/env")
        #expect(s.arguments == ["kunj", "agent", "feature/x"])
        #expect(s.cwd == "/r/app")
        #expect(s.title == "agent")
        #expect(!s.closeOnExitZero)
    }

    @Test func kunjCommandPartsAreKept() throws {
        let node = KunjCLI(command: "node /src/kunj/dist/index.js", path: "/usr/bin")
        let s = try spec(testWorktree(), .agent, cli: node)
        #expect(s.arguments == ["node", "/src/kunj/dist/index.js", "agent", "feature/x"])
    }

    @Test func containerShellAndAgent() throws {
        let shell = try spec(testContainer(), .shell)
        #expect(shell.executable == "/usr/bin/env")
        #expect(shell.arguments == ["kunj", "ct", "shell", "feature/x"])
        #expect(shell.cwd == "/r/app")
        #expect(shell.title == "shell")
        let agent = try spec(testContainer(), .agent)
        #expect(agent.arguments == ["kunj", "ct", "agent", "feature/x"])
        #expect(agent.title == "agent")
    }

    @Test func actionTab() throws {
        let s = try spec(testContainer(running: false), .action, action: ["ct", "start", "feature/x"])
        #expect(s.arguments == ["kunj", "ct", "start", "feature/x"])
        #expect(s.cwd == "/r/app")
        #expect(s.closeOnExitZero)
        #expect(s.title == "ct start")
    }

    @Test func prActionStaysOpenAndTakesItsCwd() throws {
        let s = try spec(testWorktree(), .action, action: ["pr"], cwd: "/w/feat")
        #expect(s.arguments == ["kunj", "pr"])
        #expect(s.cwd == "/w/feat")
        #expect(!s.closeOnExitZero)
        #expect(s.title == "pr")
    }

    @Test func actionsRunOnAMissingWorktree() throws {
        let s = try spec(testWorktree(exists: false), .action, action: ["worktree", "prune"])
        #expect(s.arguments == ["kunj", "worktree", "prune"])
    }

    @Test func missingWorktreeRefused() {
        #expect(throws: TerminalSpecError.worktreeMissing) { try spec(testWorktree(exists: false), .shell) }
        #expect(throws: TerminalSpecError.worktreeMissing) { try spec(testWorktree(exists: false), .agent) }
    }

    @Test func stoppedContainerRefused() {
        #expect(throws: TerminalSpecError.containerStopped("feature/x")) {
            try spec(testContainer(running: false), .shell)
        }
        #expect(throws: TerminalSpecError.containerStopped("feature/x")) {
            try spec(testContainer(running: false), .agent)
        }
    }

    @Test func worktreeWithoutPathOrEditorKindRefused() {
        #expect(throws: TerminalSpecError.noWorktree) { try spec(testWorktree(path: nil), .shell) }
        #expect(throws: TerminalSpecError.noWorktree) { try spec(testWorktree(), .editor) }
        #expect(throws: TerminalSpecError.noWorktree) { try spec(testWorktree(), .action, action: []) }
    }

    @Test func environmentIsCleaned() throws {
        var dirty = baseEnv
        dirty["NO_COLOR"] = "1"
        dirty["FORCE_COLOR"] = "1"
        dirty["CLAUDECODE"] = "1"
        dirty["CLAUDE_CODE_ENTRYPOINT"] = "cli"
        dirty["TERM_PROGRAM"] = "vscode"
        dirty["TERM_SESSION_ID"] = "x"
        for s in [try spec(testWorktree(), .shell, terminalEnv: dirty),
                  try spec(testContainer(), .agent, terminalEnv: dirty)] {
            for key in ["NO_COLOR", "FORCE_COLOR", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TERM_PROGRAM", "TERM_SESSION_ID"] {
                #expect(s.environment[key] == nil, "\(key)")
            }
            #expect(s.environment["LANG"] == "de_DE.UTF-8")
            #expect(s.environment["HOME"] == "/Users/demo")
        }
        var noLang = baseEnv
        noLang["LANG"] = nil
        #expect(try spec(testWorktree(), .shell, terminalEnv: noLang).environment["LANG"] == "en_US.UTF-8")
    }

    @Test func tabKindRawValues() {
        #expect(TabKind.allCases.map(\.rawValue) == ["shell", "agent", "action", "editor"])
    }
}
