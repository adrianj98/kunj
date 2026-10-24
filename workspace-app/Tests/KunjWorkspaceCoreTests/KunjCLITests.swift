import Foundation
import Testing
@testable import KunjWorkspaceCore

private struct Repos: Decodable { let repos: [String] }

/// A responses directory holding `files` (name → contents), for tests that must not depend on
/// the shared fixtures other tasks add.
private func responses(_ files: [String: String]) throws -> URL {
    let dir = try tempDirectory()
    for (name, body) in files {
        try body.write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }
    return dir
}

private func realPath(_ url: URL) -> String {
    guard let p = realpath(url.path, nil) else { return url.path }
    defer { free(p) }
    return String(cString: p)
}

private func code(of body: () async throws -> Void) async -> KunjCLIError? {
    do { try await body(); return nil } catch let e as KunjCLIError { return e } catch { return nil }
}

@Suite struct KunjCLITests {
    @Test func discoverReadsVersion() async throws {
        // responses/version.txt says 1.3.2
        let (cli, status) = try await KunjCLI.discover(command: fakeKunjCommand(), path: "/usr/bin:/bin")
        #expect(status.version == "1.3.2")
        #expect(status.dev == false)
        #expect(status.binary == fakeKunjPath)
        #expect(cli.path == "/usr/bin:/bin")
    }

    @Test func discoverDevBuild() async throws {
        let (_, status) = try await KunjCLI.discover(
            command: fakeKunjCommand(environment: ["FAKE_KUNJ_VERSION": "1.0.0"]), path: "/usr/bin:/bin")
        #expect(status.version == "1.0.0")
        #expect(status.dev == true)
    }

    @Test func discoverNotFound() async throws {
        let empty = try tempDirectory()
        let e = await code { _ = try await KunjCLI.discover(command: "kunj", path: empty.path) }
        #expect(e?.code == .notFound)
        #expect(e?.message.contains("npm install -g kunj") == true)
    }

    @Test func discoverNotFoundForAMissingAbsolutePath() async throws {
        let e = await code { _ = try await KunjCLI.discover(command: "/nonexistent/kunj", path: "/usr/bin:/bin") }
        #expect(e?.code == .notFound)
    }

    @Test func discoverNamesAMissingInterpreter() async throws {
        // kunj is installed but its `#!/usr/bin/env node` finds no node on the login PATH (nvm
        // not loaded): env exits 127 too, but "install kunj" would be the wrong advice.
        let dir = try tempDirectory()
        let script = dir.appendingPathComponent("kunj")
        try "#!/usr/bin/env kunj-test-missing-node\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let e = await code { _ = try await KunjCLI.discover(command: "kunj", path: dir.path + ":/usr/bin:/bin") }
        #expect(e?.code == .commandFailed)
        #expect(e?.message.contains("kunj-test-missing-node") == true)
        #expect(e?.message.contains("npm install -g kunj") == false)
    }

    @Test func discoverTooOld() async throws {
        let e = await code {
            _ = try await KunjCLI.discover(
                command: fakeKunjCommand(environment: ["FAKE_KUNJ_VERSION": "1.2.0"]), path: "/usr/bin:/bin")
        }
        #expect(e?.code == .tooOld)
        #expect(e?.message.contains("1.2.0") == true)
        #expect(e?.message.contains("npm install -g kunj") == true)
    }

    @Test func runDecodesAndAppendsJson() async throws {
        let dir = try responses(["repos.json": #"{"repos":["a","b"]}"#])
        let log = try tempDirectory().appendingPathComponent("log")
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path, "FAKE_KUNJ_LOG": log.path])
        let cwd = try tempDirectory()
        let r: Repos = try await cli.run(["repos"], cwd: cwd.path)
        #expect(r.repos == ["a", "b"])
        let line = try String(contentsOf: log, encoding: .utf8).trimmingCharacters(in: .newlines)
        #expect(line == realPath(cwd) + "\trepos --json")
    }

    @Test func runSkipsANoticeBeforeTheJson() async throws {
        // (a value with double quotes cannot go through the command string: a file it is)
        let dir = try responses(["repos.json": "Migrated ~/.kunj\n{\"repos\":[\"x\"]}"])
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path])
        let r: Repos = try await cli.run(["repos"], cwd: NSTemporaryDirectory())
        #expect(r.repos == ["x"])
    }

    @Test func runTurnsErrorDocumentIntoCommandFailed() async throws {
        let dir = try responses([:])
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path])
        let e = await code { let _: Repos = try await cli.run(["nope"], cwd: NSTemporaryDirectory()) }
        #expect(e?.code == .commandFailed)
        #expect(e?.kunjCode == "fixture-missing")
        #expect(e?.message == "nope")
    }

    @Test func runReadsAStringErrorDocument() async throws {
        let dir = try responses(["repos.json": #"{"error":"Not a git repository"}"#])
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path, "FAKE_KUNJ_EXIT": "1"])
        let e = await code { let _: Repos = try await cli.run(["repos"], cwd: NSTemporaryDirectory()) }
        #expect(e?.code == .commandFailed)
        #expect(e?.kunjCode == nil)
        #expect(e?.message == "Not a git repository")
    }

    @Test func runRejectsNonJson() async throws {
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_STDOUT": "not json"])
        let e = await code { let _: Repos = try await cli.run(["repos"], cwd: NSTemporaryDirectory()) }
        #expect(e?.code == .badJSON)
    }

    @Test func runRejectsJsonOfTheWrongShape() async throws {
        let dir = try responses(["repos.json": #"{"worktrees":[]}"#])
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_RESPONSES": dir.path])
        let e = await code { let _: Repos = try await cli.run(["repos"], cwd: NSTemporaryDirectory()) }
        #expect(e?.code == .badJSON)
    }

    @Test func runFailsWithoutJsonOnAnExitCode() async throws {
        let cli = fakeKunjCLI(environment: ["FAKE_KUNJ_STDOUT": "", "FAKE_KUNJ_EXIT": "3"])
        let e = await code { let _: Repos = try await cli.run(["repos"], cwd: NSTemporaryDirectory()) }
        #expect(e?.code == .commandFailed)
    }

    @Test func runRawPassesStdinAndReturnsExit() async throws {
        // `env cat` stands in for kunj: whatever goes to stdin comes back on stdout
        let cli = KunjCLI(command: "cat", path: "/usr/bin:/bin")
        let r = try await cli.runRaw([], cwd: NSTemporaryDirectory(), stdin: Data("hello".utf8), timeout: 10)
        #expect(String(decoding: r.stdout, as: UTF8.self) == "hello")
        #expect(r.exit == 0)
    }

    @Test func runRawCollectsStderr() async throws {
        let cli = KunjCLI(command: "sh -c \"echo oops >&2; exit 4\"", path: "/usr/bin:/bin")
        let r = try await cli.runRaw([], cwd: NSTemporaryDirectory(), stdin: nil, timeout: 10)
        #expect(r.stderr == "oops\n")
        #expect(r.exit == 4)
    }

    @Test func runRawKillsAtTimeout() async throws {
        let cli = KunjCLI(command: "sleep", path: "/usr/bin:/bin")
        let start = Date()
        let e = await code { _ = try await cli.runRaw(["30"], cwd: NSTemporaryDirectory(), stdin: nil, timeout: 0.5) }
        #expect(e?.code == .commandFailed)
        #expect(e?.message.contains("timed out") == true)
        #expect(Date().timeIntervalSince(start) < 10)
    }

    @Test func spawnSpecCarriesPathAndCwd() {
        let cli = KunjCLI(command: "kunj", path: "/opt/x/bin:/usr/bin")
        let spec = cli.spawnSpec(["agent", "start", "feature/x"], cwd: "/repo")
        #expect(spec.executable == "/usr/bin/env")
        #expect(spec.arguments == ["kunj", "agent", "start", "feature/x"])
        #expect(spec.arguments.first == "kunj")
        #expect(spec.cwd == "/repo")
        #expect(spec.environment["PATH"] == "/opt/x/bin:/usr/bin")
        #expect(spec.environment["TERM"] == "xterm-256color")
    }

    @Test func commandWithQuotedPath() {
        let cli = KunjCLI(command: #"node "/Users/me/my kunj/dist/index.js""#, path: "/usr/bin")
        let spec = cli.spawnSpec(["-V"], cwd: "/")
        #expect(spec.arguments == ["node", "/Users/me/my kunj/dist/index.js", "-V"])
    }

    @Test func splitArgumentsRules() {
        #expect(splitArguments("  kunj  ") == ["kunj"])
        #expect(splitArguments(#"a "b c" d"#) == ["a", "b c", "d"])
        #expect(splitArguments("") == [])
    }
}

@Suite struct ShellEnvironmentTests {
    @Test func terminalEnvironmentDropsMarkers() {
        let base = [
            "HOME": "/Users/me", "LANG": "fr_FR.UTF-8", "PATH": "/usr/bin",
            "NO_COLOR": "1", "FORCE_COLOR": "1", "TERM_PROGRAM": "vscode", "TERM_PROGRAM_VERSION": "1",
            "TERM_SESSION_ID": "x", "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "TERM": "dumb",
        ]
        let env = ShellEnvironment.terminalEnvironment(path: "/login/bin", base: base)
        #expect(env["PATH"] == "/login/bin")
        #expect(env["TERM"] == "xterm-256color")
        #expect(env["COLORTERM"] == "truecolor")
        #expect(env["LANG"] == "fr_FR.UTF-8")
        #expect(env["HOME"] == "/Users/me")
        for k in ["NO_COLOR", "FORCE_COLOR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID",
                  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] {
            #expect(env[k] == nil, "\(k) should be removed")
        }
    }

    @Test func terminalEnvironmentDefaultsLang() {
        let env = ShellEnvironment.terminalEnvironment(path: "/p", base: [:])
        #expect(env["LANG"] == "en_US.UTF-8")
    }

    @Test func loginPathIncludesFallback() async {
        let path = await ShellEnvironment.loginPath(timeout: 10)
        #expect(path.hasSuffix(ShellEnvironment.fallbackPath))
        #expect(path.split(separator: ":").contains("/usr/bin"))
    }

    @Test func loginPathFallsBackWhenTheShellHangs() async throws {
        // A "shell" whose profile never finishes
        let shell = try tempDirectory().appendingPathComponent("hang")
        try "#!/bin/sh\nsleep 30\n".write(to: shell, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: shell.path)
        let start = Date()
        let path = await ShellEnvironment.loginPath(timeout: 0.5, shell: shell.path)
        #expect(path == ShellEnvironment.fallbackPath)
        #expect(Date().timeIntervalSince(start) < 5)
    }

    @Test func loginPathRetriesWithoutInteractiveWhenItTimesOut() async throws {
        // A .zshrc that blocks (e.g. on a privacy prompt) hangs only the interactive shell
        let shell = try tempDirectory().appendingPathComponent("zsh")
        let script = """
            #!/bin/sh
            for a in "$@"; do [ "$a" = "-i" ] && sleep 30; done
            PATH=/login/only/bin
            eval "$3"
            """
        try script.write(to: shell, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: shell.path)
        let result = await ShellEnvironment.resolveLoginPath(timeout: 0.5, shell: shell.path)
        #expect(result.timedOut)
        #expect(result.path == "/login/only/bin:" + ShellEnvironment.fallbackPath)
    }

    @Test func notFoundAfterALoginShellTimeoutSaysSo() throws {
        let error = KunjCLIError(code: .notFound, message: "kunj not found on your PATH: npm install -g kunj")
        let timedOut = ShellEnvironment.LoginPath(path: "/usr/bin", timedOut: true)
        let detail = try #require(discoveryErrorDetail(error, loginPath: timedOut))
        #expect(detail.contains("login shell"))
        #expect(detail.contains("/usr/bin"))
        #expect(detail.contains("Settings"))
        // in time, or another error: no extra line
        #expect(discoveryErrorDetail(error, loginPath: .init(path: "/usr/bin", timedOut: false)) == nil)
        #expect(discoveryErrorDetail(KunjCLIError(code: .tooOld, message: "old"), loginPath: timedOut) == nil)
    }
}
