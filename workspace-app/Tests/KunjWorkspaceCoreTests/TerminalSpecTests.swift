import Foundation
import Testing
@testable import KunjWorkspaceCore

private let cli = KunjCLI(command: "kunj", path: "/login/bin:/usr/bin:/bin")
private let baseEnv = ["HOME": "/Users/demo", "LANG": "de_DE.UTF-8", "USER": "demo"]

private func spec(_ env: Environment, _ kind: TabKind, action: [String] = [], cwd: String? = nil,
                  cli: KunjCLI = cli, terminalEnv: [String: String] = baseEnv, session: String? = nil,
                  agent: AgentChoice? = nil) throws -> TerminalSpec {
    try terminalSpec(cli: cli, env: env, kind: kind, action: action, shell: "/bin/zsh", terminalEnv: terminalEnv,
                     cwd: cwd, session: session, agent: agent)
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

    /// A shell tab with a session runs in a tmux session kunj names (when tmux is there), so it is
    /// reattached after the app quits; closing the tab ends it with --kill
    @Test func shellSessionsGoThroughKunj() throws {
        let wt = try spec(testWorktree(), .shell, session: "a1b2c3d4")
        #expect(wt.executable == "/usr/bin/env")
        #expect(wt.arguments == ["kunj", "worktree", "shell", "feature/x", "--session", "a1b2c3d4"])
        #expect(wt.cwd == "/r/app")
        #expect(wt.title == "zsh")
        #expect(wt.session == "a1b2c3d4")
        let ct = try spec(testContainer(), .shell, session: "a1b2c3d4")
        #expect(ct.arguments == ["kunj", "ct", "shell", "feature/x", "--session", "a1b2c3d4"])
        #expect(ct.title == "shell")
        #expect(sessionKillArguments(env: testWorktree(), kind: .shell, session: "a1b2c3d4")
                == ["worktree", "shell", "feature/x", "--session", "a1b2c3d4", "--kill"])
        #expect(sessionKillArguments(env: testContainer(), kind: .shell, session: "a1b2c3d4")
                == ["ct", "shell", "feature/x", "--session", "a1b2c3d4", "--kill"])
        #expect(try spec(testWorktree(), .shell).session == nil)
        let id = newTabSession()
        #expect(id.count == 8 && id.allSatisfy { $0.isHexDigit } && id != newTabSession())
    }

    /// An Antigravity tab is `kunj agent --agent antigravity`, titled after it; containers refuse it
    @Test func antigravityAgent() throws {
        let s = try spec(testWorktree(), .agent, session: "a1", agent: .antigravity)
        #expect(s.arguments == ["kunj", "agent", "feature/x", "--session", "a1", "--agent", "antigravity"])
        #expect(s.title == "antigravity")
        #expect(s.agent == "antigravity")
        #expect(try spec(testWorktree(), .agent).agent == nil)
        #expect(throws: TerminalSpecError.agentNotInContainer) {
            _ = try spec(testContainer(), .agent, agent: .antigravity)
        }
    }

    /// Each agent tab has its own session, so an environment can run many agents; an agent tab
    /// restored from before sessions (no id) attaches to the default one
    @Test func agentSessions() throws {
        #expect(try spec(testWorktree(), .agent, session: "a1").arguments == ["kunj", "agent", "feature/x", "--session", "a1"])
        #expect(try spec(testWorktree(), .agent, session: "a1").session == "a1")
        #expect(try spec(testContainer(), .agent, session: "a1").arguments == ["kunj", "ct", "agent", "feature/x", "--session", "a1"])
        #expect(try spec(testWorktree(), .agent).arguments == ["kunj", "agent", "feature/x"])
        #expect(sessionKillArguments(env: testWorktree(), kind: .agent, session: "a1")
                == ["agent", "stop", "feature/x", "--session", "a1"])
        #expect(sessionKillArguments(env: testContainer(), kind: .agent, session: "a1")
                == ["ct", "agent", "feature/x", "--kill", "--session", "a1"])
        // closing the environment ends every shell and agent session of the branch
        #expect(closeEnvironmentArguments(env: testWorktree())
                == [["worktree", "shell", "feature/x", "--kill"], ["agent", "stop", "feature/x", "--all"]])
        #expect(closeEnvironmentArguments(env: testContainer())
                == [["ct", "shell", "feature/x", "--kill"], ["ct", "agent", "feature/x", "--kill"]])
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

    @Test func tabDots() {
        #expect(tabDot(kind: .agent, running: true, agent: .running) == .green)
        #expect(tabDot(kind: .agent, running: true, agent: .unknown) == .green)
        #expect(tabDot(kind: .agent, running: true, agent: .waiting) == .amber)
        #expect(tabDot(kind: .agent, running: false, agent: .waiting) == nil)
        #expect(tabDot(kind: .action, running: true, agent: .none) == .green)
        #expect(tabDot(kind: .action, running: false, agent: .none) == nil)
        #expect(tabDot(kind: .shell, running: true, agent: .waiting) == nil)
        #expect(tabDot(kind: .editor, running: true, agent: .running) == nil)
    }

    /// SwiftTerm reports waitpid's raw status, not the exit code: `exit 1` arrives as 256.
    @Test func exitCodesFromWaitStatus() {
        #expect(exitCode(waitStatus: 0) == 0)
        #expect(exitCode(waitStatus: 1 << 8) == 1)
        #expect(exitCode(waitStatus: 127 << 8) == 127)
        #expect(exitCode(waitStatus: SIGKILL) == 128 + SIGKILL)
        #expect(exitCode(waitStatus: SIGHUP | 0x80) == 128 + SIGHUP) // core dumped
    }
}

@Suite struct ResumeAndQuitTests {
    @Test func aRestoredWorktreeAgentAsksToResume() throws {
        let s = try terminalSpec(cli: cli, env: testWorktree(), kind: .agent, shell: "/bin/zsh", terminalEnv: baseEnv,
                                 session: "ab12cd34", resume: true)
        #expect(s.arguments == ["kunj", "agent", "feature/x", "--session", "ab12cd34", "--resume"])
        let shell = try terminalSpec(cli: cli, env: testWorktree(), kind: .shell, shell: "/bin/zsh", terminalEnv: baseEnv,
                                     session: "ab12cd34", resume: true)
        #expect(!shell.arguments.contains("--resume"))
    }

    @Test func theQuitPromptCountsWhatRunsAndTheSecondsLeft() {
        #expect(QuitSessionsChoice.message(shells: 2, agents: 1) == "Leave 1 agent and 2 shells running?")
        #expect(QuitSessionsChoice.message(shells: 1, agents: 0) == "Leave 1 shell running?")
        #expect(QuitSessionsChoice.detail(secondsLeft: 20).hasSuffix("Leaving them running in 20 s."))
        #expect(QuitSessionsChoice.timeout == 20)
    }
}
