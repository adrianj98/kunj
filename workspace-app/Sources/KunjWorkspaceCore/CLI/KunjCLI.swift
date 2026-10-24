import Foundation

/// Why a kunj call failed. `notFound` and `tooOld` come from discovery and make the window show
/// one message with `npm install -g kunj`; `commandFailed` carries kunj's own error code when its
/// `--json` error document has one.
public struct KunjCLIError: Error, Equatable, CustomStringConvertible {
    public enum Code: String, Sendable {
        case notFound = "not-found", tooOld = "too-old", commandFailed = "command-failed", badJSON = "bad-json"
    }
    public let code: Code
    public let message: String
    public let kunjCode: String?

    public init(code: Code, message: String, kunjCode: String? = nil) {
        self.code = code
        self.message = message
        self.kunjCode = kunjCode
    }

    public var description: String { message }
}

/// The kunj discovery found: the program it runs and the version it reported.
public struct KunjStatus: Equatable, Sendable {
    public let binary: String
    public let version: String
    public let dev: Bool

    public init(binary: String, version: String, dev: Bool) {
        self.binary = binary
        self.version = version
        self.dev = dev
    }

    /// The status bar's text: `kunj 1.4.2`, or `kunj 1.0.0 dev`.
    public var label: String { "kunj \(version)" + (dev ? " dev" : "") }
}

/// A process to start in a PTY (terminal tabs): `/usr/bin/env <command parts…> <args…>`.
public struct SpawnSpec: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let cwd: String
    public let environment: [String: String]

    public init(executable: String, arguments: [String], cwd: String, environment: [String: String]) {
        self.executable = executable
        self.arguments = arguments
        self.cwd = cwd
        self.environment = environment
    }
}

/// Runs the installed kunj CLI, the app's only contract (`kunj … --json`). `command` is `kunj` or
/// a command line such as `node /path/dist/index.js` (split on spaces, double quotes honoured);
/// it is started through `/usr/bin/env` with `path` (the login shell's) as PATH.
public final class KunjCLI: @unchecked Sendable {
    public let command: String
    public let path: String

    public init(command: String, path: String) {
        self.command = command
        self.path = path
    }

    var commandParts: [String] {
        let parts = splitArguments(command)
        return parts.isEmpty ? ["kunj"] : parts
    }

    /// Runs `kunj -V` and checks the version. Throws `notFound` when the command is not on `path`
    /// (env exits 127), `tooOld` below `MIN_KUNJ_VERSION` (or for output that is not a version).
    public static func discover(command: String, path: String) async throws -> (KunjCLI, KunjStatus) {
        let cli = KunjCLI(command: command, path: path)
        let raw = try await cli.runRaw(["-V"], cwd: NSHomeDirectory(), stdin: nil, timeout: 30)
        let program = cli.commandParts[0]
        if raw.exit == 127 || raw.exit == 126 { throw cli.startFailure(stderr: raw.stderr) }
        let printed = lastLine(String(decoding: raw.stdout, as: UTF8.self)) ?? ""
        guard raw.exit == 0 else {
            throw KunjCLIError(code: .commandFailed,
                               message: lastLine(raw.stderr) ?? "\(program) -V exited with code \(raw.exit)")
        }
        let check = checkVersion(printed)
        guard check.ok else {
            let found = SemVer(printed).map { "kunj \($0)" } ?? "\(program) -V printed \"\(printed)\""
            throw KunjCLIError(code: .tooOld,
                               message: "\(found) is older than \(MIN_KUNJ_VERSION): npm install -g kunj")
        }
        let version = SemVer(printed)!.description
        return (cli, KunjStatus(binary: cli.resolvedBinary(), version: version, dev: check.dev))
    }

    /// Runs `kunj <args> --json` in `cwd` (the repository root) and decodes stdout. Notices printed
    /// before the document are skipped (from the first `{`). A `{"error": …}` document, or a
    /// failing exit without one, is `commandFailed`; other non-JSON or mis-shaped output `badJSON`.
    public func run<T: Decodable>(
        _ args: [String], cwd: String, stdin: Data? = nil, timeout: TimeInterval = 120
    ) async throws -> T {
        let raw = try await runRaw(args + ["--json"], cwd: cwd, stdin: stdin, timeout: timeout)
        if raw.exit == 127 { throw startFailure(stderr: raw.stderr) }
        let payload = Self.extractJSON(raw.stdout)
        if let payload, let error = Self.errorDocument(payload) {
            throw error
        }
        guard raw.exit == 0 else {
            throw KunjCLIError(code: .commandFailed,
                               message: lastLine(raw.stderr) ?? "kunj \(args.joined(separator: " ")) exited with code \(raw.exit)")
        }
        guard let payload else {
            throw KunjCLIError(code: .badJSON, message: "kunj \(args.joined(separator: " ")) did not print JSON")
        }
        do {
            return try JSONDecoder().decode(T.self, from: payload)
        } catch {
            throw KunjCLIError(code: .badJSON,
                               message: "Unexpected output from kunj \(args.joined(separator: " ")): \(error)")
        }
    }

    /// Runs `kunj <args>` as given (no `--json` added): stdout and stderr are read on background
    /// threads, `stdin` is written and closed, and the process is killed at `timeout`
    /// (`commandFailed`, "timed out").
    public func runRaw(
        _ args: [String], cwd: String, stdin: Data?, timeout: TimeInterval
    ) async throws -> (stdout: Data, stderr: String, exit: Int32) {
        let spec = spawnSpec(args, cwd: cwd)
        let output: ProcessOutput
        do {
            output = try await runProcess(executable: spec.executable, arguments: spec.arguments, cwd: cwd,
                                          environment: spec.environment, stdin: stdin, timeout: timeout)
        } catch {
            throw KunjCLIError(code: .commandFailed, message: "Could not start \(commandParts[0]): \(error.localizedDescription)")
        }
        if output.timedOut {
            throw KunjCLIError(code: .commandFailed,
                               message: "kunj \(args.joined(separator: " ")) timed out after \(Int(timeout.rounded(.up)))s")
        }
        return (output.stdout, String(decoding: output.stderr, as: UTF8.self), output.exit)
    }

    /// How a terminal tab starts `kunj <args>`: through env, with the login PATH and the
    /// terminal environment (Global Constraints).
    public func spawnSpec(_ args: [String], cwd: String) -> SpawnSpec {
        SpawnSpec(executable: "/usr/bin/env", arguments: commandParts + args, cwd: cwd,
                  environment: ShellEnvironment.terminalEnvironment(path: path))
    }

    /// env exited 126/127. It is `notFound` when env could not run the command itself
    /// (`env: kunj: No such file or directory`); otherwise kunj was found but what its `#!` names
    /// was not (`env: node: …`, nvm not loaded by the login shell), and installing kunj would not help.
    func startFailure(stderr: String) -> KunjCLIError {
        let program = commandParts[0]
        guard let line = lastLine(stderr), line.hasPrefix("env: "), !line.hasPrefix("env: \(program):") else {
            return KunjCLIError(code: .notFound, message: "kunj not found on your PATH: npm install -g kunj")
        }
        return KunjCLIError(code: .commandFailed, message: "kunj could not start: \(line)")
    }

    /// The program on `path` (or as given when it has a `/`), with any further command parts.
    func resolvedBinary() -> String {
        var parts = commandParts
        let program = parts.removeFirst()
        var resolved = program
        if !program.contains("/") {
            for dir in path.split(separator: ":") {
                let candidate = "\(dir)/\(program)"
                if FileManager.default.isExecutableFile(atPath: candidate) { resolved = candidate; break }
            }
        }
        return ([resolved] + parts).joined(separator: " ")
    }

    // MARK: output parsing

    static func extractJSON(_ data: Data) -> Data? {
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let whole = Data(text.utf8)
        if (try? JSONSerialization.jsonObject(with: whole)) != nil { return whole }
        if let start = text.firstIndex(of: "{") {
            let slice = Data(text[start...].utf8)
            if (try? JSONSerialization.jsonObject(with: slice)) != nil { return slice }
        }
        return nil
    }

    /// kunj's `--json` error shapes: `{ "error": "msg" }` or `{ "error": { code, message } }`.
    static func errorDocument(_ payload: Data) -> KunjCLIError? {
        guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let error = object["error"] else { return nil }
        if let message = error as? String {
            return KunjCLIError(code: .commandFailed, message: message)
        }
        if let e = error as? [String: Any], let message = e["message"] as? String {
            return KunjCLIError(code: .commandFailed, message: message, kunjCode: e["code"] as? String)
        }
        return nil
    }
}

private func lastLine(_ text: String) -> String? {
    text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
}

/// Splits a command line such as `node "/path with space/index.js"` on spaces, honouring double
/// quotes (as macos-app's `splitArguments`).
public func splitArguments(_ text: String) -> [String] {
    var parts: [String] = []
    var current = ""
    var inQuotes = false
    var quoted = false
    for char in text {
        if char == "\"" {
            inQuotes.toggle()
            quoted = true
        } else if char == " " && !inQuotes {
            if !current.isEmpty || quoted { parts.append(current) }
            current = ""
            quoted = false
        } else {
            current.append(char)
        }
    }
    if !current.isEmpty || quoted { parts.append(current) }
    return parts
}
