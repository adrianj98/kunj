import Foundation

/// One line of `kunj events --json` (`EventJson` in src/lib/json-types.ts), reduced to what the
/// store needs to choose a refresh. `registry` is `sessions`, `forwards` or `repos`; `error` is
/// kunj's `--json` error document (the stream then exits and is restarted).
public enum KunjEvent: Equatable, Sendable {
    case hello(version: String, repos: Int)
    case git(repoRoot: String?)
    case registry(kind: String, repoRoot: String?)
    case container(repoRoot: String?, branch: String?, container: String, action: String)
    case agent(session: String, running: Bool, state: String?, repoRoot: String?)
    case backend(available: Bool, message: String?)
    case error(code: String?, message: String)
}

/// Parses one NDJSON line; nil for a malformed line or a type this build does not know.
public func parseEventLine(_ line: String) -> KunjEvent? {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let error = object["error"] {
        if let message = error as? String { return .error(code: nil, message: message) }
        if let e = error as? [String: Any], let message = e["message"] as? String {
            return .error(code: e["code"] as? String, message: message)
        }
        return nil
    }
    let root = (object["repo"] as? [String: Any])?["root"] as? String
    switch object["type"] as? String {
    case "hello":
        guard let version = object["version"] as? String, let repos = object["repos"] as? Int else { return nil }
        return .hello(version: version, repos: repos)
    case "git":
        return .git(repoRoot: root)
    case let kind? where kind == "sessions" || kind == "forwards" || kind == "repos":
        return .registry(kind: kind, repoRoot: root)
    case "container":
        guard let container = object["container"] as? String, let action = object["action"] as? String else { return nil }
        return .container(repoRoot: root, branch: object["branch"] as? String, container: container, action: action)
    case "agent":
        guard let session = object["session"] as? String, let running = object["running"] as? Bool else { return nil }
        return .agent(session: session, running: running, state: object["state"] as? String, repoRoot: root)
    case "backend":
        guard let status = object["status"] as? String else { return nil }
        return .backend(available: status == "available", message: object["message"] as? String)
    default:
        return nil
    }
}

/// The one long-lived `kunj events --json` child. Its stdin is held open (kunj events exits when
/// stdin ends, so the child dies with the app); lines are parsed on a background thread and
/// handed to `onEvent` there. While started, an exited child is restarted after a delay that
/// doubles from `backoff.lowerBound` to `backoff.upperBound`, back to the lower bound once a child
/// has lived longer than the upper bound. The receiver should do a full refresh on a `hello`
/// after a restart, because events from the gap are lost.
public final class EventStream: @unchecked Sendable {
    private let cli: KunjCLI
    private let onEvent: @Sendable (KunjEvent) -> Void
    private let backoff: ClosedRange<TimeInterval>
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "kunj.events")

    private var started = false
    private var generation = 0
    private var process: Process?
    private var stdinPipe: Pipe?
    private var delay: TimeInterval
    private var _restarts = 0

    public init(cli: KunjCLI, onEvent: @escaping @Sendable (KunjEvent) -> Void,
                backoff: ClosedRange<TimeInterval> = 1...30) {
        self.cli = cli
        self.onEvent = onEvent
        self.backoff = backoff
        self.delay = backoff.lowerBound
    }

    /// How many times the child has been started again after exiting.
    public private(set) var restarts: Int {
        get { lock.lock(); defer { lock.unlock() }; return _restarts }
        set { lock.lock(); _restarts = newValue; lock.unlock() }
    }

    /// The running child's pid, nil between runs and after `stop()`.
    public var pid: Int32? {
        lock.lock(); defer { lock.unlock() }
        guard let p = process, p.isRunning else { return nil }
        return p.processIdentifier
    }

    public func start() {
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        generation += 1
        delay = backoff.lowerBound
        let gen = generation
        lock.unlock()
        queue.async { self.launch(generation: gen) }
    }

    /// Stops restarting, closes the child's stdin and waits up to 2 s for it to exit, then sends
    /// SIGTERM (and SIGKILL a second later).
    public func stop() async {
        let (child, input) = detach()
        guard let child else { return }
        try? input?.fileHandleForWriting.close()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                if !Self.wait(child, seconds: 2) {
                    kill(child.processIdentifier, SIGTERM)
                    if !Self.wait(child, seconds: 1) { kill(child.processIdentifier, SIGKILL); _ = Self.wait(child, seconds: 1) }
                }
                done.resume()
            }
        }
    }

    /// Ends the running child so a new one starts after `backoff.lowerBound` (counted in
    /// `restarts`): `kunj events` resolves its repositories once, at start. Closes its stdin, and
    /// sends SIGTERM if it is still running 2 s later. Does nothing when not started or between runs.
    public func restart() {
        lock.lock()
        guard started, let child = process else { lock.unlock(); return }
        delay = backoff.lowerBound
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

    /// Ends this run (no restart) and hands back its child and stdin.
    private func detach() -> (Process?, Pipe?) {
        lock.lock(); defer { lock.unlock() }
        started = false
        generation += 1
        let child = process
        let input = stdinPipe
        process = nil
        stdinPipe = nil
        return (child, input)
    }

    private static func wait(_ p: Process, seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while p.isRunning && Date() < deadline { usleep(10_000) }
        return !p.isRunning
    }

    private func launch(generation gen: Int) {
        let spec = cli.spawnSpec(["events", "--json"], cwd: NSHomeDirectory())
        let p = Process()
        p.executableURL = URL(fileURLWithPath: spec.executable)
        p.arguments = spec.arguments
        p.currentDirectoryURL = URL(fileURLWithPath: spec.cwd)
        p.environment = spec.environment
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
            NSLog("kunj events could not start: %@", error.localizedDescription)
            exited(generation: gen, launchedAt: launchedAt)
            return
        }
        process = p
        stdinPipe = input
        lock.unlock()

        let reader = out.fileHandleForReading
        let deliver = onEvent
        Thread.detachNewThread {
            var buffer = Data()
            while true {
                let chunk = reader.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
                    buffer.removeSubrange(buffer.startIndex...nl)
                    if let event = parseEventLine(line) { deliver(event) }
                }
            }
            if let event = parseEventLine(String(decoding: buffer, as: UTF8.self)) { deliver(event) }
        }
    }

    private func exited(generation gen: Int, launchedAt: Date) {
        lock.lock()
        guard started, generation == gen else { lock.unlock(); return }
        process = nil
        stdinPipe = nil
        if Date().timeIntervalSince(launchedAt) > backoff.upperBound { delay = backoff.lowerBound }
        let wait = delay
        delay = min(delay * 2, backoff.upperBound)
        lock.unlock()
        queue.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = self.started && self.generation == gen
            if current { self._restarts += 1 }
            self.lock.unlock()
            if current { self.launch(generation: gen) }
        }
    }
}
