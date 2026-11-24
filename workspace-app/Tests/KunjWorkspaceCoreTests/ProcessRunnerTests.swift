import Foundation
import Testing
@testable import KunjWorkspaceCore

@Suite struct ProcessRunnerTests {
    private func sh(_ script: String, stdin: Data? = nil, timeout: TimeInterval = 10,
                    drainGrace: TimeInterval = 2) async throws -> ProcessOutput {
        try await runProcess(executable: "/bin/sh", arguments: ["-c", script], cwd: nil,
                             environment: ["PATH": "/usr/bin:/bin"], stdin: stdin, timeout: timeout,
                             drainGrace: drainGrace)
    }

    @Test func collectsBothStreamsAndTheExitCode() async throws {
        let r = try await sh("echo out; echo err >&2; exit 3")
        #expect(String(decoding: r.stdout, as: UTF8.self) == "out\n")
        #expect(String(decoding: r.stderr, as: UTF8.self) == "err\n")
        #expect(r.exit == 3)
        #expect(!r.timedOut)
    }

    @Test func keepsTheWholeOutputUpToTheExit() async throws {
        // 2 MB, far more than a pipe holds, written right before the exit
        let r = try await sh("head -c 2097152 /dev/zero | tr '\\0' x; printf END")
        #expect(r.stdout.count == 2_097_152 + 3)
        #expect(r.stdout.suffix(3) == Data("END".utf8))
    }

    @Test func writesStdinAndClosesIt() async throws {
        let input = Data(repeating: UInt8(ascii: "a"), count: 1_000_000)
        let r = try await sh("wc -c | tr -d ' '", stdin: input)
        #expect(String(decoding: r.stdout, as: UTF8.self) == "1000000\n")
        let empty = try await sh("cat; echo done", stdin: Data())
        #expect(String(decoding: empty.stdout, as: UTF8.self) == "done\n")
    }

    @Test func aChildThatReadsNoStdinStillFinishes() async throws {
        let r = try await sh("exit 0", stdin: Data(repeating: 0, count: 4_000_000))
        #expect(r.exit == 0)
    }

    @Test func terminatesAtTheTimeout() async throws {
        let start = Date()
        let r = try await sh("sleep 30", timeout: 0.3)
        #expect(r.timedOut)
        #expect(Date().timeIntervalSince(start) < 5)
    }

    @Test func doesNotWaitForAGrandchildHoldingThePipe() async throws {
        let start = Date()
        let r = try await sh("echo before; sleep 3 & echo after", drainGrace: 0.3)
        #expect(Date().timeIntervalSince(start) < 5)
        #expect(String(decoding: r.stdout, as: UTF8.self) == "before\nafter\n")
    }

    @Test func throwsWhenTheExecutableIsMissing() async {
        await #expect(throws: (any Error).self) {
            _ = try await runProcess(executable: "/nonexistent/kunj", arguments: [], cwd: nil,
                                     environment: [:], stdin: nil, timeout: 5)
        }
    }

    /// Blocking reads and waitUntilExit held three GCD threads per child: 50 children that wait
    /// needed 150 threads, past GCD's limit of 64, and finished in waves of about 21.
    @Test func manyConcurrentRunsFinishTogether() async throws {
        let start = Date()
        let outputs = try await withThrowingTaskGroup(of: String.self) { group in
            for i in 0..<50 {
                group.addTask {
                    let r = try await sh("sleep 1; echo \(i)")
                    return String(decoding: r.stdout, as: UTF8.self)
                }
            }
            var all: [String] = []
            for try await o in group { all.append(o) }
            return all
        }
        #expect(Set(outputs) == Set((0..<50).map { "\($0)\n" }))
        // a thread per pipe would run these in waves; a loaded machine still finishes well inside this
        #expect(Date().timeIntervalSince(start) < 6)
    }
}
