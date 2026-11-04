import Foundation

/// `kunj lsp list --json` (`LspListJson`).
public struct LspListJson: Decodable, Equatable, Sendable {
    public struct Server: Decodable, Equatable, Sendable {
        public var language: String
        public var command: [String]
        public var extensions: [String]
        public var restart: String
        public var cachePaths: [String]
        public var installed: Bool
        public var path: String?
        public var install: String?
    }
    public struct Idle: Decodable, Equatable, Sendable {
        public var cached: Double
        public var cold: Double
    }
    public var servers: [Server]
    public var idleStopMinutes: Idle
    public var closedStopMinutes: Double
    public var maxServers: Int
    public var readyTimeoutMs: Double

    public init(servers: [Server], idleStopMinutes: Idle, closedStopMinutes: Double, maxServers: Int, readyTimeoutMs: Double) {
        self.servers = servers
        self.idleStopMinutes = idleStopMinutes
        self.closedStopMinutes = closedStopMinutes
        self.maxServers = maxServers
        self.readyTimeoutMs = readyTimeoutMs
    }

    /// The installed server for a file, by its extension.
    public func server(forPath path: String) -> Server? {
        let ext = (path as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return nil }
        return servers.first { $0.installed && $0.extensions.contains(ext) }
    }
}

/// A language server is one per environment and language.
public struct LspKey: Hashable, Sendable, CustomStringConvertible {
    public var envId: String
    public var language: String
    public init(envId: String, language: String) {
        self.envId = envId
        self.language = language
    }
    public var description: String { "\(language) in \(envId)" }
}

/// When servers start and stop (docs/specs/language-servers.md, the lifecycle table). Pure: the
/// caller starts and stops processes from what these return, and passes the time in.
public struct LspPolicy: Sendable {
    public struct Entry: Equatable, Sendable {
        public var cached: Bool
        public var running: Bool
        public var openTabs: Int
        public var lastUsed: Date
        /// When the last tab of the language closed (nil while tabs are open).
        public var closedAt: Date?
    }

    public var config: LspListJson
    public private(set) var entries: [LspKey: Entry] = [:]

    public init(config: LspListJson) { self.config = config }

    /// A tab of the language opened. Returns the servers to stop to make room when this one should
    /// start (it is then marked running), or nil when it runs already.
    public mutating func tabOpened(_ key: LspKey, cached: Bool, now: Date) -> [LspKey]? {
        var e = entries[key] ?? Entry(cached: cached, running: false, openTabs: 0, lastUsed: now, closedAt: nil)
        e.openTabs += 1
        e.closedAt = nil
        e.lastUsed = now
        entries[key] = e
        return e.running ? nil : start(key, now: now)
    }

    public mutating func tabClosed(_ key: LspKey, now: Date) {
        guard var e = entries[key] else { return }
        e.openTabs = max(0, e.openTabs - 1)
        if e.openTabs == 0 { e.closedAt = now }
        entries[key] = e
    }

    /// A request is going to the server. Returns the servers to stop when it must start again
    /// (it is then marked running), or nil when it runs.
    public mutating func used(_ key: LspKey, now: Date) -> [LspKey]? {
        guard var e = entries[key] else { return nil }
        e.lastUsed = now
        entries[key] = e
        return e.running ? nil : start(key, now: now)
    }

    /// The server ended (stopped, or exited by itself).
    public mutating func stopped(_ key: LspKey) {
        guard var e = entries[key] else { return }
        e.running = false
        if e.openTabs == 0 { entries[key] = nil } else { entries[key] = e }
    }

    /// The running servers that should stop now: closed long enough, or idle long enough.
    public func due(now: Date) -> [LspKey] {
        entries.compactMap { key, e in
            guard e.running else { return nil }
            if let closed = e.closedAt, now.timeIntervalSince(closed) >= config.closedStopMinutes * 60 { return key }
            let idle = (e.cached ? config.idleStopMinutes.cached : config.idleStopMinutes.cold) * 60
            return now.timeIntervalSince(e.lastUsed) >= idle ? key : nil
        }.sorted { $0.description < $1.description }
    }

    public var running: [LspKey] { entries.filter { $0.value.running }.map(\.key).sorted { $0.description < $1.description } }

    private mutating func start(_ key: LspKey, now: Date) -> [LspKey] {
        var evict: [LspKey] = []
        var others = entries.filter { $0.key != key && $0.value.running }
        while others.count + 1 > max(1, config.maxServers), !others.isEmpty {
            // a cached server first (it restarts cheaply), then the least recently used
            let victim = others.min { a, b in
                if a.value.cached != b.value.cached { return a.value.cached }
                return a.value.lastUsed < b.value.lastUsed
            }!.key
            evict.append(victim)
            others[victim] = nil
        }
        entries[key]?.running = true
        return evict
    }
}
