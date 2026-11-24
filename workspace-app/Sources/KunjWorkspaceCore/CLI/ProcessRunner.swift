import Foundation

/// What a finished child process left behind.
struct ProcessOutput {
    let stdout: Data
    let stderr: Data
    let exit: Int32
    let timedOut: Bool
}

/// Runs `executable` with both pipes read as data arrives, `stdin` written and then closed (or
/// /dev/null), and the process terminated at `timeout` (SIGKILL 2 s later). After the process
/// exits, output still held open by a grandchild (a login shell's profile, a detached helper) is
/// waited for at most `drainGrace`, so such a child never blocks the caller.
/// Throws only when the process cannot be launched.
///
/// No thread waits on the child: the pipes are read by dispatch sources (`readabilityHandler`),
/// stdin is written by `DispatchIO` and the exit comes from `terminationHandler`. Blocking reads
/// and `waitUntilExit` held three GCD threads per child, close to GCD's 64 in a refresh burst.
func runProcess(
    executable: String, arguments: [String], cwd: String?, environment: [String: String],
    stdin: Data?, timeout: TimeInterval, drainGrace: TimeInterval = 2
) async throws -> ProcessOutput {
    ignoreSIGPIPE
    return try await withCheckedThrowingContinuation { continuation in
        let run = ProcessRun(continuation: continuation)
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

        // Read until EOF, which comes when the child and every grandchild holding the pipe are
        // done; after the result is out, a grandchild's output is still read (and dropped), so
        // it never blocks on a full pipe or dies of a closed one.
        for (handle, isOut) in [(out.fileHandleForReading, true), (err.fileHandleForReading, false)] {
            run.drained.enter()
            handle.readabilityHandler = { handle in
                let chunk = handle.availableData
                if chunk.isEmpty {
                    handle.readabilityHandler = nil
                    run.drained.leave()
                } else {
                    run.append(chunk, stdout: isOut)
                }
            }
        }

        let timedOut = TimeoutFlag()
        process.terminationHandler = { process in
            let status = process.terminationStatus
            let finish = { run.finish(exit: status, timedOut: timedOut.value) }
            run.drained.notify(queue: .global(), execute: finish)
            DispatchQueue.global().asyncAfter(deadline: .now() + drainGrace, execute: finish)
        }

        do {
            try process.run()
        } catch {
            for handle in [out.fileHandleForReading, err.fileHandleForReading] { handle.readabilityHandler = nil }
            run.fail(error)
            return
        }
        if let input, let stdin { writeAndClose(stdin, to: input) }

        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            guard process.isRunning else { return }
            timedOut.set()
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if process.isRunning { kill(pid, SIGKILL) }
            }
        }
    }
}

/// Writes `data` to the child's stdin without a waiting thread, then closes it. A child that exits
/// without reading gives EPIPE, which only ends the write.
private func writeAndClose(_ data: Data, to pipe: Pipe) {
    // DispatchIO owns its descriptor, so it gets a copy and the pipe's own is closed here
    // (Process already closed the parent's copy of the child's end)
    let fd = dup(pipe.fileHandleForWriting.fileDescriptor)
    try? pipe.fileHandleForWriting.close()
    guard fd >= 0 else { return }
    guard !data.isEmpty else { close(fd); return }
    let queue = DispatchQueue.global()
    let io = DispatchIO(type: .stream, fileDescriptor: fd, queue: queue, cleanupHandler: { _ in close(fd) })
    let bytes = data.withUnsafeBytes { DispatchData(bytes: $0) }
    io.write(offset: 0, data: bytes, queue: queue) { done, _, error in
        if done || error != 0 { io.close() }
    }
}

/// One run's output and its single resumption of the caller.
private final class ProcessRun: @unchecked Sendable {
    let drained = DispatchGroup()
    private let lock = NSLock()
    private var stdout = Data()
    private var stderr = Data()
    private var continuation: CheckedContinuation<ProcessOutput, Error>?

    init(continuation: CheckedContinuation<ProcessOutput, Error>) { self.continuation = continuation }

    func append(_ chunk: Data, stdout isOut: Bool) {
        lock.lock()
        if continuation != nil {
            if isOut { stdout.append(chunk) } else { stderr.append(chunk) }
        }
        lock.unlock()
    }

    /// Resumes the caller once; later calls (the grace timer after a drain) do nothing.
    func finish(exit: Int32, timedOut: Bool) {
        lock.lock()
        let c = continuation
        continuation = nil
        let result = ProcessOutput(stdout: stdout, stderr: stderr, exit: exit, timedOut: timedOut)
        if c != nil { stdout = Data(); stderr = Data() }
        lock.unlock()
        c?.resume(returning: result)
    }

    func fail(_ error: Error) {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(throwing: error)
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
