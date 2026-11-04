import Foundation

/// One `kunj lsp run <language> --branch <b>` child and JSON-RPC over its stdio: requests with
/// replies, notifications both ways, and the requests the server sends the client answered here
/// (configuration empty, edits and document opening refused). Documents opened through it are
/// remembered so a restart can replay them.
public final class LspConnection: @unchecked Sendable {
    public let key: LspKey
    /// The worktree, the server's root.
    public let root: String
    private let spec: SpawnSpec
    private let lock = NSLock()
    private var process: Process?
    private var stdin: FileHandle?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Any?, Error>] = [:]
    private var reader = LspFrameReader()
    private var initialized = false
    private var readyWaiters: [CheckedContinuation<Bool, Never>] = []
    /// The server's process id (for its memory), once started.
    public private(set) var pid: Int32 = 0

    /// A server notification (method, params), on a background thread.
    public var onNotification: (@Sendable (String, Any?) -> Void)?
    /// The child ended (stopped or crashed), with its exit status.
    public var onExit: (@Sendable (Int32) -> Void)?

    public struct LspError: Error, CustomStringConvertible {
        public let message: String
        public var description: String { message }
    }

    public init(key: LspKey, root: String, spec: SpawnSpec) {
        self.key = key
        self.root = root
        self.spec = spec
    }

    public var rootURI: String { URL(fileURLWithPath: root).absoluteString }

    /// Starts the child and runs `initialize`/`initialized`. Throws when it cannot start.
    public func start() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: spec.executable)
        p.arguments = spec.arguments
        p.currentDirectoryURL = URL(fileURLWithPath: spec.cwd)
        p.environment = spec.environment
        let out = Pipe(), input = Pipe()
        p.standardOutput = out
        p.standardInput = input
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in self?.ended(proc.terminationStatus) }
        try p.run()
        lock.lock()
        process = p
        stdin = input.fileHandleForWriting
        pid = p.processIdentifier
        lock.unlock()
        let handle = out.fileHandleForReading
        Thread.detachNewThread { [weak self] in
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                self?.received(chunk)
            }
        }
        Task { await self.handshake() }
    }

    /// True once `initialize` answered; false after `timeout` seconds or when the server ended.
    public func waitReady(timeout: TimeInterval) async -> Bool {
        if isReady { return true }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
                    self.lock.lock()
                    if self.initialized { self.lock.unlock(); c.resume(returning: true); return }
                    self.readyWaiters.append(c)
                    self.lock.unlock()
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            if !first { self.releaseWaiters(false) }
            return first
        }
    }

    public var isReady: Bool { locked { initialized } }

    private func locked<T>(_ f: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return f()
    }

    private func handshake() async {
        let params: [String: Any] = [
            "processId": Int(ProcessInfo.processInfo.processIdentifier),
            "rootUri": rootURI,
            "rootPath": root,
            "workspaceFolders": [["uri": rootURI, "name": (root as NSString).lastPathComponent]],
            "capabilities": [
                "general": ["positionEncodings": ["utf-16"]],
                "workspace": ["workspaceFolders": true, "configuration": true],
                "textDocument": [
                    "synchronization": ["didSave": false, "dynamicRegistration": false],
                    "definition": ["linkSupport": true],
                    "references": [:] as [String: Any],
                    "hover": ["contentFormat": ["markdown", "plaintext"]],
                    "publishDiagnostics": ["relatedInformation": false],
                ],
            ],
            "clientInfo": ["name": "Kunj Workspace"],
        ]
        do {
            _ = try await request("initialize", params, timeout: 120)
            notify("initialized", [:] as [String: Any])
            locked { initialized = true }
            releaseWaiters(true)
        } catch {
            NSLog("lsp %@: initialize failed: %@", key.description, String(describing: error))
            stop()
        }
    }

    private func releaseWaiters(_ value: Bool) {
        lock.lock()
        let waiters = readyWaiters
        readyWaiters = []
        lock.unlock()
        for w in waiters { w.resume(returning: value) }
    }

    /// Sends a request; the result (JSON) or an error. Times out after `timeout` seconds.
    public func request(_ method: String, _ params: Any, timeout: TimeInterval = 10) async throws -> Any? {
        let id: Int = locked { defer { nextId += 1 }; return nextId }
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<Any?, Error>) in
            lock.lock()
            pending[id] = c
            lock.unlock()
            write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.finish(id, .failure(LspError(message: "\(method) timed out")))
            }
        }
    }

    public func notify(_ method: String, _ params: Any) {
        write(["jsonrpc": "2.0", "method": method, "params": params])
    }

    /// `shutdown` + `exit`, then the child is killed if it is still there after 2 s.
    public func stop() {
        let p: Process? = locked { process }
        guard let p, p.isRunning else { return }
        Task {
            _ = try? await self.request("shutdown", NSNull(), timeout: 2)
            self.notify("exit", NSNull())
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if p.isRunning { p.terminate() }
        }
    }

    private func write(_ message: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: message) else { return }
        lock.lock()
        let h = stdin
        lock.unlock()
        do { try h?.write(contentsOf: lspFrame(body)) } catch { /* the child ended; onExit follows */ }
    }

    private func received(_ chunk: Data) {
        lock.lock()
        reader.append(chunk)
        var bodies: [Data] = []
        while let b = reader.next() { bodies.append(b) }
        lock.unlock()
        for body in bodies {
            guard let m = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { continue }
            handle(m)
        }
    }

    private func handle(_ m: [String: Any]) {
        let method = m["method"] as? String
        if let method, let id = m["id"] {
            // a request from the server
            write(["jsonrpc": "2.0", "id": id, "result": serverRequestResult(method, m["params"]) as Any])
            return
        }
        if let method {
            onNotification?(method, m["params"])
            return
        }
        guard let id = (m["id"] as? Int) ?? (m["id"] as? NSNumber)?.intValue else { return }
        if let error = m["error"] as? [String: Any] {
            finish(id, .failure(LspError(message: error["message"] as? String ?? "error")))
        } else {
            finish(id, .success(m["result"] is NSNull ? nil : m["result"]))
        }
    }

    /// What the client answers to the server's requests: nothing is ever edited or opened by the server.
    private func serverRequestResult(_ method: String, _ params: Any?) -> Any {
        switch method {
        case "workspace/configuration":
            let items = (params as? [String: Any])?["items"] as? [Any] ?? []
            return items.map { _ in NSNull() }
        case "workspace/workspaceFolders":
            return [["uri": rootURI, "name": (root as NSString).lastPathComponent]]
        case "workspace/applyEdit":
            return ["applied": false, "failureReason": "Kunj Workspace does not apply server edits"]
        case "window/showDocument":
            return ["success": false]
        default:
            return NSNull() // registerCapability, workDoneProgress/create, …
        }
    }

    private func finish(_ id: Int, _ result: Result<Any?, Error>) {
        lock.lock()
        let c = pending.removeValue(forKey: id)
        lock.unlock()
        c?.resume(with: result)
    }

    private func ended(_ status: Int32) {
        lock.lock()
        let waiting = pending
        pending = [:]
        initialized = false
        process = nil
        stdin = nil
        lock.unlock()
        for c in waiting.values { c.resume(throwing: LspError(message: "the language server ended")) }
        releaseWaiters(false)
        onExit?(status)
    }
}
