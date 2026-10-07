// Thin wrapper around the kunj CLI. Every call goes through `kunj ... --json`
// so the app never talks to git directly (same contract as the VS Code
// extension's kunjCli.ts).

import Foundation

struct KunjCLIError: LocalizedError {
    enum Code { case notFound, notARepo, commandFailed }
    let message: String
    let code: Code

    var errorDescription: String? { message }
}

// Apps launched from Finder or at login get a minimal PATH, and kunj is a
// `#!/usr/bin/env node` script, so both kunj and node have to be found on the
// user's shell PATH. Resolve it once from a login + interactive shell, which
// loads nvm, Homebrew and friends from .zprofile/.zshrc.
enum ShellEnvironment {
    static let path: String = resolvePath()

    private static func resolvePath() -> String {
        let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let marker = "__KUNJ_PATH__"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-l", "-i", "-c", "printf '\(marker)%s\(marker)' \"$PATH\""]
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return fallback
        }
        // A slow or hanging shell profile must not block the app forever
        let deadline = DispatchTime.now() + 5
        DispatchQueue.global().asyncAfter(deadline: deadline) {
            if process.isRunning { process.terminate() }
        }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        let parts = text.components(separatedBy: marker)
        guard parts.count >= 3, !parts[1].isEmpty else { return fallback }
        return parts[1] + ":" + fallback
    }
}

final class KunjCLI: @unchecked Sendable {
    // Configured command, e.g. "kunj" or "node /path/to/kunj/dist/index.js"
    var command: String
    let log: (String) -> Void

    init(command: String, log: @escaping (String) -> Void) {
        self.command = command
        self.log = log
    }

    private var commandParts: [String] {
        let trimmed = command.trimmingCharacters(in: .whitespaces)
        let parts = splitArguments(trimmed.isEmpty ? "kunj" : trimmed)
        return parts.isEmpty ? ["kunj"] : parts
    }

    // The command line `kunj` is run with, for scripts run in a terminal
    var shellCommand: String {
        commandParts.map(shellQuote).joined(separator: " ")
    }

    // Run `kunj <args> --json` in the given directory and decode the result.
    func run<T: Decodable>(_ args: [String], cwd: String, timeout: TimeInterval = 120) async throws -> T {
        let data = try await runRaw(args + ["--json"], cwd: cwd, timeout: timeout)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            log("  ! could not decode \(T.self): \(error)")
            throw KunjCLIError(message: "Unexpected output from kunj \(args.joined(separator: " "))", code: .commandFailed)
        }
    }

    private func runRaw(_ args: [String], cwd: String, timeout: TimeInterval) async throws -> Data {
        let parts = commandParts
        let fullArgs = Array(parts.dropFirst()) + args
        log("\(parts[0]) \(fullArgs.joined(separator: " "))  (cwd: \(cwd))")

        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                // env resolves the executable on the shell PATH we pass in
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = [parts[0]] + fullArgs
                process.currentDirectoryURL = URL(fileURLWithPath: cwd)
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = ShellEnvironment.path
                env["NO_COLOR"] = "1"
                env["FORCE_COLOR"] = "0"
                process.environment = env

                let stdoutPipe = Pipe()
                let stderrPipe = Pipe()
                process.standardOutput = stdoutPipe
                process.standardError = stderrPipe
                process.standardInput = FileHandle.nullDevice

                do {
                    try process.run()
                } catch {
                    continuation.resume(throwing: KunjCLIError(message: error.localizedDescription, code: .commandFailed))
                    return
                }

                var timedOut = false
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    if process.isRunning {
                        timedOut = true
                        process.terminate()
                    }
                }

                // Drain both pipes concurrently so a chatty stderr cannot block stdout
                var stderrData = Data()
                let group = DispatchGroup()
                group.enter()
                DispatchQueue.global().async {
                    stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                    group.leave()
                }
                let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                group.wait()
                process.waitUntilExit()

                let status = process.terminationStatus
                let stderr = String(decoding: stderrData, as: UTF8.self)
                let payload = Self.extractJSON(stdoutData)

                if status == 0, let payload {
                    continuation.resume(returning: payload)
                    return
                }

                if timedOut {
                    continuation.resume(throwing: KunjCLIError(message: "kunj timed out after \(Int(timeout))s", code: .commandFailed))
                    return
                }
                // env exits 127 when the command is not on PATH
                if status == 127 {
                    continuation.resume(throwing: KunjCLIError(
                        message: "kunj CLI not found (\(parts[0])). Install it with \"npm install -g kunj\" or set its path in Settings.",
                        code: .notFound))
                    return
                }

                var message = Self.lastLine(stderr) ?? Self.lastLine(String(decoding: stdoutData, as: UTF8.self)) ?? "kunj exited with code \(status)"
                if let payload,
                   let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                   let error = object["error"] as? String {
                    message = error
                }
                self.log("  ! \(message)")
                let notARepo = message.range(of: "not (a|in a) git repository", options: [.regularExpression, .caseInsensitive]) != nil
                continuation.resume(throwing: KunjCLIError(message: message, code: notARepo ? .notARepo : .commandFailed))
            }
        }
    }

    // The CLI may print non-JSON lines (e.g. a migration notice) before the payload
    private static func extractJSON(_ data: Data) -> Data? {
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if (try? JSONSerialization.jsonObject(with: Data(text.utf8))) != nil {
            return Data(text.utf8)
        }
        if let start = text.firstIndex(of: "{") {
            let slice = Data(text[start...].utf8)
            if (try? JSONSerialization.jsonObject(with: slice)) != nil { return slice }
        }
        return nil
    }

    private static func lastLine(_ text: String) -> String? {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
    }

    // ---- repositories -----------------------------------------------------

    func listRepos() async throws -> [KnownRepo] {
        let result: ReposResult = try await run(["repos"], cwd: NSHomeDirectory(), timeout: 30)
        return result.repos
    }

    func addRepo(path: String) async throws {
        let _: SuccessResult = try await run(["repos", "add", path], cwd: NSHomeDirectory(), timeout: 30)
    }

    func removeRepo(path: String) async throws {
        let _: SuccessResult = try await run(["repos", "remove", path], cwd: NSHomeDirectory(), timeout: 30)
    }

    // ---- worktrees ----------------------------------------------------------

    func listWorktrees(repo: String, includeStatus: Bool, includePullRequests: Bool, fresh: Bool) async throws -> WorktreeListResult {
        var args = ["worktree", "list"]
        if !includeStatus { args.append("--no-status") }
        if !includePullRequests { args.append("--no-pr") }
        if fresh { args.append("--fresh") }
        return try await run(args, cwd: repo)
    }

    func getPullRequest(repo: String, worktreePath: String) async throws -> PullRequest? {
        let result: PullRequestLookupResult = try await run(["worktree", "pr", worktreePath, "--fresh"], cwd: repo)
        return result.pullRequest
    }

    func addWorktree(repo: String, branch: String, path: String?, newBranch: Bool, base: String?, fromOrigin: Bool) async throws -> AddWorktreeResult {
        var args = ["worktree", "add", branch]
        if let path, !path.isEmpty { args.append(path) }
        if newBranch { args.append("--new-branch") }
        if let base, !base.isEmpty { args += ["--base", base] }
        if newBranch && !fromOrigin { args.append("--no-origin") }
        return try await run(args, cwd: repo, timeout: 300)
    }

    func removeWorktree(repo: String, worktreePath: String, force: Bool) async throws {
        var args = ["worktree", "remove", worktreePath]
        if force { args.append("--force") }
        let _: SuccessResult = try await run(args, cwd: repo, timeout: 300)
    }

    func pruneWorktrees(repo: String) async throws -> String {
        let result: PruneResult = try await run(["worktree", "prune"], cwd: repo)
        return result.output
    }

    func openWorktree(repo: String, worktreePath: String, newWindow: Bool) async throws {
        var args = ["worktree", "open", worktreePath]
        if newWindow { args.append("--new-window") }
        let result: SuccessResult = try await run(args, cwd: repo, timeout: 30)
        if !result.success {
            throw KunjCLIError(message: "No editor is configured (worktree.editorCommand is empty)", code: .commandFailed)
        }
    }

    func listBranches(repo: String) async throws -> [BranchListResult.Branch] {
        let result: BranchListResult = try await run(["list", "--all"], cwd: repo, timeout: 60)
        return result.branches
    }
}

// Split "node /path/to/index.js" style values, honouring double quotes
func splitArguments(_ text: String) -> [String] {
    var parts: [String] = []
    var current = ""
    var inQuotes = false
    for char in text {
        if char == "\"" {
            inQuotes.toggle()
        } else if char == " " && !inQuotes {
            if !current.isEmpty { parts.append(current); current = "" }
        } else {
            current.append(char)
        }
    }
    if !current.isEmpty { parts.append(current) }
    return parts
}

func shellQuote(_ text: String) -> String {
    if text.range(of: "^[A-Za-z0-9_./:@%+=-]+$", options: .regularExpression) != nil { return text }
    return "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
