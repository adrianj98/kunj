import Foundation

/// What a finished child process left behind.
struct ProcessOutput {
    let stdout: Data
    let stderr: Data
    let exit: Int32
    let timedOut: Bool
}

/// Runs `executable` with both pipes drained on background threads, `stdin` written and then
/// closed (or /dev/null), and the process terminated at `timeout` (SIGKILL 2 s later). After the
/// process exits, output still held open by a grandchild (a login shell's profile, a detached
/// helper) is waited for at most `drainGrace`, so such a child never blocks the caller.
/// Throws only when the process cannot be launched.
func runProcess(
    executable: String, arguments: [String], cwd: String?, environment: [String: String],
    stdin: Data?, timeout: TimeInterval, drainGrace: TimeInterval = 2
) async throws -> ProcessOutput {
    ignoreSIGPIPE
    return try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
            process.environment = environment
            let out = Pipe()
            let err = Pipe()
            let input = stdin.map { _ in Pipe() }
            process.standardOutput = out
            process.standardError = err
            process.standardInput = input ?? FileHandle.nullDevice

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
                return
            }

            let lock = NSLock()
            var outData = Data()
            var errData = Data()
            let drained = DispatchGroup()
            for (handle, isOut) in [(out.fileHandleForReading, true), (err.fileHandleForReading, false)] {
                drained.enter()
                DispatchQueue.global().async {
                    while true {
                        let chunk = handle.availableData
                        if chunk.isEmpty { break }
                        lock.lock()
                        if isOut { outData.append(chunk) } else { errData.append(chunk) }
                        lock.unlock()
                    }
                    drained.leave()
                }
            }
            if let input, let stdin {
                DispatchQueue.global().async {
                    // A child that exits without reading gives EPIPE, which only ends the write
                    try? input.fileHandleForWriting.write(contentsOf: stdin)
                    try? input.fileHandleForWriting.close()
                }
            }

            let timedOut = TimeoutFlag()
            let pid = process.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                guard process.isRunning else { return }
                timedOut.set()
                process.terminate()
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                    if process.isRunning { kill(pid, SIGKILL) }
                }
            }

            process.waitUntilExit()
            _ = drained.wait(timeout: .now() + drainGrace)
            lock.lock()
            let result = ProcessOutput(stdout: outData, stderr: errData, exit: process.terminationStatus,
                                       timedOut: timedOut.value)
            lock.unlock()
            continuation.resume(returning: result)
        }
    }
}

private final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.lock(); flag = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}

/// Writing to a child that has exited raises SIGPIPE, which would kill the app.
private let ignoreSIGPIPE: Void = { signal(SIGPIPE, SIG_IGN) }()
