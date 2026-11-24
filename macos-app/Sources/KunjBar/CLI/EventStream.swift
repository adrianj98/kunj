// The one long-lived `kunj events --json` child, so container, agent, forward and git changes
// show at once instead of on the next timer tick. Its stdin is held open (kunj events exits when
// stdin ends, so the child dies with the app). An exited child is started again after a delay
// that doubles from 2 s to 60 s, back to 2 s once a child has lived longer than that; a kunj
// without `events` therefore costs one short-lived process a minute. It watches the roots given
// to `watch(roots:)` (`--repo`), and is restarted only when that set changes. The store runs it
// only while the panel is open (RefreshPolicy).

import Foundation
import KunjBarCore

final class EventStream: @unchecked Sendable {
    private let cli: KunjCLI
    // Each line with whether its stream replaced an earlier one; called on a background thread
    private let onLine: @Sendable (String, Bool) -> Void
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "kunj.events")
    private static let backoff: ClosedRange<TimeInterval> = 2...60

    private var started = false
    private var generation = 0
    private var runs = 0
    private var process: Process?
    private var stdinPipe: Pipe?
    private var delay = EventStream.backoff.lowerBound
    // The repositories the next child watches (empty: every known visible one)
    private var roots: Set<String> = []

    init(cli: KunjCLI, onLine: @escaping @Sendable (String, Bool) -> Void) {
        self.cli = cli
        self.onLine = onLine
    }

    func start() {
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        generation += 1
        let gen = generation
        lock.unlock()
        queue.async { self.launch(generation: gen) }
    }

    // The repositories to watch; a running child is restarted only when the set differs
    func watch(roots newRoots: Set<String>) {
        lock.lock()
        guard newRoots != roots else { lock.unlock(); return }
        roots = newRoots
        lock.unlock()
        restart()
    }

    // Ends the running child so a new one starts (with the repositories known now)
    func restart() {
        lock.lock()
        guard started, let child = process else { lock.unlock(); return }
        delay = Self.backoff.lowerBound
        let input = stdinPipe
        stdinPipe = nil
        lock.unlock()
        try? input?.fileHandleForWriting.close()
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let stuck = self.process === child && child.isRunning
            self.lock.unlock()
            if stuck { kill(child.processIdentifier, SIGTERM) }
        }
    }

    // Stops restarting and ends the child (closing its stdin is enough for kunj events)
    func stop() {
        lock.lock()
        started = false
        generation += 1
        let input = stdinPipe
        process = nil
        stdinPipe = nil
        lock.unlock()
        try? input?.fileHandleForWriting.close()
    }

    private func launch(generation gen: Int) {
        lock.lock()
        let watched = roots
        lock.unlock()
        let (executable, arguments, environment) = cli.spawnSpec(eventStreamArguments(roots: watched))
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        p.environment = environment
        let out = Pipe()
        let input = Pipe()
        p.standardOutput = out
        p.standardInput = input
        p.standardError = FileHandle.nullDevice
        let launchedAt = Date()
        p.terminationHandler = { [weak self] _ in self?.exited(generation: gen, launchedAt: launchedAt) }

        lock.lock()
        guard started, generation == gen else { lock.unlock(); return }
        do {
            try p.run()
        } catch {
            lock.unlock()
            cli.log("kunj events could not start: \(error.localizedDescription)")
            exited(generation: gen, launchedAt: launchedAt)
            return
        }
        process = p
        stdinPipe = input
        let afterRestart = runs > 0
        runs += 1
        // The set changed while this child was being launched
        let stale = watched != roots
        lock.unlock()
        if stale { restart() }
        cli.log("kunj events --json (live refresh, \(watched.isEmpty ? "every repository" : "\(watched.count) repositories"))")

        let reader = out.fileHandleForReading
        let deliver = onLine
        Thread.detachNewThread {
            var buffer = Data()
            while true {
                let chunk = reader.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                    buffer.removeSubrange(buffer.startIndex...nl)
                    deliver(line, afterRestart)
                }
            }
        }
    }

    private func exited(generation gen: Int, launchedAt: Date) {
        lock.lock()
        guard started, generation == gen else { lock.unlock(); return }
        process = nil
        stdinPipe = nil
        if Date().timeIntervalSince(launchedAt) > Self.backoff.upperBound { delay = Self.backoff.lowerBound }
        let wait = delay
        delay = min(delay * 2, Self.backoff.upperBound)
        lock.unlock()
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = self.started && self.generation == gen
            self.lock.unlock()
            if current { self.launch(generation: gen) }
        }
    }
}
